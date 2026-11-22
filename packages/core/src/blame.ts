import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256 } from './dhash.js';
import { diffOutputs, normalizeName } from './diff.js';
import { occlude, imageSize, type FillMode } from './image.js';
import { ReplayMissError, type WrappedClient } from './client.js';
import type { OutputItem, StructuredOutput, VisionAdapter } from './types.js';

export class BudgetExhausted extends Error {
  constructor() {
    super('call budget exhausted');
  }
}

/**
 * Delta debugging (Zeller's ddmin), generic so it can be tested on a synthetic oracle.
 * Returns a 1-minimal subset of `items` for which `test` is true (removing any single
 * element makes it false), assuming test(items) is true. If `test` throws
 * BudgetExhausted, returns the smallest failing set found so far with complete=false.
 */
export async function ddmin<T>(items: T[], test: (subset: T[]) => Promise<boolean>): Promise<{ set: T[]; complete: boolean }> {
  let C = [...items];
  let n = 2;
  try {
    while (C.length >= 2) {
      const size = Math.ceil(C.length / n);
      const chunks: T[][] = [];
      for (let i = 0; i < C.length; i += size) chunks.push(C.slice(i, i + size));
      let reduced = false;
      for (const chunk of chunks) {
        if (await test(chunk)) {
          C = chunk;
          n = 2;
          reduced = true;
          break;
        }
      }
      if (!reduced && chunks.length > 2) {
        for (const chunk of chunks) {
          const complement = C.filter((x) => !chunk.includes(x));
          if (await test(complement)) {
            C = complement;
            n = Math.max(n - 1, 2);
            reduced = true;
            break;
          }
        }
      }
      if (!reduced) {
        if (n >= C.length) break;
        n = Math.min(n * 2, C.length);
      }
    }
    return { set: C, complete: true };
  } catch (e) {
    if (e instanceof BudgetExhausted) return { set: C, complete: false };
    throw e;
  }
}

/**
 * Ridge regression with an unpenalized intercept: minimize |Xw + b - y|² + λ|w|².
 * Solved via normal equations with Gaussian elimination (features ≤ 64, so this is tiny).
 */
export function ridge(X: number[][], y: number[], lambda: number): number[] {
  const p = X[0]?.length ?? 0;
  if (!X.length || !p) return new Array<number>(p).fill(0);
  const m = X.length;
  // center columns and y so the intercept drops out
  const xMean = Array.from({ length: p }, (_, j) => X.reduce((s, r) => s + r[j]!, 0) / m);
  const yMean = y.reduce((s, v) => s + v, 0) / m;
  const A = Array.from({ length: p }, () => new Array<number>(p + 1).fill(0));
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < p; j++) {
      const xj = X[i]![j]! - xMean[j]!;
      A[j]![p]! += xj * (y[i]! - yMean);
      for (let k = 0; k < p; k++) A[j]![k]! += xj * (X[i]![k]! - xMean[k]!);
    }
  }
  for (let j = 0; j < p; j++) A[j]![j]! += lambda;
  for (let col = 0; col < p; col++) {
    let piv = col;
    for (let r = col + 1; r < p; r++) if (Math.abs(A[r]![col]!) > Math.abs(A[piv]![col]!)) piv = r;
    [A[col], A[piv]] = [A[piv]!, A[col]!];
    const d = A[col]![col]!;
    if (Math.abs(d) < 1e-12) continue;
    for (let r = 0; r < p; r++) {
      if (r === col) continue;
      const f = A[r]![col]! / d;
      if (f === 0) continue;
      for (let k = col; k <= p; k++) A[r]![k]! -= f * A[col]![k]!;
    }
  }
  return A.map((row, j) => (Math.abs(row[j]!) < 1e-12 ? 0 : row[p]! / row[j]!));
}

export interface BlameItem extends OutputItem {
  key: string;
  /** Per-cell attribution in [0, 1], row-major, normalized per item. */
  heat: number[];
  /** Cells whose occlusion alone removes the item. */
  singleCells: number[];
  minimal: { cells: number[]; proven: boolean; method: 'single-cell' | 'ddmin' | 'none' };
}

