import { wrapClient } from './client.js';
import { diffOutputs } from './diff.js';
import { Store } from './store.js';
import type { VisionAdapter } from './types.js';

export interface ReplayStep {
  seq: number;
  callId: string;
  ok: boolean;
  changeScore: number;
  error?: string;
}

/**
 * Re-run a recorded run from recordings only. Images are rebuilt from the blob store,
 * so this also checks that recordings are complete. The adapter is never called.
 */
export async function replayRun(store: Store, adapter: VisionAdapter, runId: string): Promise<ReplayStep[]> {
  const rows = store.callsForRun(runId);
  if (!rows.length) throw new Error(`no calls recorded for ${runId}`);
  const client = wrapClient(
    // the replay client must not depend on the live adapter's identity beyond name/model
    { ...adapter, name: rows[0]!.adapter, model: rows[0]!.model, call: () => Promise.reject(new Error('adapter called during replay')) },
    { store, mode: 'replay', calibration: null },
  );
  const steps: ReplayStep[] = [];
  for (const row of rows) {
    if (!row.response) {
      steps.push({ seq: row.seq, callId: row.id, ok: false, changeScore: 1, error: row.error ?? 'no response recorded' });
      continue;
    }
    try {
      const shas = JSON.parse(row.image_hashes) as string[];
      const images = shas.map((s) => {
        const b = store.getBlob(s);
        if (!b) throw new Error(`missing blob ${s.slice(0, 12)}`);
        return b.bytes;
      });
      const res = await client.call({ prompt: row.prompt, images, params: JSON.parse(row.params) as Record<string, unknown> });
      const score = diffOutputs(Store.output(row), res.output).score;
      steps.push({ seq: row.seq, callId: row.id, ok: score === 0, changeScore: score });
    } catch (e) {
      steps.push({ seq: row.seq, callId: row.id, ok: false, changeScore: 1, error: (e as Error).message });
    }
  }
  return steps;
}
