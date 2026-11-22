import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dhash, hamming, sha256 } from './dhash.js';
import { diffOutputs, itemNames } from './diff.js';
import { FAMILIES, LADDERS, perturb, type Family } from './image.js';
import { requestKeyFor, type WrappedClient } from './client.js';
import type { Store } from './store.js';
import type { StructuredOutput } from './types.js';

export interface DriftPoint {
  label: string;
  value: number;
  step: number;
  distance: number;
  change: number;
  items: string[];
  cache: string;
}

export interface DriftFamilyResult {
  family: Family;
  points: DriftPoint[];
  /** First step (mildest first) where the output changed at all. */
  tippingPoint: { label: string; distance: number; change: number } | null;
}

export interface DriftResult {
  driftId: string;
  sourceSha: string;
  prompt: string;
  model: string;
  requestKey: string;
  baseline: StructuredOutput;
  families: DriftFamilyResult[];
  liveCalls: number;
  cachedCalls: number;
  createdAt: string;
}

export function driftCallCount(families: Family[]): number {
  return 1 + families.reduce((n, f) => n + LADDERS[f].length, 0);
}

/**
 * Replay one request under a ladder of perturbations. The client must use the exact
 * cache only: a near-match cache would answer with the baseline and hide the drift.
 */
export async function runDrift(opts: {
  client: WrappedClient;
  store: Store;
  image: Buffer;
  prompt: string;
  params?: Record<string, unknown>;
  families?: Family[];
  onPoint?: (family: Family, p: DriftPoint) => void;
}): Promise<DriftResult> {
  const { client, store, image, prompt, params } = opts;
  const families = opts.families ?? FAMILIES;
  const before = { ...client.stats };
  const h0 = await dhash(image);
  const base = await client.call({ prompt, images: [image], params });
  const result: DriftResult = {
    driftId: 'drift_' + randomUUID().slice(0, 8),
    sourceSha: sha256(image),
    prompt,
    model: client.adapter.model,
    requestKey: requestKeyFor(client.adapter, { prompt, params }),
    baseline: base.output,
    families: [],
    liveCalls: 0,
    cachedCalls: 0,
    createdAt: new Date().toISOString(),
  };
  for (const family of families) {
    const points: DriftPoint[] = [];
    for (const [step, s] of LADDERS[family].entries()) {
      const img = await perturb(image, s);
      const distance = hamming(h0, await dhash(img));
      const r = await client.call({ prompt, images: [img], params });
      const p: DriftPoint = {
        label: s.label,
        value: s.value,
        step,
        distance,
        change: diffOutputs(base.output, r.output).score,
        items: itemNames(r.output),
        cache: r.meta.cache,
      };
      points.push(p);
      opts.onPoint?.(family, p);
    }
    const tip = points.find((p) => p.change > 0);
    result.families.push({
      family,
      points,
      tippingPoint: tip ? { label: tip.label, distance: tip.distance, change: tip.change } : null,
    });
  }
  result.liveCalls = client.stats.live - before.live;
  result.cachedCalls = client.stats.exact + client.stats.near - before.exact - before.near;

  store.insertDriftPoints(
    result.families.flatMap((f) =>
      f.points.map((p) => ({
        drift_id: result.driftId,
        family: f.family,
        label: p.label,
        value: p.value,
        step: p.step,
        distance: p.distance,
        change: p.change,
        model: result.model,
        request_key: result.requestKey,
        source_sha: result.sourceSha,
      })),
    ),
  );
  const dir = path.join(store.dataDir, 'drift');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${result.driftId}.json`), JSON.stringify(result, null, 2));
  return result;
}

export function listDriftResults(dataDir: string): DriftResult[] {
  const dir = path.join(dataDir, 'drift');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as DriftResult)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