export interface BlameResult {
  blameId: string;
  imageSha: string;
  width: number;
  height: number;
  prompt: string;
  model: string;
  grid: number;
  fill: FillMode;
  maxCalls: number;
  liveCalls: number;
  cachedCalls: number;
  masksTested: number;
  budgetExhausted: boolean;
  baseline: StructuredOutput;
  items: BlameItem[];
  /** Masks where the fill itself made the model report something new. */
  fillArtifacts: Array<{ cells: number[]; added: string[] }>;
  createdAt: string;
}

export interface BlameEstimate {
  baseline: number;
  singleCell: number;
  ddminTypical: number;
  total: number;
  cappedAt: number;
  costPerCallUsd: number;
  costUsd: number;
  tokensPerCall: number;
}

/** Rough per-call token estimate for an image request (Anthropic-style w*h/750, long edge capped). */
export function estimateTokens(width: number, height: number, prompt: string): number {
  const scale = Math.min(1, 1568 / Math.max(width, height, 1));
  return Math.ceil((width * scale * height * scale) / 750) + Math.ceil(prompt.length / 4) + 150;
}

export function estimateBlame(opts: {
  grid: number;
  maxCalls: number;
  itemsGuess: number;
  width: number;
  height: number;
  prompt: string;
  pricing: VisionAdapter['pricing'];
}): BlameEstimate {
  const cells = opts.grid * opts.grid;
  // Assume ~1 in 4 items needs ddmin and spans ~2 cells: ~2·k·log2(cells/k) tests each (upper-ish bound).
  const k = 2;
  const ddminTypical = Math.max(opts.itemsGuess > 0 ? 1 : 0, Math.round(opts.itemsGuess / 4)) * Math.ceil(2 * k * Math.log2(cells / k));
  const uncapped = 1 + cells + ddminTypical;
  const total = Math.min(uncapped, opts.maxCalls);
  const tokensPerCall = estimateTokens(opts.width, opts.height, opts.prompt);
  const costPerCallUsd = ((tokensPerCall - 150) * opts.pricing.inputPerMTok + 150 * opts.pricing.outputPerMTok) / 1e6;
  return { baseline: 1, singleCell: cells, ddminTypical, total: uncapped, cappedAt: total, costPerCallUsd, costUsd: costPerCallUsd * total, tokensPerCall };
}

/**
 * Black-box Image Blame. Phase 1: baseline. Phase 2: occlude each grid cell alone.
 * Phase 3: for items no single cell explains, ddmin over all cells to find a minimal
 * set whose joint occlusion removes the item. Every mask goes through the client's
 * exact cache, so masks shared across items (and across runs) cost nothing.
 */
