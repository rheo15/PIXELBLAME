import fs from 'node:fs';
import path from 'node:path';

export interface DriftObservation {
  distance: number;
  change: number;
  model: string;
  request_key: string;
  drift_id?: string;
}

export interface Calibration {
  version: 1;
  /** Max dHash distance accepted for a near hit, or null = near matching OFF. */
  threshold: number | null;
  margin: number;
  /** Largest distance at which no observation (at that distance or below) changed the output. */
  safeMaxDistance: number | null;
  /** Smallest distance at which some observation changed the output. */
  firstChangeDistance: number | null;
  /** Calibration only applies to these models and request keys (prompt + params + model). */
  models: string[];
  requestKeys: string[];
  driftIds: string[];
  points: number;
  createdAt: string;
  note: string;
}

/**
 * threshold = (largest distance d such that every observation with distance <= d
 * left the output unchanged) - margin. Anything that changed the output at a small
 * distance pulls the threshold down for everyone; if nothing is safe, near matching is off.
 */
export function computeCalibration(points: DriftObservation[], margin = 1): Calibration {
  const base = {
    version: 1 as const,
    margin,
    models: [...new Set(points.map((p) => p.model))].sort(),
    requestKeys: [...new Set(points.map((p) => p.request_key))].sort(),
    driftIds: [...new Set(points.map((p) => p.drift_id).filter((x): x is string => !!x))].sort(),
    points: points.length,
    createdAt: new Date().toISOString(),
  };
  if (points.length === 0) {
    return { ...base, threshold: null, safeMaxDistance: null, firstChangeDistance: null, note: 'No drift data: near matching OFF.' };
  }
  const changed = points.filter((p) => p.change > 0).map((p) => p.distance);
  const firstChangeDistance = changed.length ? Math.min(...changed) : null;
  const safe = points.filter((p) => p.change === 0 && (firstChangeDistance === null || p.distance < firstChangeDistance));
  const safeMaxDistance = safe.length ? Math.max(...safe.map((p) => p.distance)) : null;
  const t = safeMaxDistance === null ? null : safeMaxDistance - margin;
  const threshold = t !== null && t >= 0 ? t : null;
  let note: string;
  if (threshold === null) {
    note =
      firstChangeDistance === 0
        ? 'An output changed at distance 0 (dHash could not see the perturbation): near matching OFF.'
        : 'No distance is safe after the margin: near matching OFF.';
  } else if (firstChangeDistance === null) {
    note = `No output change observed; threshold limited to the tested range (max safe ${safeMaxDistance}).`;
  } else {
    note = `Outputs first changed at distance ${firstChangeDistance}; largest safe distance ${safeMaxDistance}; margin ${margin}.`;
  }
  return { ...base, threshold, safeMaxDistance, firstChangeDistance, note };
}

export function calibrationPath(dataDir: string): string {
  return path.join(dataDir, 'calibration.json');
}

export function saveCalibration(dataDir: string, c: Calibration): string {
  const p = calibrationPath(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(c, null, 2));
  return p;
}

export function loadCalibration(dataDir: string): Calibration | null {
  const p = calibrationPath(dataDir);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Calibration;
  } catch {
    return null;
  }
}

/** Near matching is allowed only for a model + request the calibration actually measured. */
export function nearThresholdFor(c: Calibration | null, model: string, requestKey: string): number | null {
  if (!c || c.threshold === null) return null;
  if (!c.models.includes(model) || !c.requestKeys.includes(requestKey)) return null;
  return c.threshold;
}
