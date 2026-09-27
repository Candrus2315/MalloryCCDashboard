/**
 * Favicon rasterizer — public/favicon.svg → 32px PNG, 180px apple-touch PNG,
 * and a real multi-size .ico (PNG-compressed entries, standard container).
 * Run: bun run scripts/make-favicon.ts
 */
import sharp from "sharp";
import { readFileSync, writeFileSync } from "node:fs";

const svg = readFileSync("public/favicon.svg");

async function png(size: number, background?: string): Promise<Buffer> {
  let img = sharp(svg, { density: 300 }).resize(size, size);
  if (background) img = img.flatten({ background });
  return img.png().toBuffer();
}

// ICO container: 6-byte header + per-image 16-byte directory entries + PNG blobs.
// Entries: w(0=256) h(0=256) colors 0 reserved 0 planes 1 bpp 32 size offset.
function packIco(images: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries: Buffer[] = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size % 256 === size ? size : 0, 0);
    e.writeUInt8(size % 256 === size ? size : 0, 1);
    e.writeUInt8(0, 2); // palette colors
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

const p32 = await png(32);
const p256 = await png(256);
const p180 = await png(180, "#1c1917"); // apple-touch: opaque background

writeFileSync("public/favicon-32.png", p32);
writeFileSync("public/apple-touch-icon.png", p180);
writeFileSync("public/favicon.ico", packIco([
  { size: 32, data: p32 },
  { size: 256, data: p256 },
]));
console.log("favicon assets written:", {
  "favicon-32.png": p32.length,
  "apple-touch-icon.png": p180.length,
  "favicon.ico": 6 + 32 + p32.length + p256.length,
});
