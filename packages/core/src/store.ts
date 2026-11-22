import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CacheMode, StructuredOutput } from './types.js';
import type { Family } from './image.js';

export interface RunRow {
  id: string;
  name: string;
  kind: string;
  created_at: string;
  call_count?: number;
}

export interface CallRow {
  id: string;
  run_id: string | null;
  seq: number;
  adapter: string;
  model: string;
  prompt: string;
  params: string;
  image_hashes: string; // JSON string[] of sha256
  image_dhashes: string; // JSON string[]
  request_key: string;
  exact_key: string;
  response: string | null; // JSON VisionResponse minus meta
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  cache: CacheMode;
  cache_distance: number | null;
  cache_threshold: number | null;
  cached_from: string | null;
  error: string | null;
  created_at: string;
}

export interface DriftPointRow {
  drift_id: string;
  family: Family;
  label: string;
  value: number;
  step: number;
  distance: number;
  change: number;
  model: string;
  request_key: string;
  source_sha: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'record', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS blobs (
  sha256 TEXT PRIMARY KEY, dhash TEXT NOT NULL, width INTEGER, height INTEGER, bytes INTEGER, path TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY, run_id TEXT, seq INTEGER NOT NULL, adapter TEXT NOT NULL, model TEXT NOT NULL,
  prompt TEXT NOT NULL, params TEXT NOT NULL, image_hashes TEXT NOT NULL, image_dhashes TEXT NOT NULL,
  request_key TEXT NOT NULL, exact_key TEXT NOT NULL, response TEXT, latency_ms INTEGER NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, cache TEXT NOT NULL,
  cache_distance INTEGER, cache_threshold INTEGER, cached_from TEXT, error TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS calls_exact ON calls(exact_key);
CREATE INDEX IF NOT EXISTS calls_request ON calls(request_key);
CREATE INDEX IF NOT EXISTS calls_run ON calls(run_id, seq);
CREATE TABLE IF NOT EXISTS drift_points (
  drift_id TEXT NOT NULL, family TEXT NOT NULL, label TEXT NOT NULL, value REAL NOT NULL, step INTEGER NOT NULL,
  distance INTEGER NOT NULL, change REAL NOT NULL, model TEXT NOT NULL, request_key TEXT NOT NULL,
  source_sha TEXT NOT NULL, created_at TEXT NOT NULL
);
`;

/** Thin synchronous SQLite + blob-directory store. The recorder makes writes async around it. */
export class Store {
  readonly db: Database.Database;
  readonly blobDir: string;

  constructor(readonly dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.blobDir = path.join(dataDir, 'blobs');
    fs.mkdirSync(this.blobDir, { recursive: true });
    this.db = new Database(path.join(dataDir, 'pixelblame.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  createRun(name: string, kind = 'record'): string {
    const id = 'run_' + randomUUID().slice(0, 8);
    this.db.prepare('INSERT INTO runs (id, name, kind, created_at) VALUES (?, ?, ?, ?)').run(id, name, kind, new Date().toISOString());
    return id;
  }

  listRuns(): RunRow[] {
    return this.db
      .prepare(
        `SELECT r.*, (SELECT COUNT(*) FROM calls c WHERE c.run_id = r.id) AS call_count
         FROM runs r ORDER BY r.created_at DESC`,
      )
      .all() as RunRow[];
  }

  getRun(id: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
  }

  callsForRun(runId: string): CallRow[] {
    return this.db.prepare('SELECT * FROM calls WHERE run_id = ? ORDER BY seq').all(runId) as CallRow[];
  }

  nextSeq(runId: string | null): number {
    if (!runId) return 0;
    const r = this.db.prepare('SELECT MAX(seq) AS m FROM calls WHERE run_id = ?').get(runId) as { m: number | null };
    return (r.m ?? -1) + 1;
  }

  putBlob(sha: string, dhash: string, bytes: Buffer, width: number, height: number, ext: string): void {
    const existing = this.db.prepare('SELECT sha256 FROM blobs WHERE sha256 = ?').get(sha);
    if (existing) return;
    const rel = `${sha}.${ext}`;
    fs.writeFileSync(path.join(this.blobDir, rel), bytes);
    this.db
      .prepare('INSERT OR IGNORE INTO blobs (sha256, dhash, width, height, bytes, path) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sha, dhash, width, height, bytes.length, rel);
  }

  getBlob(sha: string): { bytes: Buffer; dhash: string; path: string } | undefined {
    const row = this.db.prepare('SELECT * FROM blobs WHERE sha256 = ?').get(sha) as { dhash: string; path: string } | undefined;
    if (!row) return undefined;
    const p = path.join(this.blobDir, row.path);
    if (!fs.existsSync(p)) return undefined;
    return { bytes: fs.readFileSync(p), dhash: row.dhash, path: p };
  }

  insertCall(row: CallRow): void {
    this.db
      .prepare(
        `INSERT INTO calls (id, run_id, seq, adapter, model, prompt, params, image_hashes, image_dhashes, request_key,
          exact_key, response, latency_ms, tokens_in, tokens_out, cache, cache_distance, cache_threshold, cached_from, error, created_at)
         VALUES (@id, @run_id, @seq, @adapter, @model, @prompt, @params, @image_hashes, @image_dhashes, @request_key,
          @exact_key, @response, @latency_ms, @tokens_in, @tokens_out, @cache, @cache_distance, @cache_threshold, @cached_from, @error, @created_at)`,
      )
      .run(row);
  }

  /** Most recent successful live call with these exact bytes + request. */
  findExact(exactKey: string): CallRow | undefined {
    return this.db
      .prepare(`SELECT * FROM calls WHERE exact_key = ? AND cache = 'live' AND response IS NOT NULL AND error IS NULL ORDER BY created_at DESC LIMIT 1`)
      .get(exactKey) as CallRow | undefined;
  }

  /** Live calls with the same prompt/params/model; near matching then compares dHashes in JS. */
  candidatesForNear(requestKey: string): CallRow[] {
    return this.db
      .prepare(`SELECT * FROM calls WHERE request_key = ? AND cache = 'live' AND response IS NOT NULL AND error IS NULL ORDER BY created_at DESC LIMIT 500`)
      .all(requestKey) as CallRow[];
  }

  insertDriftPoints(points: DriftPointRow[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO drift_points (drift_id, family, label, value, step, distance, change, model, request_key, source_sha, created_at)
       VALUES (@drift_id, @family, @label, @value, @step, @distance, @change, @model, @request_key, @source_sha, @created_at)`,
    );
    const now = new Date().toISOString();
    const tx = this.db.transaction((ps: DriftPointRow[]) => ps.forEach((p) => stmt.run({ ...p, created_at: now })));
    tx(points);
  }

  driftPoints(driftIds?: string[]): DriftPointRow[] {
    if (driftIds && driftIds.length) {
      const q = `SELECT * FROM drift_points WHERE drift_id IN (${driftIds.map(() => '?').join(',')}) ORDER BY drift_id, family, step`;
      return this.db.prepare(q).all(...driftIds) as DriftPointRow[];
    }
    return this.db.prepare('SELECT * FROM drift_points ORDER BY drift_id, family, step').all() as DriftPointRow[];
  }

  driftIds(): Array<{ drift_id: string; source_sha: string; model: string; points: number; created_at: string }> {
    return this.db
      .prepare(
        `SELECT drift_id, source_sha, model, COUNT(*) AS points, MIN(created_at) AS created_at
         FROM drift_points GROUP BY drift_id ORDER BY created_at DESC`,
      )
      .all() as Array<{ drift_id: string; source_sha: string; model: string; points: number; created_at: string }>;
  }

  /** Parse a stored response back into an output object. */
  static output(row: CallRow): StructuredOutput {
    return (JSON.parse(row.response ?? '{"output":{"items":[]}}') as { output: StructuredOutput }).output;
  }
}