export async function runBlame(opts: {
  client: WrappedClient;
  image: Buffer;
  prompt: string;
  params?: Record<string, unknown>;
  grid?: number;
  maxCalls?: number;
  fill?: FillMode;
  dataDir?: string;
  log?: (msg: string) => void;
}): Promise<BlameResult> {
  const { client, image, prompt, params } = opts;
  const n = opts.grid ?? 4;
  const maxCalls = opts.maxCalls ?? 40;
  const fill = opts.fill ?? 'mean';
  const log = opts.log ?? (() => {});
  const cells = Array.from({ length: n * n }, (_, i) => i);
  const startLive = client.stats.live;
  const startCached = client.stats.exact + client.stats.near;
  const observed = new Map<string, { cells: number[]; output: StructuredOutput }>();
  let budgetExhausted = false;

  async function maskOutput(maskCells: number[]): Promise<StructuredOutput> {
    const sorted = [...new Set(maskCells)].sort((a, b) => a - b);
    const key = sorted.join(',');
    const seen = observed.get(key);
    if (seen) return seen.output;
    const img = await occlude(image, sorted, n, fill);
    const liveUsed = client.stats.live - startLive;
    let out: StructuredOutput;
    if (liveUsed >= maxCalls) {
      // Out of budget: a mask is still free if it is already cached.
      try {
        out = (await client.call({ prompt, images: [img], params }, { cacheOnly: true })).output;
      } catch (e) {
        if (e instanceof ReplayMissError) {
          budgetExhausted = true;
          throw new BudgetExhausted();
        }
        throw e;
      }
    } else {
      out = (await client.call({ prompt, images: [img], params })).output;
    }
    observed.set(key, { cells: sorted, output: out });
    return out;
  }

  const hasItem = (o: StructuredOutput, key: string) => (o.items ?? []).some((it) => normalizeName(it.name) === key);

  const baseline = await maskOutput([]).catch((e) => {
    if (e instanceof BudgetExhausted) throw new Error('--max-calls is too small for even the baseline call');
    throw e;
  });
  const baseItems = (baseline.items ?? []).map((it) => ({ ...it, key: normalizeName(it.name) }));
  log(`baseline: ${baseItems.map((i) => i.name).join(', ') || '(no items)'}`);

  // Phase 2: single-cell occlusion
  const singleRemoves = new Map<string, number[]>(baseItems.map((i) => [i.key, []]));
  for (const c of cells) {
    try {
      const out = await maskOutput([c]);
      for (const it of baseItems) if (!hasItem(out, it.key)) singleRemoves.get(it.key)!.push(c);
    } catch (e) {
      if (e instanceof BudgetExhausted) break;
      throw e;
    }
  }
  log(`single-cell phase done (${client.stats.live - startLive} live calls so far)`);

  // Phase 3: minimal sets
  const minimal = new Map<string, BlameItem['minimal']>();
  for (const it of baseItems) {
    const singles = singleRemoves.get(it.key)!;
    if (singles.length) {
      minimal.set(it.key, { cells: [singles[0]!], proven: true, method: 'single-cell' });
      continue;
    }
    if (budgetExhausted) {
      minimal.set(it.key, { cells: [], proven: false, method: 'none' });
      continue;
    }
    const test = async (subset: number[]) => !hasItem(await maskOutput(subset), it.key);
    try {
      if (!(await test(cells))) {
        minimal.set(it.key, { cells: [], proven: true, method: 'none' }); // occluding everything doesn't remove it
        continue;
      }
    } catch (e) {
      if (!(e instanceof BudgetExhausted)) throw e;
      minimal.set(it.key, { cells: [], proven: false, method: 'none' });
      continue;
    }
    const r = await ddmin(cells, test);
    minimal.set(it.key, { cells: [...r.set].sort((a, b) => a - b), proven: r.complete, method: 'ddmin' });
    log(`ddmin ${it.name}: cells [${r.set.join(', ')}]${r.complete ? '' : ' (budget hit, not proven minimal)'}`);
  }

  // Attribution: ridge regression of item loss on "cell was masked" over every mask tested
  // (LIME-style). Unlike a raw conditional average, this separates cells that were
  // only ever masked together with the real cause.
  const masks = [...observed.values()];
  const items: BlameItem[] = baseItems.map((it) => {
    const loss = (o: StructuredOutput) => {
      if (!hasItem(o, it.key)) return 1;
      const d = diffOutputs({ items: [it] }, { items: (o.items ?? []).filter((x) => normalizeName(x.name) === it.key) });
      return d.changed.length ? 0.5 : 0;
    };
    const X = masks.map((m) => cells.map((c) => (m.cells.includes(c) ? 1 : 0)));
    const y = masks.map((m) => loss(m.output));
    const raw = ridge(X, y, 0.05).map((w) => Math.max(0, w));
    const max = Math.max(...raw, 0);
    return {
      ...it,
      heat: raw.map((v) => (max > 1e-6 ? Number((v / max).toFixed(3)) : 0)),
      singleCells: singleRemoves.get(it.key)!,
      minimal: minimal.get(it.key)!,
    };
  });

  const baseKeys = new Set(baseItems.map((i) => i.key));
  const fillArtifacts = masks
    .map((m) => ({ cells: m.cells, added: (m.output.items ?? []).map((x) => normalizeName(x.name)).filter((k) => !baseKeys.has(k)) }))
    .filter((a) => a.added.length > 0);

  const { width, height } = await imageSize(image);
  const result: BlameResult = {
    blameId: 'blame_' + randomUUID().slice(0, 8),
    imageSha: sha256(image),
    width,
    height,
    prompt,
    model: client.adapter.model,
    grid: n,
    fill,
    maxCalls,
    liveCalls: client.stats.live - startLive,
    cachedCalls: client.stats.exact + client.stats.near - startCached,
    masksTested: observed.size,
    budgetExhausted,
    baseline,
    items,
    fillArtifacts,
    createdAt: new Date().toISOString(),
  };
  if (opts.dataDir) {
    const dir = path.join(opts.dataDir, 'blame');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${result.blameId}.json`), JSON.stringify(result, null, 2));
  }
  return result;
}

export function listBlameResults(dataDir: string): BlameResult[] {
  const dir = path.join(dataDir, 'blame');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as BlameResult)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
