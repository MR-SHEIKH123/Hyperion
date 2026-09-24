/**
 * SQLite access layer.
 *
 * Two interchangeable backends behind one better-sqlite3-shaped API:
 *
 *   1. `better-sqlite3` — used when it loads.
 *   2. `node:sqlite`    — Node's built-in, used otherwise.
 *
 * Why: better-sqlite3 is a native addon, so it needs either a prebuilt binary
 * matching the exact Node major or a local toolchain + Python to compile. On
 * new Node majors neither is guaranteed (it is declared an optionalDependency
 * for precisely this reason — npm install must not hard-fail). The built-in
 * module has no such constraint, so the app always has a working database.
 *
 * Both backends are normalized here so no call site ever has to care which one
 * is live. Three real behavioural differences are smoothed over:
 *
 *   - Booleans cannot be bound by either driver. SQLite has no boolean type.
 *     Since the schema is full of flags (enabled/pinned/active), `true`/`false`
 *     are coerced to 1/0 centrally instead of at ~50 call sites.
 *   - `undefined` cannot be bound, which is easy to hit with optional fields
 *     (`row.token` on an object that simply lacks the property). It is coerced
 *     to NULL, which is what the caller means in practice.
 *   - `node:sqlite` hands back rows with a null prototype while better-sqlite3
 *     hands back plain objects. Anything that looks at the prototype
 *     (`assert.deepEqual`, and the migration tests' whole-row comparisons) can
 *     tell which backend is live, so `get`/`all` spread rows into plain objects
 *     on the node:sqlite path — matching better-sqlite3, not inventing a third
 *     shape.
 *
 * `transaction()` is provided for both, since node:sqlite has no equivalent.
 */
import { createRequire } from 'node:module';
import { env } from '../config/env.ts';

/** `require` does not exist in an ES module; build one for optional/native loads. */
const require = createRequire(import.meta.url);

export type SqlValue = string | number | bigint | Buffer | Uint8Array | null;
export type BindValue = SqlValue | boolean | undefined;
export type BindParams = BindValue[] | [Record<string, BindValue>];

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface Statement<Row = unknown> {
  run(...params: BindParams): RunResult;
  get(...params: BindParams): Row | undefined;
  all(...params: BindParams): Row[];
}

export interface Db {
  prepare<Row = unknown>(sql: string): Statement<Row>;
  exec(sql: string): void;
  /**
   * Wrap `fn` in a transaction. Nested calls join the outer transaction via
   * SAVEPOINT, so a repo method that opens a transaction can safely be called
   * from inside another one.
   */
  transaction<T>(fn: () => T): () => T;
  close(): void;
  readonly backend: 'better-sqlite3' | 'node:sqlite';
}

/** Coerce JS values into something SQLite will accept. */
function normalize(params: BindParams): unknown[] {
  if (params.length === 1 && isPlainObject(params[0])) {
    const out: Record<string, SqlValue> = {};
    for (const [key, value] of Object.entries(params[0] as Record<string, BindValue>)) {
      out[key] = normalizeValue(value);
    }
    return [out];
  }
  return (params as BindValue[]).map(normalizeValue);
}

function normalizeValue(value: BindValue): SqlValue {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function isPlainObject(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !Buffer.isBuffer(value) &&
    !(value instanceof Uint8Array)
  );
}

function tryLoadBetterSqlite(): unknown | null {
  try {
    // Resolved lazily and guarded: absence is an expected, supported state.
    return require('better-sqlite3');
  } catch {
    return null;
  }
}

let savepointCounter = 0;

export function openDatabase(file: string): Db {
  const BetterSqlite3 = tryLoadBetterSqlite() as
    | (new (path: string, opts?: unknown) => BetterSqlite3Database)
    | null;

  if (BetterSqlite3) {
    return wrapBetterSqlite(new BetterSqlite3(file));
  }
  return wrapNodeSqlite(file);
}

// --- better-sqlite3 -------------------------------------------------------

interface BetterSqlite3Statement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface BetterSqlite3Database {
  prepare(sql: string): BetterSqlite3Statement;
  exec(sql: string): void;
  close(): void;
  pragma(source: string): unknown;
}

