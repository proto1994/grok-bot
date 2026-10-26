/**
 * Assembles a macOS .app from the Electron already in node_modules, then makes
 * a DMG from it.
 *
 * electron-builder is the usual tool, but its downloader insists on fetching
 * the Electron zip from GitHub and fails here regardless of what is cached.
 * This does the same few things directly: copy the framework, drop our files
 * into Resources/app, rewrite Info.plist, and call hdiutil.
 *
 * The result is unsigned. macOS will warn on first open until it is signed and
 * notarised with an Apple Developer ID — see the notes printed at the end.
 *
 *   pnpm dmg
 */
import { cp, mkdir, readFile, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

const NAME = 'Bots';
const APP_ID = 'dev.local.grokbotlite';
const VERSION = pkg.version ?? '0.1.0';

const release = path.join(root, 'release');
const appDir = path.join(release, `${NAME}.app`);
/**
 * Electron's own bundle, found through the module rather than a pinned path.
 *
 * The version matters: node:sqlite is what the store runs on, and it only
 * exists from Node 22, which means Electron 37 or newer. Electron 33 bundles
 * Node 20 and the packaged app dies on its first query.
 */
const electronApp = path.join(
  path.dirname(createRequire(import.meta.url).resolve('electron')),
  'dist/Electron.app',
);

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} → exit ${r.status}`);
};

console.log('building the orchestrator');
run('node', ['scripts/build.mjs'], { cwd: root });

console.log(`\nassembling ${NAME}.app`);
await rm(release, { recursive: true, force: true });
await mkdir(release, { recursive: true });

// ditto, not cp: a framework's internal links are relative
// (Resources -> Versions/Current/Resources), and node's cp rewrites them as
// absolute paths back into node_modules. The bundle then runs here and nowhere
// else — icudtl.dat goes missing on any other machine.
run('ditto', [electronApp, appDir]);

const contents = path.join(appDir, 'Contents');
const resources = path.join(contents, 'Resources');

// Rename the executable so the process and the menu bar say Bots, not Electron.
await cp(path.join(contents, 'MacOS/Electron'), path.join(contents, `MacOS/${NAME}`));
await rm(path.join(contents, 'MacOS/Electron'));

console.log('writing Info.plist');
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>${NAME}</string>
  <key>CFBundleName</key><string>${NAME}</string>
  <key>CFBundleDisplayName</key><string>${NAME}</string>
  <key>CFBundleIdentifier</key><string>${APP_ID}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>electron.icns</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <!-- The orchestrator reaches the model gateway and listens on 127.0.0.1. -->
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
    <!-- The internal gateway is plain http. -->
    <key>NSAllowsArbitraryLoads</key><true/>
  </dict>
</dict>
</plist>
`;
await writeFile(path.join(contents, 'Info.plist'), plist);

console.log('copying the app');
const appRoot = path.join(resources, 'app');
await mkdir(appRoot, { recursive: true });

// Only what runs: the compiled orchestrator, the shell, and the manifest.
await cp(path.join(root, 'dist'), path.join(appRoot, 'dist'), { recursive: true });
await cp(path.join(root, 'desktop'), path.join(appRoot, 'desktop'), { recursive: true });
await writeFile(
  path.join(appRoot, 'package.json'),
  JSON.stringify({
    name: pkg.name, version: VERSION, main: 'desktop/main.cjs', type: 'module',
    dependencies: pkg.dependencies,
  }, null, 2),
);

console.log('installing runtime dependencies');
/*
 * npm install, not a copy.
 *
 * pnpm's node_modules is a tree of symlinks into a global store, and the pi SDK
 * has 19 direct dependencies with their own trees beneath them. Copying the
 * top-level packages produced a bundle that opened a window and then failed on
 * a transitive import. Letting npm resolve the tree in place is the only way to
 * get a complete, self-contained node_modules.
 */
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--silent'], { cwd: appRoot });

const measure = async (dir) => {
  let bytes = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) bytes += await measure(p);
    else if (e.isFile()) bytes += (await stat(p)).size;
  }
  return bytes;
};
console.log(`  app payload: ${((await measure(appRoot)) / 1e6).toFixed(0)} MB`);

console.log('\nmaking the dmg');
const dmg = path.join(release, `${NAME}-${VERSION}-arm64.dmg`);
const staging = path.join(release, 'dmg-staging');
await mkdir(staging, { recursive: true });
run('ditto', [appDir, path.join(staging, `${NAME}.app`)]);
run('ln', ['-s', '/Applications', path.join(staging, 'Applications')]);
run('hdiutil', [
  'create', '-volname', NAME, '-srcfolder', staging,
  '-ov', '-format', 'UDZO', '-quiet', dmg,
]);
await rm(staging, { recursive: true, force: true });

const dmgSize = ((await stat(dmg)).size / 1e6).toFixed(0);
console.log(`\n${path.relative(root, dmg)}  (${dmgSize} MB)`);
console.log(`${path.relative(root, appDir)}`);

console.log(`
This build is unsigned. To open it, right-click the app and choose Open, or:
  xattr -dr com.apple.quarantine "/Applications/${NAME}.app"

To ship it to anyone else it needs signing and notarisation, which require an
Apple Developer ID ($99/year) that is not present here:

  codesign --deep --force --options runtime --timestamp \\
    --entitlements desktop/resources/entitlements.mac.plist \\
    --sign "Developer ID Application: <your name> (<team id>)" \\
    "release/${NAME}.app"

  xcrun notarytool submit "release/${NAME}-${VERSION}-arm64.dmg" \\
    --apple-id <your apple id> --team-id <team id> \\
    --password <app-specific password> --wait

  xcrun stapler staple "release/${NAME}-${VERSION}-arm64.dmg"

The Mac App Store is not a route: the orchestrator spawns shell commands and
talks to the docker daemon, which App Sandbox forbids.
`);
