// One glob engine, shared.
//
// Two unrelated features match paths against user-authored patterns: a project
// rule declares `scope: src/**` to say where it applies, and a permission rule
// declares `write: {"src/**": "allow"}` to say what may be touched. They must
// agree on what a pattern means. A user who has learned that `src/**` covers
// `src/a/b.ts` in one place and finds it does not in the other has been handed a
// security surprise, not a syntax quirk — so this lives in `util/` rather than
// being reimplemented next to whichever feature needed it second.
//
// The supported syntax is deliberately small and is the same as before it moved:
//
//   `*`      any run of characters within one path segment
//   `**` `/` zero or more whole segments
//   `**`     any run of characters, segment separators included
//   `?`      exactly one character within one path segment
//
// No brace expansion, no character classes, no negation. Every one of those is a
// place where a pattern can mean something subtly different from what its author
// read, and none of them is needed to say "these files".
//
// Patterns are matched against forward-slash relative paths. Windows callers
// normalize before matching rather than the engine special-casing a separator,
// because a pattern is authored once and may be read on either platform.

import { AppError } from './errors.ts';

/** The longest pattern accepted, in characters. */
export const GLOB_MAX = 256;

/**
 * Validate and canonicalize a user-authored glob.
 *
 * Rejects rather than repairs: an empty pattern, an absolute one, or one
 * carrying a NUL is a mistake in a file the user wrote, and silently coercing it
 * would apply a rule they did not author. `field` names the front-matter or JSON
 * key in the error so the message points at the line to fix.
 */
export function normalizeGlob(pattern: string, field = 'scope'): string {
  const normalized = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (
    normalized.length === 0 ||
    normalized.length > GLOB_MAX ||
    normalized.includes('\0') ||
    normalized.startsWith('/')
  ) {
    throw new AppError('bad_request', 'A glob must be a bounded relative pattern.', {
      details: { field },
    });
  }
  return normalized;
}

/**
 * Compile a normalized pattern to an anchored regular expression.
 *
 * Anchored at both ends on purpose: an unanchored `src/*.ts` would also match
 * `vendor/src/x.ts`, which is the difference between a rule that scopes and a
 * rule that leaks.
 */
export function compileGlob(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === undefined) break;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          // `(?:.*/)?` rather than `.*/` so `**/x` also matches a bare `x`.
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`${source}$`);
}

/** True when `subject` matches `pattern`, normalizing both first. */
export function globMatches(pattern: string, subject: string, field = 'scope'): boolean {
  return compileGlob(normalizeGlob(pattern, field)).test(subject.replace(/\\/g, '/'));
}

function escapeRegExp(char: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}
