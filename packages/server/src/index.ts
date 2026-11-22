import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, listDriftResults, listBlameResults, loadCalibration, type CallRow } from '@pixelblame/core';

const here = path.dirname(fileURLToPath(import.meta.url));

function callView(row: CallRow) {
  const res = row.response ? (JSON.parse(row.response) as { output: { items: unknown[]; reasoning?: string } }) : null;
  return {
    id: row.id,
    seq: row.seq,
    adapter: row.adapter,
    model: row.model,
    prompt: row.prompt,
    images: JSON.parse(row.image_hashes) as string[],
    dhashes: JSON.parse(row.image_dhashes) as string[],
    output: res?.output ?? null,
    latencyMs: row.latency_ms,
    tokens: { input: row.tokens_in, output: row.tokens_out },
    cache: row.cache,
    distance: row.cache_distance,
    threshold: row.cache_threshold,
    cachedFrom: row.cached_from,
    error: row.error,
    createdAt: row.created_at,
  };
}

export function createApp(dataDir: string) {
  const store = new Store(dataDir);
  const app = express();

  app.get('/api/summary', (_req, res) => {
    const counts = store.db
      .prepare(`SELECT cache, COUNT(*) AS n, SUM(tokens_in + tokens_out) AS tokens FROM calls GROUP BY cache`)
      .all() as Array<{ cache: string; n: number; tokens: number | null }>;
    res.json({ counts, calibration: loadCalibration(dataDir), runs: store.listRuns().length });
  });

  app.get('/api/runs', (_req, res) => res.json(store.listRuns()));

  app.get('/api/runs/:id', (req, res) => {
    const run = store.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'run not found' });
    res.json({ run, calls: store.callsForRun(run.id).map(callView) });
  });

  app.get('/api/blobs/:sha', (req, res) => {
    if (!/^[a-f0-9]{64}$/.test(req.params.sha)) return res.status(400).end();
    const blob = store.getBlob(req.params.sha);
    if (!blob) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(blob.path);
  });

  app.get('/api/drift', (_req, res) => res.json({ results: listDriftResults(dataDir), calibration: loadCalibration(dataDir) }));

  app.get('/api/blame', (_req, res) =>
    res.json(
      listBlameResults(dataDir).map((b) => ({
        blameId: b.blameId,
        createdAt: b.createdAt,
        grid: b.grid,
        items: b.items.length,
        liveCalls: b.liveCalls,
        cachedCalls: b.cachedCalls,
        budgetExhausted: b.budgetExhausted,
      })),
    ),
  );

  app.get('/api/blame/:id', (req, res) => {
    const b = listBlameResults(dataDir).find((x) => x.blameId === req.params.id);
    if (!b) return res.status(404).json({ error: 'blame result not found' });
    res.json(b);
  });

  app.use(express.static(path.join(here, '..', 'public')));
  return { app, store };
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  const dataDir = path.resolve(process.env.PIXELBLAME_DATA ?? 'data');
  const port = Number(process.env.PORT ?? 4317);
  const { app } = createApp(dataDir);
  app.listen(port, () => {
    console.log(`PixelBlame UI → http://localhost:${port}  (data: ${path.relative(process.cwd(), dataDir) || '.'})`);
  });
}
