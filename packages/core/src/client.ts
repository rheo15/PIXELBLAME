import { randomUUID } from 'node:crypto';
import { dhash, hamming, sha256 } from './dhash.js';
import { imageSize, mediaType } from './image.js';
import { Store, type CallRow } from './store.js';
import { loadCalibration, nearThresholdFor, type Calibration } from './calibration.js';
import type { CallMeta, VisionAdapter, VisionRequest, VisionResponse, WrappedResult } from './types.js';

export type CachePolicy = 'off' | 'exact' | 'calibrated';

export interface WrapOptions {
  store: Store;
  runId?: string | null;
  /** off: always live. exact: SHA-256 only. calibrated (default): exact, then near if calibrated. */
  cache?: CachePolicy;
  /** replay: serve from recordings only; a miss throws and the adapter is never called. */
  mode?: 'record' | 'replay';
  /** Defaults to data/calibration.json in the store's data dir. */
  calibration?: Calibration | null;
  onError?: (err: unknown) => void;
}

export interface ClientStats {
  live: number;
  exact: number;
  near: number;
  tokensSaved: number;
  recordErrors: number;
}

export class ReplayMissError extends Error {
  constructor(key: string) {
    super(`replay miss: no recording for request ${key.slice(0, 12)}`);
  }
}

export interface WrappedClient {
  readonly adapter: VisionAdapter;
  /** cacheOnly: serve from cache or throw ReplayMissError, never calling the adapter. */
  call(req: VisionRequest, callOpts?: { cacheOnly?: boolean }): Promise<WrappedResult>;
  /** Resolves when all queued recording writes are done. */
  flush(): Promise<void>;
  stats: ClientStats;
  setRun(runId: string | null): void;
}

interface Hashed {
  shas: string[];
  dhashes: (string | null)[];
}

export function requestKeyFor(adapter: Pick<VisionAdapter, 'name' | 'model'>, req: Pick<VisionRequest, 'prompt' | 'params'>): string {
  return sha256(JSON.stringify({ a: adapter.name, m: adapter.model, p: req.prompt, o: req.params ?? {} }));
}

export function exactKeyFor(requestKey: string, shas: string[]): string {
  return sha256(requestKey + ':' + shas.join(','));
}

/**
 * Record every call and serve repeats from cache. Recording is best-effort:
 * any failure in hashing or writing is reported via onError and never breaks the call.
 */
