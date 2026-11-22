#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  Store,
  wrapClient,
  adapterFromEnv,
  replayRun,
  runDrift,
  driftCallCount,
  computeCalibration,
  saveCalibration,
  runBlame,
  estimateBlame,
  imageSize,
  occlude,
  renderWardrobe,
  FITCHECK_PROMPT,
  SCENARIOS,
  FAMILIES,
  WARDROBES,
  type Family,
  type FillMode,
  type WrappedResult,
} from './index.js';

export function dataDir(): string {
  return path.resolve(process.env.PIXELBLAME_DATA ?? 'data');
}

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2) as [string, string | undefined];
      if (v !== undefined) out.flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1]!.startsWith('--')) out.flags[k] = argv[++i]!;
      else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

export function badge(r: WrappedResult): string {
  if (r.meta.cache === 'exact') return 'CACHE exact';
  if (r.meta.cache === 'near') return `CACHE near d=${r.meta.distance} (threshold ${r.meta.threshold})`;
  return 'LIVE';
}

/** Accepts a file path or "fitcheck:<wardrobe>" for a generated demo photo. */
export async function loadImage(spec: string): Promise<Buffer> {
  if (spec.startsWith('fitcheck:')) return renderWardrobe(spec.slice('fitcheck:'.length));
  if (!fs.existsSync(spec)) throw new Error(`image not found: ${spec}`);
  return fs.readFileSync(spec);
}

export function table(rows: Array<Record<string, string | number>>): string {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]!);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(w[i]!)).join('  ');
  return [line(cols), line(w.map((n) => '-'.repeat(n))), ...rows.map((r) => line(cols.map((c) => String(r[c] ?? ''))))].join('\n');
}

