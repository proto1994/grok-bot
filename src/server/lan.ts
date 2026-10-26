import { networkInterfaces } from 'node:os';

/**
 * Reaching the orchestrator from a phone.
 *
 * Binding off 127.0.0.1 changes the threat model: the port becomes reachable by
 * anything on the network, and the bearer token stops being a convenience and
 * becomes the only thing in the way. A bot in 'full' mode runs commands on this
 * machine, so that matters more here than it does on loopback.
 *
 * For that reason this is opt-in (HOST=0.0.0.0 or BIND=lan) rather than a
 * default, and the server says plainly what it has exposed.
 */

export interface LanAddress {
  iface: string;
  address: string;
}

/** IPv4 addresses on real interfaces, loopback excluded. */
export function lanAddresses(): LanAddress[] {
  const out: LanAddress[] = [];
  for (const [iface, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      // Link-local addresses are not useful for pairing.
      if (a.address.startsWith('169.254.')) continue;
      out.push({ iface, address: a.address });
    }
  }
  // Prefer wifi/ethernet over virtual interfaces (docker, vpn, utun).
  const rank = (n: string) => (/^(en|eth|wl)/.test(n) ? 0 : /^(bridge|utun|tun|tap|docker|vbox)/.test(n) ? 2 : 1);
  return out.sort((a, b) => rank(a.iface) - rank(b.iface));
}

export function isLoopbackOnly(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * Renders a QR code as text, so a phone can pick up a long URL with a token
 * without anyone typing it.
 *
 * A minimal QR encoder: byte mode, fixed version chosen by length, which is all
 * a pairing URL needs. Written out rather than taking a dependency for one use.
 */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] = next[j]! ^ gfMul(poly[j]!, 1);
      next[j + 1] = next[j + 1]! ^ gfMul(poly[j]!, GF_EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data: number[], ecLen: number): number[] {
  const gen = rsGenerator(ecLen);
  const res = new Array<number>(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0]!;
    res.shift();
    res.push(0);
    for (let i = 0; i < ecLen; i++) res[i] = res[i]! ^ gfMul(gen[i + 1]!, factor);
  }
  return res;
}

/** Version, total codewords, ec codewords per block, block count — level L. */
const VERSIONS: { v: number; total: number; ecPerBlock: number; blocks: number }[] = [
  { v: 3, total: 70, ecPerBlock: 15, blocks: 1 },
  { v: 4, total: 100, ecPerBlock: 20, blocks: 1 },
  { v: 5, total: 134, ecPerBlock: 26, blocks: 1 },
  { v: 6, total: 172, ecPerBlock: 18, blocks: 2 },
  { v: 7, total: 196, ecPerBlock: 20, blocks: 2 },
  { v: 8, total: 242, ecPerBlock: 24, blocks: 2 },
  { v: 9, total: 292, ecPerBlock: 30, blocks: 2 },
  { v: 10, total: 346, ecPerBlock: 18, blocks: 4 },
];

export function qrMatrix(text: string): boolean[][] | null {
  const bytes = [...Buffer.from(text, 'utf8')];
  const spec = VERSIONS.find((s) => {
    const dataCodewords = s.total - s.ecPerBlock * s.blocks;
    return bytes.length + 2 + 2 <= dataCodewords; // mode + length + terminator
  });
  if (!spec) return null;

  const size = 17 + spec.v * 4;
  const dataCodewords = spec.total - spec.ecPerBlock * spec.blocks;

  // Bit stream: mode 0100 (byte), 16-bit length for v10+, else 8-bit.
  const bits: number[] = [];
  const push = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, spec.v >= 10 ? 16 : 8);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, dataCodewords * 8 - bits.length));
  while (bits.length % 8) bits.push(0);

  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((n, b) => (n << 1) | b, 0));
  }
  const pad = [0xec, 0x11];
  let p = 0;
  while (data.length < dataCodewords) data.push(pad[p++ % 2]!);

  // Split into blocks, encode each, interleave.
  const perBlock = Math.floor(dataCodewords / spec.blocks);
  const blocks: number[][] = [];
  const ecBlocks: number[][] = [];
  for (let i = 0; i < spec.blocks; i++) {
    const start = i * perBlock;
    const chunk = data.slice(start, i === spec.blocks - 1 ? dataCodewords : start + perBlock);
    blocks.push(chunk);
    ecBlocks.push(rsEncode(chunk, spec.ecPerBlock));
  }

  const final: number[] = [];
  for (let i = 0; i < Math.max(...blocks.map((b) => b.length)); i++) {
    for (const b of blocks) if (i < b.length) final.push(b[i]!);
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const b of ecBlocks) final.push(b[i]!);
  }

  return placeModules(size, spec.v, final);
}

