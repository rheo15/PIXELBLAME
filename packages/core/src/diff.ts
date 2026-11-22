import type { OutputItem, StructuredOutput } from './types.js';

export interface ItemChange {
  name: string;
  fields: Array<{ field: 'category' | 'color'; before: string; after: string }>;
}

export interface ItemDiff {
  added: string[];
  removed: string[];
  changed: ItemChange[];
  reordered: boolean;
  /** 0 = identical, 1 = nothing in common. */
  score: number;
}

/** Penalty added when the common items appear in a different order. */
export const REORDER_PENALTY = 0.05;
/** A changed item counts as this fraction of a full mismatch in the score. */
export const CHANGED_WEIGHT = 0.5;

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function index(items: OutputItem[]): Map<string, OutputItem> {
  const m = new Map<string, OutputItem>();
  for (const it of items) {
    const k = normalizeName(it.name);
    if (!m.has(k)) m.set(k, it);
  }
  return m;
}

/**
 * Compare two outputs as sets of items keyed by name.
 * score = 1 - weightedJaccard + reorder penalty, clamped to [0, 1], where a
 * changed item contributes (1 - CHANGED_WEIGHT) to the intersection.
 */
export function diffOutputs(a: StructuredOutput, b: StructuredOutput): ItemDiff {
  const A = index(a.items ?? []);
  const B = index(b.items ?? []);
  const added = [...B.keys()].filter((k) => !A.has(k));
  const removed = [...A.keys()].filter((k) => !B.has(k));
  const common = [...A.keys()].filter((k) => B.has(k));

  const changed: ItemChange[] = [];
  for (const k of common) {
    const x = A.get(k)!;
    const y = B.get(k)!;
    const fields: ItemChange['fields'] = [];
    for (const f of ['category', 'color'] as const) {
      const before = String(x[f] ?? '').toLowerCase();
      const after = String(y[f] ?? '').toLowerCase();
      if (before !== after) fields.push({ field: f, before, after });
    }
    if (fields.length) changed.push({ name: k, fields });
  }

  const orderA = [...A.keys()].filter((k) => B.has(k));
  const orderB = [...B.keys()].filter((k) => A.has(k));
  const reordered = orderA.some((k, i) => orderB[i] !== k);

  const union = new Set([...A.keys(), ...B.keys()]).size;
  let score = 0;
  if (union > 0) {
    const intersection = common.length - changed.length * CHANGED_WEIGHT;
    score = 1 - intersection / union;
    if (reordered) score += REORDER_PENALTY;
  }
  score = Math.min(1, Math.max(0, Number(score.toFixed(4))));
  return { added, removed, changed, reordered, score };
}

/** Item names present in the output, normalized. */
export function itemNames(o: StructuredOutput): string[] {
  return [...index(o.items ?? []).keys()];
}
