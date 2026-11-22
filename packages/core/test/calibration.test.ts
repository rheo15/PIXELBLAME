import { describe, it, expect } from 'vitest';
import { computeCalibration, nearThresholdFor } from '../src/calibration.js';

const pt = (distance: number, change: number) => ({ distance, change, model: 'm', request_key: 'k' });

describe('calibration', () => {
  it('picks the largest distance that never changed the output, minus the margin', () => {
    const c = computeCalibration([pt(0, 0), pt(1, 0), pt(4, 0), pt(5, 0), pt(6, 0.4), pt(9, 0), pt(30, 1)], 1);
    expect(c.firstChangeDistance).toBe(6);
    expect(c.safeMaxDistance).toBe(5); // distance 9 was unchanged but lies beyond the first change
    expect(c.threshold).toBe(4);
  });
  it('turns near matching off when there is no data, or a change at distance 0', () => {
    expect(computeCalibration([]).threshold).toBeNull();
    expect(computeCalibration([pt(0, 0), pt(0, 0.2), pt(3, 0)]).threshold).toBeNull();
    expect(nearThresholdFor(null, 'm', 'k')).toBeNull();
  });
  it('only applies to the models and requests it measured', () => {
    const c = computeCalibration([pt(2, 0), pt(5, 1)]);
    expect(nearThresholdFor(c, 'm', 'k')).toBe(1);
    expect(nearThresholdFor(c, 'other-model', 'k')).toBeNull();
    expect(nearThresholdFor(c, 'm', 'other-prompt')).toBeNull();
  });
});
