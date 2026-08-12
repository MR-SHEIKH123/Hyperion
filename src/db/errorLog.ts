/**
 * Repository for the error_log table — enabling the debug console to query
 * structured error records rather than tailing raw stdout.
 */

import { getDb } from './adapter.ts';

import type { BindValue } from './adapter.ts';


export interface ErrorLogEntry {
  id: number;
  timestamp: number;
  severity: 'warning' | 'error';
  endpoint: string | null;
  method: string | null;
  status: number | null;
  error_code: string | null;
  error_message: string;
  stack_trace: string | null;
  request_context: string | null;
  created_at: number;
}

export interface ErrorLogInsert {
  timestamp: number;
  severity: 'warning' | 'error';
  endpoint?: string;
  method?: string;
  status?: number;
  error_code?: string;
  error_message: string;
  stack_trace?: string;
  request_context?: string;
}

/**
 * Write an error to the log.
 *
 * Called by the error-handling middleware for every 500, and by the
 * process-level handlers for uncaught exceptions and unhandled rejections.
 */
export function logError(entry: ErrorLogInsert): void {
  getDb()
    .prepare(
      `INSERT INTO error_log (timestamp, severity, endpoint, method, status, error_code, error_message, stack_trace, request_context)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.timestamp,
      entry.severity,
      entry.endpoint ?? null,
      entry.method ?? null,
      entry.status ?? null,
      entry.error_code ?? null,
      entry.error_message,
      entry.stack_trace ?? null,
      entry.request_context ?? null,
    );
}

export interface ErrorLogQuery {
  limit?: number;
  severity?: 'warning' | 'error';
  since?: number;
}

/**
 * Query the error log for the debug console.
 *
 * Defaults: last 100 entries, both severities, no time filter.
 */
export function queryErrorLog(query: ErrorLogQuery = {}): ErrorLogEntry[] {
  const { limit = 100, severity, since } = query;

  let sql = 'SELECT * FROM error_log WHERE 1=1';
  const params: BindValue[] = [];


  if (severity) {
    sql += ' AND severity = ?';
    params.push(severity);
  }

  if (since !== undefined) {
    sql += ' AND timestamp >= ?';
    params.push(since);
  }

  sql += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);

  return getDb().prepare<ErrorLogEntry>(sql).all(...params);
}

/**
 * Count total errors matching the query — for pagination metadata.
 */
export function countErrors(query: Omit<ErrorLogQuery, 'limit'> = {}): number {
  const { severity, since } = query;

  let sql = 'SELECT COUNT(*) as count FROM error_log WHERE 1=1';
  const params: BindValue[] = [];


  if (severity) {
    sql += ' AND severity = ?';
    params.push(severity);
  }

  if (since !== undefined) {
    sql += ' AND timestamp >= ?';
    params.push(since);
  }

  const row = getDb().prepare<{ count: number }>(sql).get(...params);
  return row?.count ?? 0;
}