const HELP = `pixelblame — Image Blame and Drift Map for vision-model apps

  record [--scenario <name>]                 run FitCheck scenarios and record them
  runs                                       list recorded runs
  replay <runId>                             replay a run from recordings (no model calls)
  drift <runId|image> [--family jpeg,resize,blur,brightness,rotate,crop] [--prompt ".."] [--dry-run]
  calibrate [--drift id1,id2] [--margin 1]   set the near-match threshold from Drift Map data
  blame <image> [--prompt ".."] [--grid 4] [--max-calls 40] [--fill mean|blur] [--dry-run]

Images can be file paths or fitcheck:<${Object.keys(WARDROBES).join('|')}>.
Adapter: mock unless ANTHROPIC_API_KEY is set. Data dir: ${'$'}PIXELBLAME_DATA or ./data`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd || cmd === 'help' || args.flags.help) {
    console.log(HELP);
    return 0;
  }
  const store = new Store(dataDir());
  const adapter = adapterFromEnv();
  try {
    switch (cmd) {
      case 'record': {
        const only = typeof args.flags.scenario === 'string' ? args.flags.scenario.toLowerCase() : null;
        const client = wrapClient(adapter, { store });
        const photoDir = path.join(store.dataDir, 'photos');
        fs.mkdirSync(photoDir, { recursive: true });
        for (const sc of SCENARIOS) {
          if (only && !sc.name.toLowerCase().includes(only) && sc.wardrobe !== only) continue;
          const runId = store.createRun(`FitCheck: ${sc.name}`, 'record');
          client.setRun(runId);
          const img = await renderWardrobe(sc.wardrobe);
          fs.writeFileSync(path.join(photoDir, `${sc.wardrobe}.png`), img);
          const r = await client.call({ prompt: FITCHECK_PROMPT, images: [img] });
          console.log(`${runId}  ${sc.name.padEnd(16)} [${badge(r)}]  ${r.output.items.map((i) => i.name).join(', ')}`);
        }
        await client.flush();
        console.log(`\nadapter: ${adapter.name}/${adapter.model}; live ${client.stats.live}, exact ${client.stats.exact}, near ${client.stats.near}`);
        console.log(`photos saved to ${path.relative(process.cwd(), photoDir)}/`);
        return 0;
      }
      case 'runs': {
        const runs = store.listRuns();
        if (!runs.length) console.log('No runs yet. Try: pixelblame record');
        else console.log(table(runs.map((r) => ({ id: r.id, kind: r.kind, name: r.name, calls: r.call_count ?? 0, created: r.created_at }))));
        return 0;
      }
      case 'replay': {
        const runId = args._[1];
        if (!runId) throw new Error('usage: replay <runId>');
        let adapterCalls = 0;
        const spy = { ...adapter, call: async (...a: Parameters<typeof adapter.call>) => (adapterCalls++, adapter.call(...a)) };
        const steps = await replayRun(store, spy, runId);
        console.log(table(steps.map((s) => ({ seq: s.seq, call: s.callId, result: s.ok ? 'identical' : 'MISMATCH', score: s.changeScore, error: s.error ?? '' }))));
        console.log(`\n${steps.filter((s) => s.ok).length}/${steps.length} steps identical; model calls made: ${adapterCalls}`);
        return steps.every((s) => s.ok) ? 0 : 1;
      }
      case 'drift': {
        const target = args._[1];
        if (!target) throw new Error('usage: drift <runId|image> [--family ...]');
        const families = (typeof args.flags.family === 'string' ? args.flags.family.split(',') : FAMILIES).map((f) => f.trim()) as Family[];
        const bad = families.filter((f) => !FAMILIES.includes(f));
        if (bad.length) throw new Error(`unknown family: ${bad.join(', ')}`);
        let image: Buffer;
        let prompt = typeof args.flags.prompt === 'string' ? args.flags.prompt : FITCHECK_PROMPT;
        let params: Record<string, unknown> | undefined;
        if (store.getRun(target)) {
          const first = store.callsForRun(target)[0];
          if (!first) throw new Error(`run ${target} has no calls`);
          const blob = store.getBlob((JSON.parse(first.image_hashes) as string[])[0]!);
          if (!blob) throw new Error('first call has no stored image');
          image = blob.bytes;
          prompt = first.prompt;
          params = JSON.parse(first.params) as Record<string, unknown>;
        } else image = await loadImage(target);
        const calls = driftCallCount(families);
        console.log(`Drift Map: ${families.join(', ')} → up to ${calls} model calls (adapter ${adapter.name}/${adapter.model})`);
        if (args.flags['dry-run']) return 0;
        const runId = store.createRun(`Drift: ${path.basename(target)}`, 'drift');
        const client = wrapClient(adapter, { store, runId, cache: 'exact' });
        const res = await runDrift({ client, store, image, prompt, params, families });
        await client.flush();
        for (const f of res.families) {
          console.log(`\n${f.family}`);
          console.log(table(f.points.map((p) => ({ step: p.label, distance: p.distance, change: p.change.toFixed(2), cache: p.cache, items: p.items.join(', ') }))));
          console.log(f.tippingPoint ? `→ tipping point: ${f.tippingPoint.label} at distance ${f.tippingPoint.distance}` : '→ no output change in this ladder');
        }
        console.log(`\n${res.driftId}: ${res.liveCalls} live calls, ${res.cachedCalls} from cache. Next: pixelblame calibrate`);
        return 0;
      }
      case 'calibrate': {
        const ids = typeof args.flags.drift === 'string' ? args.flags.drift.split(',') : undefined;
        const margin = args.flags.margin !== undefined ? Number(args.flags.margin) : 1;
        const pts = store.driftPoints(ids);
        const c = computeCalibration(pts, margin);
        const p = saveCalibration(store.dataDir, c);
        console.log(`calibration from ${c.points} drift points (${c.driftIds.length} drift runs, models: ${c.models.join(', ') || '-'})`);
        console.log(c.threshold === null ? 'near matching: OFF' : `near-match threshold: ${c.threshold}`);
        console.log(c.note);
        console.log(`wrote ${path.relative(process.cwd(), p)}`);
        return 0;
      }
      case 'blame': {
        const target = args._[1];
        if (!target) throw new Error('usage: blame <image> [--grid 4] [--max-calls 40] [--dry-run]');
        const image = await loadImage(target);
        const prompt = typeof args.flags.prompt === 'string' ? args.flags.prompt : FITCHECK_PROMPT;
        const grid = Number(args.flags.grid ?? 4);
        const maxCalls = Number(args.flags['max-calls'] ?? 40);
        const fill = (args.flags.fill === 'blur' ? 'blur' : 'mean') as FillMode;
        if (!Number.isInteger(grid) || grid < 2 || grid > 8) throw new Error('--grid must be 2..8');
        if (!Number.isInteger(maxCalls) || maxCalls < 1) throw new Error('--max-calls must be a positive integer');
        const { width, height } = await imageSize(image);
        // If the baseline is already cached we know the real item count for free.
        let itemsGuess = 4;
        let itemsKnown = false;
        try {
          const peek = wrapClient(adapter, { store, mode: 'replay', calibration: null });
          const base = await peek.call({ prompt, images: [await occlude(image, [], grid, fill)] }, { cacheOnly: true });
          itemsGuess = base.output.items.length;
          itemsKnown = true;
        } catch {
          /* not cached: keep the guess */
        }
        const est = estimateBlame({ grid, maxCalls, itemsGuess, width, height, prompt, pricing: adapter.pricing });
        console.log(
          `Image Blame ${grid}x${grid} (${adapter.name}/${adapter.model}): ~${est.total} calls ` +
            `(1 baseline + ${est.singleCell} single-cell + ~${est.ddminTypical} ddmin), budget ${maxCalls}` +
            `\nestimated cost: ~$${est.costUsd.toFixed(4)} (${est.tokensPerCall} tokens/call; cached masks are free)` +
            `\n${itemsKnown ? `baseline cached: ${itemsGuess} items` : `assuming ~${itemsGuess} items (baseline not cached yet)`}`,
        );
        if (adapter.name === 'mock') {
          const ref = estimateBlame({ grid, maxCalls, itemsGuess, width, height, prompt, pricing: { inputPerMTok: 3, outputPerMTok: 15 } });
          console.log(`reference: the same run on a $3/$15-per-MTok model would cost ~$${ref.costUsd.toFixed(4)}`);
        }
        if (est.total > maxCalls) console.log(`note: estimate exceeds --max-calls; results may be partial`);
        if (args.flags['dry-run']) return 0;
        const runId = store.createRun(`Blame: ${path.basename(target)}`, 'blame');
        const client = wrapClient(adapter, { store, runId, cache: 'exact' });
        const res = await runBlame({ client, image, prompt, grid, maxCalls, fill, dataDir: store.dataDir, log: (m) => console.log('  ' + m) });
        await client.flush();
        console.log();
        console.log(
          table(
            res.items.map((it) => ({
              item: it.name,
              'minimal cells': it.minimal.cells.length ? it.minimal.cells.join(',') : '-',
              method: it.minimal.method,
              proven: it.minimal.proven ? 'yes' : 'no',
              'hottest cell': Math.max(...it.heat) > 0 ? it.heat.indexOf(Math.max(...it.heat)) : '-',
            })),
          ),
        );
        if (res.fillArtifacts.length) console.log(`\nwarning: the occlusion fill introduced new items in ${res.fillArtifacts.length} masks`);
        console.log(
          `\n${res.blameId}: ${res.liveCalls} live calls, ${res.cachedCalls} cached, ${res.masksTested} masks` +
            (res.budgetExhausted ? ' — BUDGET EXHAUSTED, some results partial' : ''),
        );
        return 0;
      }
      default:
        console.error(`unknown command "${cmd}"\n\n${HELP}`);
        return 2;
    }
  } finally {
    store.close();
  }
}

// Only run when executed directly, not when imported by tests or the demo.
const invoked = process.argv[1] ? fs.realpathSync(path.resolve(process.argv[1])) : '';
if (invoked.endsWith(path.join('core', 'dist', 'cli.js'))) {
  main()
    .then((code) => process.exit(code))
    .catch((e: Error) => {
      console.error('error:', e.message);
      process.exit(1);
    });
}
