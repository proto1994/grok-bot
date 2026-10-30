/**
 * macOS shell around the orchestrator.
 *
 * The window is a thin client: it loads the same UI the browser does. What this
 * process adds is the three things a browser tab cannot do —
 *
 *   1. start and supervise the orchestrator, on a port nobody else is using
 *   2. put approval requests in front of someone who is not looking at the app
 *   3. keep working while the window is closed
 *
 * No business logic belongs here. If something would also be true of the web
 * UI, it goes in the server instead.
 */
const { app, BrowserWindow, Notification, Tray, Menu, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

// Electron derives userData from package.json's `name`, which is the npm
// package name, not the product name. Set it explicitly so state lands in a
// directory called after the app and the path is predictable.
app.setName('Bots');

const isDev = !app.isPackaged;

/** Where the app's own files live (read-only once installed). */
const ROOT = isDev ? path.join(__dirname, '..') : path.join(process.resourcesPath, 'app');

/**
 * Where mutable state lives.
 *
 * An installed .app is read-only, so the database, the auth token, and the
 * sandbox workspaces cannot sit next to the code.
 *
 * In dev this is the repo's data/ directory — the same one `pnpm dev` uses.
 * Pointing it at the repo root instead gave the app its own ./app.db, so the
 * desktop window and the browser showed different bots and neither was wrong.
 */
const DATA = isDev ? path.join(ROOT, 'data') : app.getPath('userData');

let server = null;
let win = null;
let tray = null;
let base = null;
let token = null;
let quitting = false;
const serverLog = [];

/** A free port, so two copies of the app never collide. */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/**
 * Where the credentials file lives.
 *
 * Deliberately not DATA. In dev the state directory is the repo's data/, but
 * .env sits at the repo root where `pnpm dev` reads it — deriving both from one
 * constant made the app look in data/.env and refuse to start over a file that
 * was there all along. A packaged app has no repo, so both are userData.
 */
function envPath() {
  return isDev ? path.join(ROOT, '.env') : path.join(DATA, '.env');
}

function readEnvFile() {
  const out = {};
  const p = envPath();
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

async function startServer() {
  const port = await freePort();
  fs.mkdirSync(DATA, { recursive: true });

  const env = {
    ...process.env,
    ...readEnvFile(),
    PORT: String(port),
    HOST: '127.0.0.1',
    // Keep every writable thing out of the bundle.
    DB_PATH: path.join(DATA, 'app.db'),
    LOCAL_SANDBOX_ROOT: path.join(DATA, 'workspaces'),
    AUTH_ENV_FILE: envPath(),
    MCP_CONFIG: path.join(DATA, 'mcp.json'),
    SANDBOX_CONFIG: path.join(DATA, 'sandboxes.json'),
  };

  // No credential check here. Model providers are configured in the app and
  // stored in sqlite; ADA_TOKEN and the rest of .env are only a first-run seed
  // for a database that has no provider yet. This used to refuse to start
  // without ADA_TOKEN, which left anyone who had set up DeepSeek in the UI
  // unable to open the app at all. A server with no provider starts fine and
  // says so — the models sheet is where that gets fixed, and the first run that
  // needs a model fails with a message pointing at it.

  // The server only prints the token on the run that mints it, so take it from
  // the file when it is already there. Without this the approval notifications
  // silently stop working.
  token = env.AUTH_TOKEN || null;

  // In production the orchestrator runs on Electron's own Node, via
  // ELECTRON_RUN_AS_NODE — no second runtime to ship. In dev it goes through
  // tsx so the TypeScript sources run directly.
  const bin = isDev ? 'pnpm' : process.execPath;
  const args = isDev
    ? ['tsx', 'src/server/index.ts']
    : [path.join(ROOT, 'dist', 'server', 'index.js')];

  const child = spawn(bin, args, {
    cwd: ROOT,
    env: isDev ? env : { ...env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => capture(String(d)));
  child.stderr.on('data', (d) => capture(String(d)));
  child.on('exit', (code) => {
    if (quitting) return;
    dialog.showErrorBox('服务停止了', `orchestrator 退出（code ${code}）。\n\n最后几行日志：\n${serverLog.slice(-8).join('')}`);
  });

  base = `http://127.0.0.1:${port}`;
  return child;
}

function capture(text) {
  serverLog.push(text);
  if (serverLog.length > 300) serverLog.shift();
  // The server mints the token on first run; pick it up rather than guess.
  const m = /AUTH_TOKEN=([A-Za-z0-9_-]+)/.exec(text);
  if (m) token = m[1];
  process.stdout.write(text);
}

/** Re-reads .env once the server has had a chance to write a fresh token. */
function refreshToken() {
  if (token) return;
  token = readEnvFile().AUTH_TOKEN || null;
}

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    refreshToken();
    try {
      const r = await fetch(`${base}/api/bots`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (r.ok || r.status === 401) return true;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#17181b',
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  win.once('ready-to-show', () => win.show());
  win.loadURL(base);

  // Tells the page it is in the desktop shell, so it can leave room for the
  // traffic lights and mark a drag strip. A browser tab needs neither.
  win.webContents.on('dom-ready', () => {
    win.webContents.executeJavaScript(`document.body.dataset.desktop = '1';`).catch(() => {});
  });

  // Links to anywhere else open in the real browser, not in this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(base)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Closing the window leaves the agent running; that is the point of the app.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
}

function showWindow() {
  if (!win) createWindow();
  else {
    win.show();
    win.focus();
  }
}

/**
 * Native notifications for approvals.
 *
 * Polling rather than a websocket: this process would otherwise need to
 * re-implement auth and reconnection for a channel the renderer already has.
 * A second of latency on a prompt that waits indefinitely costs nothing.
 */
const announced = new Set();
async function watchApprovals() {
  if (!token) return;
  try {
    const r = await fetch(`${base}/api/approvals`, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) return;
    const open = await r.json();

    for (const a of open) {
      if (announced.has(a.id)) continue;
      announced.add(a.id);
      if (win?.isVisible() && win.isFocused()) continue; // they are already looking

      const n = new Notification({
        title: '需要你批准',
        body: `${a.tool}：${a.reason}`.slice(0, 180),
        silent: false,
      });
      n.on('click', showWindow);
      n.show();
    }

    // Forget resolved ones so a later request for the same tool notifies again.
    const stillOpen = new Set(open.map((a) => a.id));
    for (const id of announced) if (!stillOpen.has(id)) announced.delete(id);

    if (tray) {
      tray.setTitle(open.length ? `${open.length}` : '');
      tray.setToolTip(open.length ? `${open.length} 个待批准` : 'Bots');
    }
  } catch { /* server restarting */ }
}

function createTray() {
  // A template image renders correctly in both light and dark menu bars.
  const { nativeImage } = require('electron');
  const dot = nativeImage.createFromDataURL(
    'data:image/svg+xml;base64,' + Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">' +
      '<circle cx="8" cy="8" r="5" fill="black"/></svg>',
    ).toString('base64'),
  );
  dot.setTemplateImage(true);

  tray = new Tray(dot);
  tray.setToolTip('Bots');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开', click: showWindow },
    { type: 'separator' },
    { label: '在浏览器里打开', click: () => shell.openExternal(base) },
    { label: '显示服务日志', click: () => {
      dialog.showMessageBox({ message: 'orchestrator 日志', detail: serverLog.slice(-25).join('') || '(空)' });
    } },
    { type: 'separator' },
    { label: '退出（会停止所有 Bot）', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

app.whenReady().then(async () => {
  server = await startServer();
  if (!server) return;

  if (!(await waitForServer())) {
    dialog.showErrorBox('启动失败', `orchestrator 没有在 60 秒内就绪。\n\n日志：\n${serverLog.slice(-10).join('')}`);
    app.quit();
    return;
  }

  createWindow();
  createTray();
  setInterval(watchApprovals, 1000);

  app.on('activate', showWindow);
});

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { /* stay alive: work continues in the background */ });
app.on('will-quit', () => { server?.kill('SIGTERM'); });
