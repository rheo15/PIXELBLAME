import { main } from '@pixelblame/core/dist/cli.js';
import { replayRun } from '@pixelblame/core';
import { adapter, store, h } from './common.js';

h(`FitCheck: recording 3 scenarios (adapter: ${adapter.name})`);
await main(['record']);

const run = store.listRuns().find((r) => r.kind === 'record');
if (run) {
  h(`Replaying ${run.id} from the recording`);
  let calls = 0;
  const spy = { ...adapter, call: async (...a: Parameters<typeof adapter.call>) => (calls++, adapter.call(...a)) };
  const steps = await replayRun(store, spy, run.id);
  console.log(`${steps.filter((s) => s.ok).length}/${steps.length} steps identical, model calls during replay: ${calls}`);
}
console.log('\nNext: npm run demo:drift   (then npm run dev to browse runs)');
