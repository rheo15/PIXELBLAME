import sharp from 'sharp';
import { wrapClient, renderWardrobe, dhash, hamming, sha256, diffOutputs, loadCalibration, FITCHECK_PROMPT, type WrappedResult } from '@pixelblame/core';
import { badge } from '@pixelblame/core/dist/cli.js';
import { adapter, store, h, DATA } from './common.js';

const cal = loadCalibration(DATA);
if (!cal || cal.threshold === null) {
  console.log(cal ? `Calibration has near matching OFF (${cal.note}).` : 'No calibration yet: near matching is OFF.');
  console.log('Run npm run demo:drift first.');
  process.exit(1);
}
const runId = store.createRun('Near-match demo', 'near');
const client = wrapClient(adapter, { store, runId });
const show = (label: string, r: WrappedResult) => console.log(`  ${label.padEnd(30)} [${badge(r)}]  ${r.output.items.map((i) => i.name).join(', ')}`);

h(`Calibrated threshold: ${cal.threshold} (${cal.note})`);
const original = await renderWardrobe('weekend');
const base = await client.call({ prompt: FITCHECK_PROMPT, images: [original] });
show('original PNG', base);

h('Same photo re-saved at 60% size, JPEG quality 60');
const resaved = await sharp(original).resize(288).jpeg({ quality: 60 }).toBuffer();
const d1 = hamming(await dhash(original), await dhash(resaved));
console.log(`  bytes: ${original.length} → ${resaved.length}; SHA-256 ${sha256(original).slice(0, 10)} vs ${sha256(resaved).slice(0, 10)} (exact match impossible)`);
console.log(`  dHash distance ${d1} ≤ threshold ${cal.threshold}`);
const r1 = await client.call({ prompt: FITCHECK_PROMPT, images: [resaved] });
show('re-saved JPEG', r1);

h('Heavy blur (σ24) — should be REJECTED by the near matcher');
const blurred = await sharp(original).blur(24).png().toBuffer();
const d2 = hamming(await dhash(original), await dhash(blurred));
console.log(`  dHash distance ${d2} > threshold ${cal.threshold} → not a near match`);
const r2 = await client.call({ prompt: FITCHECK_PROMPT, images: [blurred] });
show('blurred', r2);
const d = diffOutputs(base.output, r2.output);
if (r2.meta.cache === 'near') {
  console.log(`  (near hit against a different recorded image at d=${r2.meta.distance}, not the original)`);
} else if (r2.meta.cache === 'exact') {
  console.log('  (near matcher rejected it; served by the exact cache from an earlier run of this demo)');
}
console.log(`  output change vs original: ${d.score} (removed: ${d.removed.join(', ') || 'none'})`);
console.log(`  → serving the original's cached answer here would have been wrong; rejecting it was correct.`);
await client.flush();
console.log(`\nThis run: live ${client.stats.live}, exact ${client.stats.exact}, near ${client.stats.near}, tokens saved ${client.stats.tokensSaved}`);
console.log('Next: npm run demo:blame');
