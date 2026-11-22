import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { dhash, hamming } from '../src/dhash.js';
import { occlude, perturb, cellRect, meanColor, imageSize, LADDERS } from '../src/image.js';
import { renderWardrobe } from '../src/fitcheck.js';

describe('dHash', () => {
  it('is stable under resize', async () => {
    const img = await renderWardrobe('weekend');
    const small = await sharp(img).resize(240).png().toBuffer();
    expect(hamming(await dhash(img), await dhash(small))).toBeLessThanOrEqual(2);
  });
  it('is stable under JPEG recompression', async () => {
    const img = await renderWardrobe('office');
    const jpg = await sharp(img).jpeg({ quality: 40 }).toBuffer();
    expect(hamming(await dhash(img), await dhash(jpg))).toBeLessThanOrEqual(2);
  });
  it('changes for a different image', async () => {
    const a = await dhash(await renderWardrobe('weekend'));
    const b = await dhash(await renderWardrobe('festival'));
    expect(hamming(a, b)).toBeGreaterThan(4); // measured 9: the generated photos share a layout, far above resize/JPEG noise (≤2)
  });
  it('hamming counts differing bits', () => {
    expect(hamming('0000000000000000', '0000000000000000')).toBe(0);
    expect(hamming('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(hamming('000000000000000f', '0000000000000001')).toBe(3);
  });
});

describe('masks and perturbations', () => {
  it('occlude fills exactly the chosen cell with the mean colour', async () => {
    const img = await renderWardrobe('weekend');
    const mean = await meanColor(img);
    const out = await occlude(img, [5], 4);
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const r = cellRect(5, 4, info.width, info.height);
    const px = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3));
    expect(px(r.left + 3, r.top + 3)).toEqual([mean.r, mean.g, mean.b]);
    expect(px(r.left + r.width - 1, r.top + r.height - 1)).toEqual([mean.r, mean.g, mean.b]);
    // a pixel in cell 0 (red shirt) is untouched
    const orig = await sharp(img).removeAlpha().raw().toBuffer();
    const i = (60 * info.width + 60) * 3;
    expect(Array.from(data.subarray(i, i + 3))).toEqual(Array.from(orig.subarray(i, i + 3)));
  });
  it('occlude is deterministic so the exact cache can work', async () => {
    const img = await renderWardrobe('festival');
    const a = await occlude(img, [1, 2], 4);
    const b = await occlude(img, [2, 1], 4);
    expect(a.equals(b)).toBe(true);
  });
  it('grid cells tile the image with no gaps', () => {
    const area = Array.from({ length: 9 }, (_, i) => cellRect(i, 3, 100, 101)).reduce((s, r) => s + r.width * r.height, 0);
    expect(area).toBe(100 * 101);
  });
  it('perturbations keep size, except resize and crop which scale by their percent', async () => {
    const img = await renderWardrobe('weekend');
    for (const fam of ['jpeg', 'blur', 'brightness', 'rotate'] as const) {
      expect(await imageSize(await perturb(img, LADDERS[fam][1]!))).toEqual({ width: 480, height: 480 });
    }
    expect(await imageSize(await perturb(img, LADDERS.resize[2]!))).toEqual({ width: 240, height: 240 });
    expect(await imageSize(await perturb(img, LADDERS.crop[3]!))).toEqual({ width: 336, height: 336 });
    const jpg = await perturb(img, LADDERS.jpeg[0]!);
    expect(jpg[0]).toBe(0xff);
  });
});
