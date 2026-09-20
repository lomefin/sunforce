// =============================================================================
// SunForce — tools/png.mts       RGBA8 -> PNG, pure Node, no dependencies.
//
// The baker is the only consumer and it emits one big atlas per character, so
// this is the SIMPLEST correct encoder: truecolour with alpha (bit depth 8,
// colour type 6), one IDAT, filter 0 (None) on every scanline. Filter 0 costs a
// few percent of file size and buys ~30 lines that cannot be subtly wrong — and
// an atlas is mostly transparent padding, which deflates to nothing regardless.
//
// Structure: 8-byte signature | IHDR | IDAT | IEND, where every chunk is
// length:u32be, type:4 ascii, data, crc32:u32be — and the CRC covers the TYPE
// AND THE DATA but not the length. That last detail is the one people get
// wrong, so `chunk` below is the only place any of it is encoded.
// =============================================================================

import { deflateSync } from 'node:zlib';

const PNG_SIG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** Standard CRC-32 (IEEE 802.3, reflected, poly 0xEDB88320). Built once. */
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 12);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  dv.setUint32(body.length + 8, crc32(out.subarray(4, body.length + 8)));
  return out;
}

function ihdr(w: number, h: number): Uint8Array {
  const d = new Uint8Array(13);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  d[8] = 8;    // bit depth
  d[9] = 6;    // colour type 6 = truecolour with alpha
  d[10] = 0;   // compression: deflate
  d[11] = 0;   // filter method: adaptive (the per-scanline byte, always 0 below)
  d[12] = 0;   // interlace: none
  return d;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * `rgba` is w*h*4 bytes, NON-premultiplied, row major, top row first — exactly
 * a browser ImageData's layout, so the trip through `createImageBitmap` and
 * `texImage2D` is byte-identical. `level` is zlib's 0..9; 9 is the default
 * because this runs offline once and the output ships.
 */
export function encodePng(rgba: Uint8Array, w: number, h: number, level = 9): Uint8Array {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    throw new Error(`encodePng: bad size ${w}x${h}`);
  }
  if (rgba.length !== w * h * 4) {
    throw new Error(`encodePng: expected ${w * h * 4} bytes for ${w}x${h}, got ${rgba.length}`);
  }
  const stride = w * 4;
  const raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const src = y * stride;
    raw[y * (stride + 1)] = 0;   // filter 0 = None, so the row is the raw pixels
    raw.set(rgba.subarray(src, src + stride), y * (stride + 1) + 1);
  }
  return concat([
    PNG_SIG,
    chunk('IHDR', ihdr(w, h)),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level }))),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
