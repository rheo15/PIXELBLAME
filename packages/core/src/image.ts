import sharp from 'sharp';

export type Family = 'jpeg' | 'resize' | 'blur' | 'brightness' | 'rotate' | 'crop';
export const FAMILIES: Family[] = ['jpeg', 'resize', 'blur', 'brightness', 'rotate', 'crop'];

export interface PerturbStep {
  family: Family;
  /** Human label, e.g. "q70" or "+20%". */
  label: string;
  /** The parameter value (quality, percent, sigma, degrees...). */
  value: number;
}

/** Ladders run from mildest to strongest so "first change" is a meaningful tipping point. */
export const LADDERS: Record<Family, PerturbStep[]> = {
  jpeg: [90, 70, 50, 30].map((v) => ({ family: 'jpeg', label: `q${v}`, value: v })),
  resize: [90, 70, 50, 30].map((v) => ({ family: 'resize', label: `${v}%`, value: v })),
  blur: [0.5, 1, 2, 4, 8, 16].map((v) => ({ family: 'blur', label: `σ${v}`, value: v })),
  brightness: [10, -10, 20, -20, 30, -30].map((v) => ({
    family: 'brightness',
    label: `${v > 0 ? '+' : ''}${v}%`,
    value: v,
  })),
  rotate: [2, 5, 10, 15].map((v) => ({ family: 'rotate', label: `${v}°`, value: v })),
  crop: [95, 90, 80, 70].map((v) => ({ family: 'crop', label: `${v}%`, value: v })),
};

export async function imageSize(img: Buffer): Promise<{ width: number; height: number }> {
  const m = await sharp(img).metadata();
  return { width: m.width ?? 0, height: m.height ?? 0 };
}

export async function meanColor(img: Buffer): Promise<{ r: number; g: number; b: number }> {
  const s = await sharp(img).removeAlpha().stats();
  const [r, g, b] = s.channels.map((c) => Math.round(c.mean));
  return { r: r ?? 0, g: g ?? 0, b: b ?? 0 };
}

/**
 * Apply one perturbation. Output is PNG except for the jpeg family, so the only
 * lossy step is the one being measured. Output dimensions match the input except
 * for resize (which is the point of that family).
 */
export async function perturb(img: Buffer, step: PerturbStep): Promise<Buffer> {
  const { width, height } = await imageSize(img);
  const base = sharp(img).removeAlpha();
  switch (step.family) {
    case 'jpeg':
      return base.jpeg({ quality: step.value, mozjpeg: false }).toBuffer();
    case 'resize':
      return base
        .resize(Math.max(1, Math.round((width * step.value) / 100)), Math.max(1, Math.round((height * step.value) / 100)))
        .png()
        .toBuffer();
    case 'blur':
      return base.blur(Math.max(0.3, step.value)).png().toBuffer();
    case 'brightness': {
      const f = 1 + step.value / 100;
      return base.linear(f, 0).png().toBuffer();
    }
    case 'rotate': {
      const bg = await meanColor(img);
      const rotated = await base.rotate(step.value, { background: bg }).png().toBuffer();
      const r = await imageSize(rotated);
      return sharp(rotated)
        .extract({
          left: Math.floor((r.width - width) / 2),
          top: Math.floor((r.height - height) / 2),
          width,
          height,
        })
        .png()
        .toBuffer();
    }
    case 'crop': {
      const w = Math.max(1, Math.round((width * step.value) / 100));
      const h = Math.max(1, Math.round((height * step.value) / 100));
      return base
        .extract({ left: Math.floor((width - w) / 2), top: Math.floor((height - h) / 2), width: w, height: h })
        .png()
        .toBuffer();
    }
  }
}

export type FillMode = 'mean' | 'blur';

export interface CellRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Pixel rectangle of cell `index` (row-major) in an n x n grid. Edge cells absorb remainders. */
export function cellRect(index: number, n: number, width: number, height: number): CellRect {
  const row = Math.floor(index / n);
  const col = index % n;
  const x0 = Math.round((col * width) / n);
  const x1 = Math.round(((col + 1) * width) / n);
  const y0 = Math.round((row * height) / n);
  const y1 = Math.round(((row + 1) * height) / n);
  return { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Occlude the given cells. "mean" fills with the whole image's mean colour;
 * "blur" replaces each cell with a heavily blurred copy of itself.
 * Deterministic: the same image + cells + fill gives identical bytes, so the exact cache works.
 */
export async function occlude(img: Buffer, cells: number[], n: number, fill: FillMode = 'mean'): Promise<Buffer> {
  const { width, height } = await imageSize(img);
  const sorted = [...new Set(cells)].sort((a, b) => a - b);
  if (sorted.length === 0) return sharp(img).removeAlpha().png().toBuffer();
  const composites: sharp.OverlayOptions[] = [];
  if (fill === 'mean') {
    const c = await meanColor(img);
    for (const i of sorted) {
      const r = cellRect(i, n, width, height);
      const patch = await sharp({ create: { width: r.width, height: r.height, channels: 3, background: c } }).png().toBuffer();
      composites.push({ input: patch, left: r.left, top: r.top });
    }
  } else {
    const sigma = Math.max(width, height) / n / 3;
    const blurred = await sharp(img).removeAlpha().blur(sigma).png().toBuffer();
    for (const i of sorted) {
      const r = cellRect(i, n, width, height);
      const patch = await sharp(blurred).extract(r).png().toBuffer();
      composites.push({ input: patch, left: r.left, top: r.top });
    }
  }
  return sharp(img).removeAlpha().composite(composites).png().toBuffer();
}

export function mediaType(img: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' {
  if (img[0] === 0xff && img[1] === 0xd8) return 'image/jpeg';
  if (img[0] === 0x52 && img[1] === 0x49 && img[8] === 0x57) return 'image/webp';
  if (img[0] === 0x47 && img[1] === 0x49) return 'image/gif';
  return 'image/png';
}
