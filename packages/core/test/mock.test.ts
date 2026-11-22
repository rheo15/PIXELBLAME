import { describe, it, expect } from 'vitest';
import { mockAdapter } from '../src/adapters/mock.js';
import { extractJson } from '../src/adapters/anthropic.js';
import { renderWardrobe } from '../src/fitcheck.js';
import { occlude } from '../src/image.js';

describe('mock vision adapter', () => {
  it('is deterministic and returns unique items in cell order', async () => {
    const m = mockAdapter();
    const img = await renderWardrobe('weekend');
    const a = await m.call({ prompt: 'p', images: [img] });
    const b = await m.call({ prompt: 'p', images: [img] });
    expect(a.rawText).toBe(b.rawText);
    expect(a.output.items.map((i) => i.name)).toEqual(['red shirt', 'blue jacket', 'yellow dress', 'green scarf', 'purple skirt']);
  });
  it('occluding a garment cell removes that item only', async () => {
    const m = mockAdapter();
    const out = await m.call({ prompt: 'p', images: [await occlude(await renderWardrobe('office'), [4], 3)] });
    expect(out.output.items.map((i) => i.name)).toEqual(['blue jacket', 'purple skirt', 'pink sneakers']);
  });
  it('extractJson tolerates prose and fences around the JSON', () => {
    expect(extractJson('Sure!\n```json\n{"items":[{"name":"x","category":"top","color":"red"}]}\n```').items).toHaveLength(1);
    expect(extractJson('no json here').items).toEqual([]);
  });
});
