import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import { wrapClient, requestKeyFor } from '../src/client.js';
import { mockAdapter } from '../src/adapters/mock.js';
import { computeCalibration, type Calibration } from '../src/calibration.js';
import { replayRun } from '../src/replay.js';
import { renderWardrobe, FITCHECK_PROMPT } from '../src/fitcheck.js';
import { dhash, hamming } from '../src/dhash.js';
import { tmpStore } from './helpers.js';

const P = FITCHECK_PROMPT;
function calFor(threshold: number): Calibration {
  const a = mockAdapter();
  const c = computeCalibration([{ distance: threshold + 1, change: 0, model: a.model, request_key: requestKeyFor(a, { prompt: P }) }, { distance: 60, change: 1, model: a.model, request_key: requestKeyFor(a, { prompt: P }) }]);
  return c;
}

describe('wrapClient cache', () => {
  it('serves identical bytes from the exact cache without calling the adapter', async () => {
    const store = tmpStore();
    const adapter = mockAdapter();
    const spy = vi.spyOn(adapter, 'call');
    const client = wrapClient(adapter, { store, calibration: calFor(5) });
    const img = await renderWardrobe('weekend');
    await client.call({ prompt: P, images: [img] });
    await client.flush();
    // a near-identical image is also recorded, so both exact and near would match
    await client.call({ prompt: P, images: [await sharp(img).jpeg({ quality: 90 }).toBuffer()] });
    const r = await client.call({ prompt: P, images: [img] });
    expect(r.meta.cache).toBe('exact');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('labels near hits with distance and threshold; near matching is off without calibration', async () => {
    const img = await renderWardrobe('weekend');
    const resaved = await sharp(img).resize(300).jpeg({ quality: 60 }).toBuffer();
    const d = hamming(await dhash(img), await dhash(resaved));

    const store = tmpStore();
    const off = wrapClient(mockAdapter(), { store, calibration: null });
    await off.call({ prompt: P, images: [img] });
    await off.flush();
    expect((await off.call({ prompt: P, images: [resaved] })).meta.cache).toBe('live');

    const store2 = tmpStore();
    const on = wrapClient(mockAdapter(), { store: store2, calibration: calFor(Math.max(d, 1)) });
    await on.call({ prompt: P, images: [img] });
    await on.flush();
    const r = await on.call({ prompt: P, images: [resaved] });
    expect(r.meta).toMatchObject({ cache: 'near', distance: d, threshold: Math.max(d, 1) });
  });

  it('rejects near matches above the threshold', async () => {
    const store = tmpStore();
    const client = wrapClient(mockAdapter(), { store, calibration: calFor(1) });
    const img = await renderWardrobe('weekend');
    const blurred = await sharp(img).blur(24).png().toBuffer();
    expect(hamming(await dhash(img), await dhash(blurred))).toBeGreaterThan(1);
    await client.call({ prompt: P, images: [img] });
    await client.flush();
    const r = await client.call({ prompt: P, images: [blurred] });
    expect(r.meta.cache).toBe('live');
    expect(r.output.items.length).toBeLessThan(5);
  });

  it('replay serves the recording and never calls the adapter', async () => {
    const store = tmpStore();
    const runId = store.createRun('t');
    const live = wrapClient(mockAdapter(), { store, runId });
    await live.call({ prompt: P, images: [await renderWardrobe('office')] });
    await live.call({ prompt: P, images: [await renderWardrobe('festival')] });
    await live.flush();
    const adapter = mockAdapter();
    const spy = vi.spyOn(adapter, 'call');
    const steps = await replayRun(store, adapter, runId);
    expect(steps.map((s) => s.ok)).toEqual([true, true]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('a recording failure never breaks the call', async () => {
    const store = tmpStore();
    store.insertCall = () => {
      throw new Error('disk full');
    };
    store.putBlob = () => {
      throw new Error('disk full');
    };
    const errors: unknown[] = [];
    const client = wrapClient(mockAdapter(), { store, onError: (e) => errors.push(e) });
    const r = await client.call({ prompt: P, images: [await renderWardrobe('weekend')] });
    await client.flush();
    expect(r.output.items.length).toBe(5);
    expect(errors.length).toBeGreaterThan(0);
    expect(client.stats.recordErrors).toBeGreaterThan(0);
  });
});
