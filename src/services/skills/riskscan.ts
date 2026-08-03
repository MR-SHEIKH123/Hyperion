/**
 * Heuristic risk scan for externally-sourced skills.
 *
 * READ THIS BEFORE CHANGING ANYTHING HERE:
 *
 * This is a **heuristic** scan, not a security boundary. It exists to give the
 * user something to look at before they let a stranger's instructions into their
 * model's context — nothing more. A clean result means "we found nothing obvious",
 * never "this is safe". That caveat is not a comment; it is part of the API
 * response (`DISCLAIMER` below) and the frontend renders it verbatim, so it must
 * stay honest even if the checks get better.
 *
 * Hand-authored default skills are exempt (`sourceType === 'builtin'`): scanning
 * files we shipped ourselves would only generate noise the user learns to dismiss.
 *
 * Four families of flags, as specified:
 *   - `binary`      — unexpected executable/binary payloads
 *   - `obfuscated`  — minified or encoded code where plain text is expected
 *   - `network`     — outbound network calls in scripts
 *   - `injection`   — prose trying to override the system prompt
 * plus `oversize` for files too large to be instructions, which is how a payload
 * usually hides.
 */
import fs from 'node:fs';
import path from 'node:path';

export const DISCLAIMER =
  'This is a heuristic check, not a guarantee of safety. It looks for a small set of ' +
  'obvious patterns and can produce both false alarms and false reassurance. No findings ' +
  'does not mean the skill is safe — review anything you did not write yourself.';

export type RiskCategory = 'binary' | 'obfuscated' | 'network' | 'injection' | 'oversize';
export type RiskSeverity = 'info' | 'warning';

export interface RiskFlag {
  category: RiskCategory;
  severity: RiskSeverity;
  /** Path relative to the skill root. */
  file: string;
  /** One-line, user-facing explanation. */
  message: string;
  /** A short excerpt of the matched text, if the match came from text. */
  excerpt?: string;
  /** 1-based line number of the match, if applicable. */
  line?: number;
}

export interface RiskReport {
  scanned: number;
  skipped: number;
  flags: RiskFlag[];
  /** Convenience for the UI: a warning-level flag exists. */
  hasWarnings: boolean;
  /** Always present, always shown to the user. */
  disclaimer: string;
}

const MAX_FILES = 400;
const MAX_TEXT_BYTES = 512 * 1024;
const OVERSIZE_TEXT_BYTES = 256 * 1024;

const BINARY_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin', '.msi', '.app', '.com', '.scr',
  '.bat', '.cmd', '.ps1', '.vbs', '.jar', '.class', '.pyc', '.pyd', '.wasm',
  '.deb', '.rpm', '.dmg', '.pkg', '.apk', '.node',
]);

const ARCHIVE_EXTENSIONS = new Set(['.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar']);

const SCRIPT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.py', '.sh', '.bash', '.zsh', '.rb', '.pl', '.php', '.lua',
]);

const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.toml', '.ini', '.csv', '.html', '.xml',
]);

const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build']);

