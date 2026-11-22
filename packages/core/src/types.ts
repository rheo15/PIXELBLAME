export interface OutputItem {
  name: string;
  category: string;
  color: string;
}

/** Structured output the tools reason about. Extra fields are kept but ignored by the diff. */
export interface StructuredOutput {
  items: OutputItem[];
  reasoning?: string;
  [key: string]: unknown;
}

export interface VisionRequest {
  prompt: string;
  images: Buffer[];
  params?: Record<string, unknown>;
}

export interface TokenUsage {
  input: number;
  output: number;
}

export interface VisionResponse {
  output: StructuredOutput;
  rawText: string;
  tokens: TokenUsage;
}

export interface VisionAdapter {
  /** Provider name, e.g. "mock" or "anthropic". */
  readonly name: string;
  /** Model identifier; part of the cache key and of calibration validity. */
  readonly model: string;
  call(req: VisionRequest): Promise<VisionResponse>;
  /** USD per million tokens, used only for estimates. */
  readonly pricing: { inputPerMTok: number; outputPerMTok: number };
}

export type CacheMode = 'live' | 'exact' | 'near';

export interface CallMeta {
  callId: string;
  cache: CacheMode;
  /** For near hits: dHash Hamming distance and the threshold that allowed it. */
  distance?: number;
  threshold?: number;
  cachedFrom?: string;
  latencyMs: number;
}

export interface WrappedResult extends VisionResponse {
  meta: CallMeta;
}
