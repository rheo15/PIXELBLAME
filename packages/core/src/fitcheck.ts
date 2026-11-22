import sharp from 'sharp';

/**
 * FitCheck: the demo app. Sends a wardrobe photo + prompt to a vision model and
 * gets outfit suggestions back as JSON. Photos are generated flat-lays so the
 * project runs fully offline.
 */
export const FITCHECK_PROMPT =
  'You are FitCheck, a stylist. Look at this wardrobe flat-lay and suggest an outfit. ' +
  'Return ONLY JSON: {"items":[{"name":string,"category":string,"color":string}],"reasoning":string}. ' +
  'List each garment you would use once, in reading order (left to right, top to bottom).';

interface Garment {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  /** rounded corners make it read as fabric rather than a chart */
  rx?: number;
}

const SIZE = 480;
const BG = '#e9e4da';

/** Each layout is in a 480x480 frame; colours are chosen to land squarely in one mock hue bucket. */
export const WARDROBES: Record<string, { title: string; garments: Garment[] }> = {
  weekend: {
    title: 'Weekend wardrobe',
    garments: [
      { x: 28, y: 30, w: 120, h: 112, fill: '#d23a3a', rx: 14 }, // red shirt, cell 1
      { x: 330, y: 22, w: 128, h: 128, fill: '#2f62c9', rx: 12 }, // blue jacket, cell 3
      { x: 120, y: 175, w: 240, h: 120, fill: '#e8c52a', rx: 20 }, // yellow dress, spans cells 4-6 centre
      { x: 30, y: 340, w: 110, h: 110, fill: '#2f9a4c', rx: 40 }, // green scarf, cell 7
      { x: 340, y: 340, w: 110, h: 112, fill: '#7a3fb5', rx: 10 }, // purple skirt, cell 9
      { x: 190, y: 360, w: 100, h: 70, fill: '#bdb7ac', rx: 8 }, // grey belt (neutral, ignored)
    ],
  },
  office: {
    title: 'Office capsule',
    garments: [
      { x: 180, y: 25, w: 120, h: 120, fill: '#2f62c9', rx: 12 }, // blue jacket, cell 2
      { x: 25, y: 185, w: 115, h: 110, fill: '#f2f0ec', rx: 10 }, // white tee (neutral)
      { x: 180, y: 180, w: 120, h: 120, fill: '#e07a1f', rx: 16 }, // orange sweater, cell 5
      { x: 340, y: 185, w: 112, h: 112, fill: '#7a3fb5', rx: 10 }, // purple skirt, cell 6
      { x: 180, y: 345, w: 120, h: 100, fill: '#d94f9c', rx: 30 }, // pink sneakers, cell 8
    ],
  },
  festival: {
    title: 'Festival bag',
    garments: [
      { x: 25, y: 25, w: 115, h: 115, fill: '#e8c52a', rx: 20 }, // yellow dress
      { x: 340, y: 30, w: 115, h: 110, fill: '#1fa7a0', rx: 40 }, // teal beanie
      { x: 180, y: 185, w: 120, h: 110, fill: '#d23a3a', rx: 14 }, // red shirt
      { x: 30, y: 345, w: 110, h: 110, fill: '#2f9a4c', rx: 40 }, // green scarf
      { x: 340, y: 340, w: 110, h: 110, fill: '#d94f9c', rx: 30 }, // pink sneakers
    ],
  },
};

/** Render a wardrobe flat-lay as PNG (a subtle weave texture keeps dHash from being degenerate). */
export async function renderWardrobe(name: keyof typeof WARDROBES | string): Promise<Buffer> {
  const w = WARDROBES[name];
  if (!w) throw new Error(`unknown wardrobe "${name}" (have: ${Object.keys(WARDROBES).join(', ')})`);
  const shapes = w.garments
    .map(
      (g) =>
        `<rect x="${g.x + 4}" y="${g.y + 6}" width="${g.w}" height="${g.h}" rx="${g.rx ?? 8}" fill="#000" opacity="0.10"/>` +
        `<rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="${g.rx ?? 8}" fill="${g.fill}"/>` +
        `<rect x="${g.x + 8}" y="${g.y + 8}" width="${g.w - 16}" height="${g.h - 16}" rx="${Math.max(2, (g.rx ?? 8) - 6)}" fill="none" stroke="#ffffff" stroke-opacity="0.18" stroke-width="2" stroke-dasharray="6 5"/>`,
    )
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
    <defs><pattern id="weave" width="8" height="8" patternUnits="userSpaceOnUse">
      <rect width="8" height="8" fill="${BG}"/><path d="M0 4h8M4 0v8" stroke="#d9d2c4" stroke-width="1"/></pattern></defs>
    <rect width="100%" height="100%" fill="url(#weave)"/>${shapes}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export const SCENARIOS = [
  { name: 'Weekend outfit', wardrobe: 'weekend' },
  { name: 'Office outfit', wardrobe: 'office' },
  { name: 'Festival outfit', wardrobe: 'festival' },
] as const;