/** Outbound-network patterns in scripts. */
const NETWORK_PATTERNS: { pattern: RegExp; message: string }[] = [
  { pattern: /\bfetch\s*\(/, message: 'calls fetch()' },
  { pattern: /\b(?:https?|axios)\.(?:get|post|put|request)\s*\(/, message: 'makes an HTTP request' },
  { pattern: /\bXMLHttpRequest\b/, message: 'uses XMLHttpRequest' },
  { pattern: /\brequests\.(?:get|post|put|patch|delete)\s*\(/, message: 'uses the Python requests library' },
  { pattern: /\burllib(?:\.request)?\.urlopen\s*\(/, message: 'opens a URL with urllib' },
  { pattern: /\b(?:curl|wget)\s+(?:-\S+\s+)*https?:\/\//, message: 'shells out to curl/wget' },
  { pattern: /\bnc\s+-\S*[le]\S*\s/, message: 'opens a netcat listener' },
  { pattern: /\bsocket\.(?:socket|create_connection)\s*\(/, message: 'opens a raw socket' },
  { pattern: /\bnew\s+WebSocket\s*\(/, message: 'opens a WebSocket' },
  { pattern: /\bchild_process\b|\bsubprocess\b|\bos\.system\s*\(/, message: 'spawns another process' },
];

/** Prompt-injection phrasing: text aimed at the model, not at the user. */
const INJECTION_PATTERNS: { pattern: RegExp; message: string }[] = [
  {
    pattern: /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|earlier|above)\s+(?:instructions?|prompts?|rules?)/i,
    message: 'tells the model to ignore previous instructions',
  },
  {
    pattern: /\bdisregard\s+(?:all\s+|any\s+)?(?:previous|prior|the)\s+(?:instructions?|rules?|system prompt)/i,
    message: 'tells the model to disregard prior rules',
  },
  {
    pattern: /\b(?:override|bypass|circumvent)\s+(?:the\s+)?(?:system\s+prompt|safety|guardrails?|restrictions?)/i,
    message: 'asks the model to bypass its guardrails',
  },
  {
    pattern: /\byou\s+are\s+now\s+(?:in\s+)?(?:developer|god|dan|unrestricted|jailbreak)\b/i,
    message: 'attempts to reassign the model a new unrestricted persona',
  },
  {
    pattern: /\bdo\s+not\s+(?:tell|inform|mention\s+(?:this\s+)?to)\s+the\s+user\b/i,
    message: 'instructs the model to hide something from the user',
  },
  {
    pattern: /\b(?:reveal|print|output|repeat)\s+(?:your\s+|the\s+)?system\s+prompt\b/i,
    message: 'tries to extract the system prompt',
  },
  {
    pattern: /\bwithout\s+(?:asking|requesting)\s+(?:for\s+)?(?:permission|confirmation|approval)\b/i,
    message: 'asks the model to act without confirmation',
  },
  {
    pattern: /<\s*\/?\s*(?:system|im_start|im_end)\s*\|?\s*>/i,
    message: 'contains chat-template control markers',
  },
];

/** Encoded/obfuscated payload markers. */
const OBFUSCATION_PATTERNS: { pattern: RegExp; message: string }[] = [
  { pattern: /\beval\s*\(\s*(?:atob|Buffer\.from|decodeURIComponent)/, message: 'evaluates decoded text' },
  { pattern: /\bexec\s*\(\s*(?:base64|codecs|bytes)/, message: 'executes decoded bytes' },
  { pattern: /\batob\s*\(|\bBuffer\.from\s*\([^)]*['"]base64['"]/, message: 'decodes base64 at runtime' },
  { pattern: /\bbase64\s*(?:-d|--decode)\b/, message: 'decodes base64 in a shell command' },
  { pattern: /(?:\\x[0-9a-fA-F]{2}){12,}/, message: 'contains a long hex-escaped string' },
  { pattern: /[A-Za-z0-9+/]{240,}={0,2}/, message: 'contains a long base64-looking blob' },
];

export interface ScanOptions {
  /** Builtin skills are trusted and skipped entirely. */
  trusted?: boolean;
}

/** Walks a skill directory and reports what it found. Never throws. */
export function scanSkillDirectory(root: string, options: ScanOptions = {}): RiskReport {
  const report: RiskReport = {
    scanned: 0,
    skipped: 0,
    flags: [],
    hasWarnings: false,
    disclaimer: DISCLAIMER,
  };
  if (options.trusted) return report;

  let files: string[];
  try {
    files = walk(root);
  } catch {
    return report;
  }

  for (const absolute of files) {
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      report.skipped += 1;
      continue;
    }

    const ext = path.extname(absolute).toLowerCase();

    if (BINARY_EXTENSIONS.has(ext)) {
      report.flags.push({
        category: 'binary',
        severity: 'warning',
        file: relative,
        message: `Executable or compiled file (${ext}). A skill should normally be instructions and plain-text scripts.`,
      });
      report.scanned += 1;
      continue;
    }

    if (ARCHIVE_EXTENSIONS.has(ext)) {
      report.flags.push({
        category: 'binary',
        severity: 'warning',
        file: relative,
        message: `Archive file (${ext}); its contents were not inspected.`,
      });
      report.scanned += 1;
      continue;
    }

    if (stat.size > MAX_TEXT_BYTES) {
      report.flags.push({
        category: 'oversize',
        severity: 'info',
        file: relative,
        message: `${Math.round(stat.size / 1024)} KB is larger than instructions usually are; it was not scanned.`,
      });
      report.skipped += 1;
      continue;
    }

    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(absolute);
    } catch {
      report.skipped += 1;
      continue;
    }
    report.scanned += 1;

    if (looksBinary(buffer)) {
      report.flags.push({
        category: 'binary',
        severity: 'warning',
        file: relative,
        message: 'Contains binary data despite a text-like name.',
      });
      continue;
    }

    const text = buffer.toString('utf8');
    const isScript = SCRIPT_EXTENSIONS.has(ext);
    const isProse = TEXT_EXTENSIONS.has(ext) || ext === '';

    if (isScript) {
      collect(report, relative, text, NETWORK_PATTERNS, 'network', 'warning', 'This script ');
      if (isMinified(text)) {
        report.flags.push({
          category: 'obfuscated',
          severity: 'warning',
          file: relative,
          message: 'Looks minified or generated: very long lines with almost no line breaks.',
        });
      }
    }

    collect(report, relative, text, OBFUSCATION_PATTERNS, 'obfuscated', 'warning', 'This file ');

    if (isProse || isScript) {
      collect(report, relative, text, INJECTION_PATTERNS, 'injection', 'warning', 'Instruction text that ');
    }

    if (isProse && buffer.byteLength > OVERSIZE_TEXT_BYTES) {
      report.flags.push({
        category: 'oversize',
        severity: 'info',
        file: relative,
        message: `${Math.round(buffer.byteLength / 1024)} KB of instructions will consume a large share of the model's context.`,
      });
    }
  }

  report.hasWarnings = report.flags.some((flag) => flag.severity === 'warning');
  return report;
}

// --- helpers ---------------------------------------------------------------

function walk(root: string): string[] {
  const out: string[] = [];
  const queue: string[] = [root];
  while (queue.length > 0 && out.length < MAX_FILES) {
    const dir = queue.shift();
    if (dir === undefined) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        queue.push(full);
      } else if (entry.isSymbolicLink()) {
        // Not followed: a symlink out of the skill directory is not ours to read.
        continue;
      } else if (entry.isFile()) {
        out.push(full);
        if (out.length >= MAX_FILES) break;
      }
    }
  }
  return out;
}

/** A NUL byte in the first 8 KB is the classic binary tell. */
function looksBinary(buffer: Buffer): boolean {
  const window = buffer.subarray(0, 8192);
  return window.includes(0);
}

function isMinified(text: string): boolean {
  const lines = text.split('\n');
  if (lines.length === 0) return false;
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  const average = text.length / lines.length;
  return (longest > 1000 && lines.length < 10) || (average > 400 && text.length > 4000);
}

function collect(
  report: RiskReport,
  file: string,
  text: string,
  patterns: { pattern: RegExp; message: string }[],
  category: RiskCategory,
  severity: RiskSeverity,
  prefix: string,
): void {
  for (const { pattern, message } of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    // One flag per pattern per file: ten copies of the same finding is noise,
    // and the user only needs to know the pattern is present.
    report.flags.push({
      category,
      severity,
      file,
      message: `${prefix}${message}.`,
      excerpt: excerptAround(text, match.index, match[0].length),
      line: lineOf(text, match.index),
    });
  }
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  const slice = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return slice.length > 160 ? `${slice.slice(0, 159)}…` : slice;
}
