import { describe, it, expect } from 'vitest';
import { ddmin, runBlame, ridge, estimateBlame } from '../src/blame.js';
import { wrapClient } from '../src/client.js';
import { mockAdapter } from '../src/adapters/mock.js';
import { renderWardrobe, FITCHECK_PROMPT } from '../src/fitcheck.js';
import { tmpStore } from './helpers.js';

describe('ddmin', () => {
  it('returns the minimal set on a synthetic AND oracle', async () => {
    const needed = [3, 7, 11];
    let calls = 0;
    const unique = new Set<string>();
    const r = await ddmin(Array.from({ length: 16 }, (_, i) => i), async (s) => {
      calls++;
      unique.add([...s].sort((a, b) => a - b).join(','));
      return needed.every((x) => s.includes(x));
    });
    expect([...r.set].sort((a, b) => a - b)).toEqual(needed);
    expect(r.complete).toBe(true);
    console.log(`ddmin tests: ${calls} total, ${unique.size} unique`);
    // repeats are free in Image Blame (exact cache), so the unique count is the real cost
    expect(unique.size).toBeLessThan(calls);
    expect(unique.size).toBeLessThan(48);
  });
  it('returns a single element when any one element suffices (OR oracle) and is 1-minimal', async () => {
    const r = await ddmin(Array.from({ length: 16 }, (_, i) => i), async (s) => s.includes(9) || s.includes(2));
    expect(r.set.length).toBe(1);
    expect([2, 9]).toContain(r.set[0]);
  });
});

describe('Image Blame', () => {
  it('stops at the call budget and reports partial results', async () => {
    const store = tmpStore();
    const client = wrapClient(mockAdapter(), { store, cache: 'exact' });
    const r = await runBlame({ client, image: await renderWardrobe('weekend'), prompt: FITCHECK_PROMPT, maxCalls: 6 });
    expect(r.liveCalls).toBeLessThanOrEqual(6);
    expect(r.budgetExhausted).toBe(true);
    expect(r.items.some((i) => !i.minimal.proven)).toBe(true);
  });
  it('finds single-cell causes and a joint two-cell cause, and re-runs for free', async () => {
    const store = tmpStore();
    const image = await renderWardrobe('weekend');
    const client = wrapClient(mockAdapter(), { store, cache: 'exact' });
    const r = await runBlame({ client, image, prompt: FITCHECK_PROMPT, grid: 4, maxCalls: 40 });
    await client.flush();
    const by = Object.fromEntries(r.items.map((i) => [i.key, i]));
    expect(by['red shirt']!.minimal).toEqual({ cells: [0], proven: true, method: 'single-cell' });
    expect(by['yellow dress']!.minimal).toEqual({ cells: [5, 6], proven: true, method: 'ddmin' });
    expect(by['red shirt']!.heat.indexOf(1)).toBe(0);
    const again = await runBlame({ client: wrapClient(mockAdapter(), { store, cache: 'exact' }), image, prompt: FITCHECK_PROMPT });
    expect(again.liveCalls).toBe(0);
  });
  it('ridge attribution recovers the true cause and the estimate is capped by the budget', () => {
    const X = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [0, 1, 1]];
    const y = X.map((r) => r[1]!); // only feature 1 matters
    const w = ridge(X, y, 0.01);
    expect(w[1]).toBeGreaterThan(0.9);
    expect(Math.abs(w[0]!)).toBeLessThan(0.05);
    const e = estimateBlame({ grid: 4, maxCalls: 10, itemsGuess: 4, width: 480, height: 480, prompt: 'x', pricing: { inputPerMTok: 3, outputPerMTok: 15 } });
    expect(e.cappedAt).toBe(10);
    expect(e.total).toBeGreaterThan(17);
  });
});
