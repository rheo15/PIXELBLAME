import { describe, it, expect } from 'vitest';
import { diffOutputs, REORDER_PENALTY } from '../src/diff.js';

const it_ = (name: string, color = 'red', category = 'top') => ({ name, color, category });

describe('item diff', () => {
  it('identical outputs score 0', () => {
    const o = { items: [it_('red shirt'), it_('blue jacket', 'blue')] };
    expect(diffOutputs(o, structuredClone(o))).toEqual({ added: [], removed: [], changed: [], reordered: false, score: 0 });
  });
  it('reports added and removed items keyed by normalized name', () => {
    const d = diffOutputs({ items: [it_('Red  Shirt'), it_('green scarf')] }, { items: [it_('red shirt'), it_('pink sneakers')] });
    expect(d.added).toEqual(['pink sneakers']);
    expect(d.removed).toEqual(['green scarf']);
    expect(d.score).toBeCloseTo(1 - 1 / 3, 4); // 1 common of 3 in the union
  });
  it('reports changed fields', () => {
    const d = diffOutputs({ items: [it_('scarf', 'green', 'accessory')] }, { items: [it_('scarf', 'teal', 'accessory')] });
    expect(d.changed).toEqual([{ name: 'scarf', fields: [{ field: 'color', before: 'green', after: 'teal' }] }]);
    expect(d.score).toBeCloseTo(0.5, 4); // a changed item counts as half a mismatch
  });
  it('detects reordering and adds a small penalty', () => {
    const a = { items: [it_('a'), it_('b'), it_('c')] };
    const b = { items: [it_('c'), it_('a'), it_('b')] };
    const d = diffOutputs(a, b);
    expect(d.reordered).toBe(true);
    expect(d.score).toBeCloseTo(REORDER_PENALTY, 4);
  });
  it('change score math: disjoint = 1, empty vs empty = 0, clamped to [0,1]', () => {
    expect(diffOutputs({ items: [it_('a')] }, { items: [it_('b')] }).score).toBe(1);
    expect(diffOutputs({ items: [] }, { items: [] }).score).toBe(0);
    const d = diffOutputs({ items: [it_('a'), it_('b')] }, { items: [it_('b'), it_('a'), it_('x'), it_('y')] });
    expect(d.score).toBeCloseTo(1 - 2 / 4 + REORDER_PENALTY, 4);
  });
});
