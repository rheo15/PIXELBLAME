import type { VisionAdapter } from '../types.js';
import { mockAdapter } from './mock.js';
import { anthropicAdapter } from './anthropic.js';

export { mockAdapter, readCells } from './mock.js';
export { anthropicAdapter, extractJson } from './anthropic.js';

/** Mock by default; Anthropic only when ANTHROPIC_API_KEY is set and PIXELBLAME_ADAPTER isn't "mock". */
export function adapterFromEnv(env: NodeJS.ProcessEnv = process.env): VisionAdapter {
  const key = env.ANTHROPIC_API_KEY;
  if (key && env.PIXELBLAME_ADAPTER !== 'mock') {
    const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);
    return anthropicAdapter({
      apiKey: key,
      model: env.PIXELBLAME_MODEL || undefined,
      pricing: { inputPerMTok: num(env.PIXELBLAME_PRICE_IN, 3), outputPerMTok: num(env.PIXELBLAME_PRICE_OUT, 15) },
    });
  }
  return mockAdapter();
}
