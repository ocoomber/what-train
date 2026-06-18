/* Generates the PWA PNG icons (no external deps) using Node's zlib.
 * Draws a simple departure-board "train" mark in brand colours onto a pixel
 * buffer and encodes a valid PNG. Run: node tools/gen-icons.js */

const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

const BG = [10, 13, 18];     // #0a0d12
const FG = [245, 208, 32];   // #f5d020

function makeIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const set = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
  };
  const rect = (x0, y0, w, h, col) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, col);
  };
  const disc = (cx, cy, rad, col) => {
    for (let y = cy - rad; y <= cy + rad; y++)
      for (let x = cx - rad; x <= cx + rad; x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= rad * rad) set(x, y, col);
  };

  // background
  rect(0, 0, size, size, BG);

  const u = size / 32; // unit grid
  const U = (n) => Math.round(n * u);

  // train body
  rect(U(8), U(8), U(16), U(13), FG);
  // rounded-ish top: trim corners
  for (let i = 0; i < U(2); i++) {
    rect(U(8) + i, U(8) + (U(2) - i) - 1, 1, 1, BG);
    rect(U(24) - 1 - i, U(8) + (U(2) - i) - 1, 1, 1, BG);
  }
  // windows (cut out of body)
  rect(U(10), U(11), U(5), U(4), BG);
  rect(U(17), U(11), U(5), U(4), BG);
  // skirt / front
  rect(U(9), U(21), U(14), U(2), FG);
  // wheels
  disc(U(13), U(24), U(2), FG);
  disc(U(19), U(24), U(2), FG);
  // rails
  rect(U(6), U(27), U(20), Math.max(1, U(1)), FG);

  return encodePng(size, size, buf);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter type 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0, 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let CRC_TABLE;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return crc ^ 0xffffffff;
}

const outDir = path.join(__dirname, "..", "public", "icons");
fs.mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) {
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), makeIcon(size));
  console.log(`wrote icon-${size}.png`);
}
