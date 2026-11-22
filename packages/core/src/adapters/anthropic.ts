import type { StructuredOutput, VisionAdapter, VisionRequest, VisionResponse } from '../types.js';
import { mediaType } from '../image.js';

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens: number; output_tokens: number };
  error?: { message: string };
}

/** Pull the first JSON object out of model text (models sometimes wrap JSON in prose or fences). */
export function extractJson(text: string): StructuredOutput {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { items: [], reasoning: text.slice(0, 200) };
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<StructuredOutput>;
    return { ...parsed, items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch {
    return { items: [], reasoning: 'unparseable model output' };
  }
}

/**
 * Anthropic Messages API adapter (plain fetch, no SDK). Not exercised in CI:
 * everything defaults to the mock adapter unless ANTHROPIC_API_KEY is set.
 */
export function anthropicAdapter(opts: {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  pricing?: { inputPerMTok: number; outputPerMTok: number };
}): VisionAdapter {
  const model = opts.model ?? 'claude-sonnet-5-5';
  return {
    name: 'anthropic',
    model,
    pricing: opts.pricing ?? { inputPerMTok: 3, outputPerMTok: 15 },
    async call(req: VisionRequest): Promise<VisionResponse> {
      const content = [
        ...req.images.map((img) => ({
          type: 'image',
          source: { type: 'base64', media_type: mediaType(img), data: img.toString('base64') },
        })),
        { type: 'text', text: req.prompt },
      ];
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': opts.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: opts.maxTokens ?? 1024,
          temperature: 0,
          ...(req.params ?? {}),
          messages: [{ role: 'user', content }],
        }),
      });
      const body = (await res.json()) as AnthropicResponse;
      if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${body.error?.message ?? 'unknown error'}`);
      const rawText = (body.content ?? []).map((c) => c.text ?? '').join('');
      return {
        output: extractJson(rawText),
        rawText,
        tokens: { input: body.usage?.input_tokens ?? 0, output: body.usage?.output_tokens ?? 0 },
      };
    },
  };
}
