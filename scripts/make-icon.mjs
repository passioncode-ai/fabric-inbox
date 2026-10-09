// Renders desktop/inbox-mark.svg into the app icons, on the macOS icon grid (an 824 px body centred
// on a 1024 px canvas): desktop/icon.icns (macOS), desktop/icon.ico (Windows: PNG frames 16–256)
// and desktop/icon.png (Linux, 512 px). Run: node scripts/make-icon.mjs
import sharp from "sharp";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const svg = readFileSync(path.join(root, "desktop/inbox-mark.svg"));
const dir = mkdtempSync(path.join(tmpdir(), "fabric-icon-"));
const iconset = path.join(dir, "icon.iconset");
execFileSync("mkdir", ["-p", iconset]);

/** One square PNG of the mark on the grid. */
async function frame(px) {
  const body = Math.round(px * 824 / 1024);
  const mark = await sharp(svg, { density: Math.max(72, Math.ceil(72 * body / 256)) }).resize(body, body).png().toBuffer();
  const offset = Math.round((px - body) / 2);
  return sharp({ create: { width: px, height: px, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: mark, left: offset, top: offset }]).png().toBuffer();
}

/** An ICO file of PNG frames (Windows Vista and later read PNG-compressed entries). */
export function icoOf(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
  const entries = [];
  let offset = 6 + 16 * frames.length;
  for (const { px, png } of frames) {
    const e = Buffer.alloc(16);
    e.writeUInt8(px >= 256 ? 0 : px, 0); e.writeUInt8(px >= 256 ? 0 : px, 1); // 0 means 256
    e.writeUInt8(0, 2); e.writeUInt8(0, 3); e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8); e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...frames.map((f) => f.png)]);
}

try {
  if (platform() === "darwin") {
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) writeFileSync(path.join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`), await frame(size * scale));
    }
    execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(root, "desktop/icon.icns")]);
    console.log("desktop/icon.icns");
  }
  const frames = [];
  for (const px of [16, 24, 32, 48, 64, 128, 256]) frames.push({ px, png: await frame(px) });
  writeFileSync(path.join(root, "desktop/icon.ico"), icoOf(frames));
  console.log("desktop/icon.ico");
  writeFileSync(path.join(root, "desktop/icon.png"), await frame(512));
  console.log("desktop/icon.png");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
