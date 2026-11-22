import sharp from 'sharp';
import { createHash } from 'node:crypto';

export function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Difference hash (dHash), 64 bits as 16 hex chars.
 * Grayscale, resize to 9x8, then bit = left pixel brighter than right neighbour.
 * Robust to resize, recompression and small brightness shifts; weak against crop/rotation.
 */
export async function dhash(image: Buffer): Promise<string> {
  const { data } = await sharp(image)
    .rotate() // honour EXIF orientation so the hash matches what a viewer sees
    .grayscale()
    .resize(9, 8, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = data[y * 9 + x]!;
      const right = data[y * 9 + x + 1]!;
      bits = (bits << 1n) | (left > right ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

export function hamming(a: string, b: string): number {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}
