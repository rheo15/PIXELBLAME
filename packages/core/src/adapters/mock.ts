import sharp from 'sharp';
import type { OutputItem, VisionAdapter, VisionRequest, VisionResponse } from '../types.js';

/** Hue buckets (degrees, [start, end)) and the garment each one maps to. */
const BUCKETS: Array<{ from: number; to: number; item: OutputItem }> = [
  { from: 345, to: 360, item: { name: 'red shirt', category: 'top', color: 'red' } },
  { from: 0, to: 15, item: { name: 'red shirt', category: 'top', color: 'red' } },
  { from: 15, to: 45, item: { name: 'orange sweater', category: 'top', color: 'orange' } },
  { from: 45, to: 70, item: { name: 'yellow dress', category: 'dress', color: 'yellow' } },
  { from: 70, to: 165, item: { name: 'green scarf', category: 'accessory', color: 'green' } },
  { from: 165, to: 195, item: { name: 'teal beanie', category: 'accessory', color: 'teal' } },
  { from: 195, to: 255, item: { name: 'blue jacket', category: 'outerwear', color: 'blue' } },
  { from: 255, to: 290, item: { name: 'purple skirt', category: 'bottom', color: 'purple' } },
  { from: 290, to: 345, item: { name: 'pink sneakers', category: 'shoes', color: 'pink' } },
];

/** Pixels below this HSV saturation (or value) count as neutral background. */
const MIN_SAT = 0.5;
const MIN_VAL = 0.2;
/** A cell needs at least this share of saturated pixels to contain a garment. */
const MIN_CELL_SHARE = 0.35;
const ANALYSIS_SIZE = 96;

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max / 255];
}

function bucketFor(h: number): number {
  return BUCKETS.findIndex((b) => h >= b.from && h < b.to);
}

export interface MockCellReading {
  cell: number;
  share: number;
  item: OutputItem | null;
}

/** Read the dominant garment colour in each cell of a 3x3 grid. Exposed for tests and docs. */
export async function readCells(image: Buffer): Promise<MockCellReading[]> {
  const S = ANALYSIS_SIZE;
  const { data } = await sharp(image)
    .removeAlpha()
    .resize(S, S, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out: MockCellReading[] = [];
  for (let cell = 0; cell < 9; cell++) {
    const cx = (cell % 3) * (S / 3);
    const cy = Math.floor(cell / 3) * (S / 3);
    const counts = new Array<number>(BUCKETS.length).fill(0);
    let saturated = 0;
    let total = 0;
    for (let y = cy; y < cy + S / 3; y++) {
      for (let x = cx; x < cx + S / 3; x++) {
        const i = (y * S + x) * 3;
        const [h, s, v] = rgbToHsv(data[i]!, data[i + 1]!, data[i + 2]!);
        total++;
        if (s < MIN_SAT || v < MIN_VAL) continue;
        saturated++;
        const b = bucketFor(h);
        if (b >= 0) counts[b]!++;
      }
    }
    const share = saturated / total;
    let best = -1;
    let bestCount = 0;
    counts.forEach((c, i) => {
      // merge the two red buckets
      if (c > bestCount) {
        best = i;
        bestCount = c;
      }
    });
    const redTotal = counts[0]! + counts[1]!;
    if (redTotal > bestCount) best = 0;
    out.push({ cell, share, item: share >= MIN_CELL_SHARE && best >= 0 ? BUCKETS[best]!.item : null });
  }
  return out;
}

/**
 * Deterministic stand-in for a vision model. Only looks at the first image.
 * Occluding a cell removes its item, heavy blur washes saturation out,
 * rotation/crop move colour across cell borders, mild JPEG/resize change nothing.
 */
export function mockAdapter(opts: { latencyMs?: number } = {}): VisionAdapter {
  return {
    name: 'mock',
    model: 'mock-vision-1',
    pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    async call(req: VisionRequest): Promise<VisionResponse> {
      if (!req.images[0]) throw new Error('mock adapter needs at least one image');
      if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
      const cells = await readCells(req.images[0]);
      const seen = new Set<string>();
      const items: OutputItem[] = [];
      for (const c of cells) {
        if (c.item && !seen.has(c.item.name)) {
          seen.add(c.item.name);
          items.push({ ...c.item });
        }
      }
      const where = cells
        .filter((c) => c.item)
        .map((c) => `${c.item!.color} in cell ${c.cell + 1}`)
        .join(', ');
      const output = {
        items,
        reasoning: items.length
          ? `Picked ${items.length} pieces by dominant colour (${where}).`
          : 'No clearly coloured garments found.',
      };
      const rawText = JSON.stringify(output);
      const meta = await sharp(req.images[0]).metadata();
      const imageTokens = Math.ceil(((meta.width ?? 0) * (meta.height ?? 0)) / 750);
      return {
        output,
        rawText,
        tokens: { input: Math.ceil(req.prompt.length / 4) + imageTokens, output: Math.ceil(rawText.length / 4) },
      };
    },
  };
}
