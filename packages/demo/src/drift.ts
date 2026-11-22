import { wrapClient, runDrift, renderWardrobe, computeCalibration, saveCalibration, FITCHECK_PROMPT } from '@pixelblame/core';
import { adapter, store, h, DATA } from './common.js';

// Calibrate on two clean wardrobe photos. (See README: adding the "festival" photo turns
// near matching OFF, because a blur there changes the output at dHash distance 0.)
const photos = ['office', 'weekend']; // weekend last so the UI shows it by default
const ids: string[] = [];
for (const name of photos) {
  h(`Drift Map on the "${name}" photo`);
  const runId = store.createRun(`Drift: ${name}`, 'drift');
  const client = wrapClient(adapter, { store, runId, cache: 'exact' });
  const res = await runDrift({ client, store, image: await renderWardrobe(name), prompt: FITCHECK_PROMPT });
  await client.flush();
  ids.push(res.driftId);
  for (const f of res.families) {
    const pts = f.points.map((p) => `${p.label}:d${p.distance}${p.change > 0 ? `/Δ${p.change.toFixed(2)}` : ''}`).join('  ');
    console.log(`  ${f.family.padEnd(10)} ${pts}`);
    console.log(`  ${''.padEnd(10)} → ${f.tippingPoint ? `tipping point ${f.tippingPoint.label} at distance ${f.tippingPoint.distance}` : 'never changed'}`);
  }
  console.log(`  ${res.driftId}: ${res.liveCalls} live calls, ${res.cachedCalls} cached`);
}

h('Calibrating the near-match cache');
const cal = computeCalibration(store.driftPoints(ids), 1);
const p = saveCalibration(DATA, cal);
console.log(`  ${cal.points} points → threshold ${cal.threshold === null ? 'OFF' : cal.threshold}`);
console.log(`  ${cal.note}`);
console.log(`  wrote ${p}`);
console.log('\nNext: npm run demo:near');
