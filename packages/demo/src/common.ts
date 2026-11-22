import path from 'node:path';
import { Store, adapterFromEnv } from '@pixelblame/core';

export const DATA = path.resolve(process.env.PIXELBLAME_DATA ?? 'data');
export const store = new Store(DATA);
export const adapter = adapterFromEnv();

export const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
export const h = (s: string) => console.log(`\n${bold('== ' + s)}`);

/** Render a per-cell heat array as a small text grid (█ hot … · cold). */
export function asciiHeat(heat: number[], n: number, outline: number[] = []): string {
  const shades = ['·', '░', '▒', '▓', '█'];
  const rows: string[] = [];
  for (let r = 0; r < n; r++) {
    const cells = [];
    for (let c = 0; c < n; c++) {
      const i = r * n + c;
      const s = shades[Math.min(4, Math.round(heat[i]! * 4))]!;
      cells.push(outline.includes(i) ? `[${s}${s}]` : ` ${s}${s} `);
    }
    rows.push('    ' + cells.join(''));
  }
  return rows.join('\n');
}
