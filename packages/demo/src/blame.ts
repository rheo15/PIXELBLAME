import { wrapClient, runBlame, renderWardrobe, FITCHECK_PROMPT } from '@pixelblame/core';
import { main } from '@pixelblame/core/dist/cli.js';
import { adapter, store, h, DATA, asciiHeat } from './common.js';

h('Budget guard: blame the "office" photo with --max-calls 10');
{
  const client = wrapClient(adapter, { store, runId: store.createRun('Blame: office (budget 10)', 'blame'), cache: 'exact' });
  const r = await runBlame({ client, image: await renderWardrobe('office'), prompt: FITCHECK_PROMPT, maxCalls: 10, dataDir: DATA });
  await client.flush();
  console.log(`  stopped after ${r.liveCalls} live calls (budget ${r.maxCalls}); exhausted=${r.budgetExhausted}`);
  console.log(`  items left unexplained: ${r.items.filter((i) => !i.minimal.proven).map((i) => i.name).join(', ') || 'none'}`);
}

h('Dry run: estimate before spending');
await main(['blame', 'fitcheck:weekend', '--dry-run']);

h('Image Blame on the "weekend" photo (4x4 grid, budget 40)');
const image = await renderWardrobe('weekend');
const client = wrapClient(adapter, { store, runId: store.createRun('Blame: weekend', 'blame'), cache: 'exact' });
const r = await runBlame({ client, image, prompt: FITCHECK_PROMPT, grid: 4, maxCalls: 40, dataDir: DATA, log: (m) => console.log('  ' + m) });
await client.flush();
for (const it of r.items) {
  console.log(`\n  ${it.name} — minimal region cells [${it.minimal.cells.join(', ')}] via ${it.minimal.method}${it.minimal.proven ? '' : ' (not proven)'}`);
  console.log(asciiHeat(it.heat, r.grid, it.minimal.cells));
}
console.log(`\n  ${r.blameId}: ${r.liveCalls} live calls, ${r.cachedCalls} cached, ${r.masksTested} masks`);

h('Same blame again: every mask is already cached');
const again = wrapClient(adapter, { store, runId: store.createRun('Blame: weekend (re-run)', 'blame'), cache: 'exact' });
const r2 = await runBlame({ client: again, image, prompt: FITCHECK_PROMPT, grid: 4, maxCalls: 40 });
await again.flush();
console.log(`  live calls: ${r2.liveCalls}, cache hits: ${r2.cachedCalls} (identical result: ${JSON.stringify(r2.items.map((i) => i.minimal.cells)) === JSON.stringify(r.items.map((i) => i.minimal.cells))})`);
console.log('\nOpen the UI: npm run dev → http://localhost:4317/#/blame');