function placeModules(size: number, version: number, codewords: number[]): boolean[][] {
  const m: (boolean | null)[][] = Array.from({ length: size }, () => new Array(size).fill(null));

  const finder = (r: number, c: number) => {
    for (let i = -1; i <= 7; i++) {
      for (let j = -1; j <= 7; j++) {
        const y = r + i;
        const x = c + j;
        if (y < 0 || y >= size || x < 0 || x >= size) continue;
        const edge = i === -1 || i === 7 || j === -1 || j === 7;
        const ring = i === 0 || i === 6 || j === 0 || j === 6;
        const core = i >= 2 && i <= 4 && j >= 2 && j <= 4;
        m[y]![x] = edge ? false : ring || core;
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    m[6]![i] = i % 2 === 0;
    m[i]![6] = i % 2 === 0;
  }


  // Alignment pattern (single, for versions 2..6; larger versions need more,
  // which these URL lengths do not reach).
  if (version >= 2 && version <= 6) {
    const pos = size - 7;
    for (let i = -2; i <= 2; i++) {
      for (let j = -2; j <= 2; j++) {
        m[pos + i]![pos + j] = Math.max(Math.abs(i), Math.abs(j)) !== 1;
      }
    }
  }

  m[size - 8]![8] = true; // dark module

  // Reserve format areas.
  for (let i = 0; i < 9; i++) {
    if (m[8]![i] === null) m[8]![i] = false;
    if (m[i]![8] === null) m[i]![8] = false;
  }
  for (let i = size - 8; i < size; i++) {
    if (m[8]![i] === null) m[8]![i] = false;
    if (m[i]![8] === null) m[i]![8] = false;
  }

  // Data, upward/downward in two-column strips, mask 0.
  const bitstream: number[] = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bitstream.push((cw >> i) & 1);

  let bit = 0;
  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let n = 0; n < size; n++) {
      const row = up ? size - 1 - n : n;
      for (const c of [col, col - 1]) {
        if (m[row]![c] !== null) continue;
        const v = bit < bitstream.length ? bitstream[bit++]! : 0;
        // Mask 0: (row + col) % 2 === 0 inverts.
        m[row]![c] = ((row + c) % 2 === 0 ? v ^ 1 : v) === 1;
      }
    }
    up = !up;
  }

  // Format info for level L, mask 0.
  const FORMAT = 0b111011111000100;
  const fbits = [...Array(15)].map((_, i) => ((FORMAT >> (14 - i)) & 1) === 1);
  const place = (r: number, c: number, v: boolean) => { m[r]![c] = v; };
  for (let i = 0; i <= 5; i++) place(8, i, fbits[i]!);
  place(8, 7, fbits[6]!);
  place(8, 8, fbits[7]!);
  place(7, 8, fbits[8]!);
  for (let i = 9; i < 15; i++) place(14 - i, 8, fbits[i]!);
  for (let i = 0; i < 8; i++) place(size - 1 - i, 8, fbits[i]!);
  for (let i = 8; i < 15; i++) place(8, size - 15 + i, fbits[i]!);

  return m.map((row) => row.map((v) => v === true));
}

/** Two rows per line of text, so the code stays square in a terminal. */
export function qrToText(text: string): string | null {
  const m = qrMatrix(text);
  if (!m) return null;
  const size = m.length;
  const quiet = 2;
  const at = (r: number, c: number) =>
    r >= 0 && r < size && c >= 0 && c < size ? m[r]![c]! : false;

  const lines: string[] = [];
  for (let r = -quiet; r < size + quiet; r += 2) {
    let line = '';
    for (let c = -quiet; c < size + quiet; c++) {
      const top = at(r, c);
      const bottom = at(r + 1, c);
      // Dark modules render as blanks: terminals are light-on-dark as often as
      // not, and scanners read the inverse fine either way.
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}
