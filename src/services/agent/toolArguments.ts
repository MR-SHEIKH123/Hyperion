/**
 * Tool-call arguments, parsed the one way every agent parses them.
 *
 * This existed three times — in the Code agent, the Cowork agent and the Design
 * tools — with the same two sentences and the same acceptance rule. Two copies of
 * a message are enough to drift, and this message is part of an API answer: a
 * client branching on `bad_request` must not get one description of "the model
 * produced invalid JSON" from one tool and a different one from another.
 *
 * The rule is deliberately strict: **`JSON.parse`, then an object** — never an
 * array, never a scalar. A model that emits `"42"` or `"[...]"` has not produced
 * arguments any tool here can take, and failing at the parse keeps the refusal
 * ahead of every dispatch rather than inside each of them.
 */
import { AppError } from '../../util/errors.ts';

export function parseToolArguments(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new AppError('bad_request', 'The model produced invalid JSON tool arguments.');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError('bad_request', 'Tool arguments must be a JSON object.');
  }
  return value as Record<string, unknown>;
}