export function wrapClient(adapter: VisionAdapter, opts: WrapOptions): WrappedClient {
  const { store } = opts;
  const policy = opts.cache ?? 'calibrated';
  const mode = opts.mode ?? 'record';
  const calibration = opts.calibration !== undefined ? opts.calibration : loadCalibration(store.dataDir);
  let runId = opts.runId ?? null;
  const stats: ClientStats = { live: 0, exact: 0, near: 0, tokensSaved: 0, recordErrors: 0 };
  // Responses not yet flushed to SQLite, so back-to-back identical calls still hit.
  const pending = new Map<string, { id: string; res: VisionResponse }>();
  const queue: Array<() => void> = [];
  let draining: Promise<void> | null = null;
  let seq: number | null = null;

  const report = (err: unknown) => {
    stats.recordErrors++;
    try {
      (opts.onError ?? ((e) => console.warn('[pixelblame] recording failed:', (e as Error).message)))(err);
    } catch {
      /* a throwing error handler must not break the call either */
    }
  };

  const drain = () => {
    if (draining) return draining;
    draining = new Promise<void>((resolve) => {
      setImmediate(() => {
        while (queue.length) {
          const job = queue.shift()!;
          try {
            job();
          } catch (e) {
            report(e);
          }
        }
        // everything pending is now in SQLite
        pending.clear();
        draining = null;
        resolve();
      });
    });
    return draining;
  };

  const enqueue = (job: () => void) => {
    queue.push(job);
    void drain();
  };

  const nextSeq = () => {
    try {
      if (seq === null) seq = store.nextSeq(runId);
    } catch (e) {
      report(e);
      seq = 0;
    }
    return seq++;
  };

  async function hashAll(images: Buffer[]): Promise<Hashed> {
    const shas = images.map((b) => sha256(b));
    const dhashes = await Promise.all(images.map((b) => dhash(b).catch(() => null)));
    return { shas, dhashes };
  }

  function record(
    req: VisionRequest,
    hashed: Hashed,
    keys: { request: string; exact: string },
    res: VisionResponse | null,
    meta: CallMeta,
    error: string | null,
  ) {
    const s = nextSeq();
    const rid = runId; // capture now: setRun may change it before the queue drains
    enqueue(() => {
      req.images.forEach((img, i) => {
        // dimensions are filled lazily below; store bytes first so replay always has them
        store.putBlob(hashed.shas[i]!, hashed.dhashes[i] ?? '0000000000000000', img, 0, 0, mediaType(img).split('/')[1]!);
      });
      const row: CallRow = {
        id: meta.callId,
        run_id: rid,
        seq: s,
        adapter: adapter.name,
        model: adapter.model,
        prompt: req.prompt,
        params: JSON.stringify(req.params ?? {}),
        image_hashes: JSON.stringify(hashed.shas),
        image_dhashes: JSON.stringify(hashed.dhashes),
        request_key: keys.request,
        exact_key: keys.exact,
        response: res ? JSON.stringify(res) : null,
        latency_ms: Math.round(meta.latencyMs),
        tokens_in: meta.cache === 'live' && res ? res.tokens.input : 0,
        tokens_out: meta.cache === 'live' && res ? res.tokens.output : 0,
        cache: meta.cache,
        cache_distance: meta.distance ?? null,
        cache_threshold: meta.threshold ?? null,
        cached_from: meta.cachedFrom ?? null,
        error,
        created_at: new Date().toISOString(),
      };
      store.insertCall(row);
    });
    // image dimensions are nice-to-have metadata; fill them in off the hot path
    req.images.forEach((img, i) =>
      imageSize(img)
        .then(({ width, height }) =>
          enqueue(() => store.db.prepare('UPDATE blobs SET width = ?, height = ? WHERE sha256 = ?').run(width, height, hashed.shas[i])),
        )
        .catch(() => {}),
    );
  }

  function lookupNear(requestKey: string, hashed: Hashed, threshold: number): { row: CallRow; distance: number } | null {
    if (hashed.dhashes.some((d) => d === null)) return null;
    let best: { row: CallRow; distance: number } | null = null;
    for (const row of store.candidatesForNear(requestKey)) {
      const ds = JSON.parse(row.image_dhashes) as (string | null)[];
      if (ds.length !== hashed.dhashes.length || ds.some((d) => d === null)) continue;
      // multi-image requests: every image must be close; the request distance is the worst pair
      const dist = Math.max(...ds.map((d, i) => hamming(d!, hashed.dhashes[i]!)));
      if (dist <= threshold && (!best || dist < best.distance)) best = { row, distance: dist };
    }
    return best;
  }

  async function call(req: VisionRequest, callOpts: { cacheOnly?: boolean } = {}): Promise<WrappedResult> {
    const cacheOnly = mode === 'replay' || !!callOpts.cacheOnly;
    const t0 = performance.now();
    let hashed: Hashed | null = null;
    let keys: { request: string; exact: string } | null = null;
    try {
      hashed = await hashAll(req.images);
      const request = requestKeyFor(adapter, req);
      keys = { request, exact: exactKeyFor(request, hashed.shas) };
    } catch (e) {
      report(e);
    }

    if (keys && hashed && (policy !== 'off' || cacheOnly)) {
      try {
        const mem = pending.get(keys.exact);
        const hit = mem
          ? { id: mem.id, res: mem.res }
          : (() => {
              const row = mode === 'replay' ? findAny(keys.exact) : store.findExact(keys.exact);
              return row ? { id: row.id, res: JSON.parse(row.response!) as VisionResponse } : null;
            })();
        if (hit) {
          const meta: CallMeta = { callId: 'call_' + randomUUID().slice(0, 8), cache: 'exact', cachedFrom: hit.id, latencyMs: performance.now() - t0 };
          stats.exact++;
          stats.tokensSaved += hit.res.tokens.input + hit.res.tokens.output;
          if (mode === 'record') record(req, hashed, keys, hit.res, meta, null);
          return { ...hit.res, meta };
        }
        const threshold = policy === 'calibrated' && mode === 'record' ? nearThresholdFor(calibration, adapter.model, keys.request) : null;
        if (threshold !== null) {
          const near = lookupNear(keys.request, hashed, threshold);
          if (near) {
            const res = JSON.parse(near.row.response!) as VisionResponse;
            const meta: CallMeta = {
              callId: 'call_' + randomUUID().slice(0, 8),
              cache: 'near',
              distance: near.distance,
              threshold,
              cachedFrom: near.row.id,
              latencyMs: performance.now() - t0,
            };
            stats.near++;
            stats.tokensSaved += res.tokens.input + res.tokens.output;
            record(req, hashed, keys, res, meta, null);
            return { ...res, meta };
          }
        }
      } catch (e) {
        report(e);
      }
    }

    if (cacheOnly) throw new ReplayMissError(keys?.exact ?? 'unhashable');

    const callId = 'call_' + randomUUID().slice(0, 8);
    let res: VisionResponse;
    try {
      res = await adapter.call(req);
    } catch (err) {
      if (keys && hashed) {
        try {
          record(req, hashed, keys, null, { callId, cache: 'live', latencyMs: performance.now() - t0 }, (err as Error).message);
        } catch (e) {
          report(e);
        }
      }
      throw err;
    }
    const meta: CallMeta = { callId, cache: 'live', latencyMs: performance.now() - t0 };
    stats.live++;
    if (keys && hashed) {
      try {
        pending.set(keys.exact, { id: callId, res });
        record(req, hashed, keys, res, meta, null);
      } catch (e) {
        report(e);
      }
    }
    return { ...res, meta };
  }

  function findAny(exactKey: string): CallRow | undefined {
    return store.db
      .prepare('SELECT * FROM calls WHERE exact_key = ? AND response IS NOT NULL AND error IS NULL ORDER BY created_at ASC LIMIT 1')
      .get(exactKey) as CallRow | undefined;
  }

  return {
    adapter,
    call,
    stats,
    async flush() {
      // image-size updates are enqueued asynchronously; loop until quiet
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setImmediate(r));
        await drain();
        if (!queue.length) break;
      }
    },
    setRun(id) {
      runId = id;
      seq = null;
    },
  };
}
