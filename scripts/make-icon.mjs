// Renders desktop/inbox-mark.svg into desktop/icon.icns on the macOS icon grid
// (an 824 px body centred on a 1024 px canvas). Run: node scripts/make-icon.mjs
import sharp from "sharp";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const svg = readFileSync(path.join(root, "desktop/inbox-mark.svg"));
const dir = mkdtempSync(path.join(tmpdir(), "fabric-icon-"));
const iconset = path.join(dir, "icon.iconset");
execFileSync("mkdir", ["-p", iconset]);
try {
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = size * scale;
      const body = Math.round(px * 824 / 1024);
      const mark = await sharp(svg, { density: Math.max(72, Math.ceil(72 * body / 256)) }).resize(body, body).png().toBuffer();
      const offset = Math.round((px - body) / 2);
      await sharp({ create: { width: px, height: px, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([{ input: mark, left: offset, top: offset }]).png()
        .toFile(path.join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`));
    }
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(root, "desktop/icon.icns")]);
  console.log("desktop/icon.icns");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