function wrapBetterSqlite(raw: BetterSqlite3Database): Db {
  applyPragmas((sql) => raw.exec(sql));

  const db: Db = {
    backend: 'better-sqlite3',
    prepare<Row>(sql: string): Statement<Row> {
      const stmt = raw.prepare(sql);
      return {
        run: (...params) => {
          const r = stmt.run(...normalize(params));
          return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
        },
        get: (...params) => stmt.get(...normalize(params)) as Row | undefined,
        all: (...params) => stmt.all(...normalize(params)) as Row[],
      };
    },
    exec: (sql) => raw.exec(sql),
    transaction: <T>(fn: () => T) => makeTransaction(db, fn),
    close: () => raw.close(),
  };
  return db;
}

// --- node:sqlite ----------------------------------------------------------

function wrapNodeSqlite(file: string): Db {
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string, options?: { allowExtension?: boolean }) => NodeSqliteDatabase;
  };
  const raw = new DatabaseSync(file);
  applyPragmas((sql) => raw.exec(sql));

  const db: Db = {
    backend: 'node:sqlite',
    prepare<Row>(sql: string): Statement<Row> {
      const stmt = raw.prepare(sql);
      // Accept `{ x: 1 }` for `:x` placeholders, matching better-sqlite3.
      stmt.setAllowBareNamedParameters?.(true);
      return {
        run: (...params) => {
          const r = stmt.run(...(normalize(params) as SqlValue[]));
          return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
        },
        get: (...params) => plainRow(stmt.get(...(normalize(params) as SqlValue[])) as Row | undefined),
        all: (...params) => (stmt.all(...(normalize(params) as SqlValue[])) as Row[]).map(plainRow),
      };
    },
    exec: (sql) => raw.exec(sql),
    transaction: <T>(fn: () => T) => makeTransaction(db, fn),
    close: () => raw.close(),
  };
  return db;
}

/**
 * Spread one row into a plain object. Misses (`undefined`), NULLs and scalars
 * pass through untouched — only the prototype of a real row is normalized, so
 * `get` on a miss still answers `undefined` rather than an empty object.
 */
function plainRow<Row>(row: Row): Row {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return row;
  return { ...(row as Record<string, unknown>) } as Row;
}

interface NodeSqliteStatement {
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
  setAllowBareNamedParameters?(enabled: boolean): void;
}
interface NodeSqliteDatabase {
  prepare(sql: string): NodeSqliteStatement;
  exec(sql: string): void;
  close(): void;
}

// --- shared ---------------------------------------------------------------

function applyPragmas(exec: (sql: string) => void): void {
  // WAL: readers never block the writer. Matters because the cleanup job and
  // usage logging write while a chat stream is reading.
  exec('PRAGMA journal_mode = WAL');
  exec('PRAGMA foreign_keys = ON');
  exec('PRAGMA busy_timeout = 5000');
  // NORMAL is the right durability trade-off for a local single-user app:
  // safe against process crashes, only at risk from an OS-level power loss.
  exec('PRAGMA synchronous = NORMAL');
}

/**
 * Transaction wrapper with SAVEPOINT-based nesting, so composing repo methods
 * that each open a transaction does not throw "cannot start a transaction
 * within a transaction".
 */
function makeTransaction<T>(db: Db, fn: () => T): () => T {
  return () => {
    const nested = txDepth > 0;
    const name = `sp_${++savepointCounter}`;

    db.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN');
    txDepth++;
    try {
      const result = fn();
      db.exec(nested ? `RELEASE ${name}` : 'COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec(nested ? `ROLLBACK TO ${name}` : 'ROLLBACK');
        if (nested) db.exec(`RELEASE ${name}`);
      } catch {
        /* the original error is the useful one */
      }
      throw error;
    } finally {
      txDepth--;
    }
  };
}

let txDepth = 0;

// --- singleton ------------------------------------------------------------

let instance: Db | null = null;

/** The application database. Opened on first use. */
export function getDb(): Db {
  if (!instance) instance = openDatabase(env.paths.db);
  return instance;
}

export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

/** Replace the singleton — used by tests to point at a temp file. */
export function setDb(db: Db | null): void {
  instance = db;
}
