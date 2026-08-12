/**
 * Per-item export — Part 1.18.
 *
 * The backup archive is the right tool for disaster recovery and the wrong one
 * for the everyday case of saving or sharing one specific thing. These three
 * are read-and-format only over data that already exists — `messages`,
 * `artifact_versions`, and a worktree's git history — so there is no new
 * schema and nothing here writes.
 *
 * Each returns a filename and a body rather than a JSON envelope, because the
 * result is meant to become a file. Failures are `AppError`s so the HTTP layer
 * can classify them; note `AppError` derives its status from the code, so
 * `not_found` is already a 404 and passing a status positionally would be a
 * type error rather than an override.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { getDb } from '../../db/adapter.ts';
import { listMessages, requireChat } from '../../db/chats.ts';
import { resolveInScope } from '../../security/fsScope.ts';
import { getWorktree } from '../code/worktree.ts';
import { AppError } from '../../util/errors.ts';

/** Filesystem-safe stem for a downloaded file. Never empty. */
function safeStem(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned === '' ? fallback : cleaned;
}

export interface ChatExport {
  format: 'markdown' | 'json';
  filename: string;
  contentType: string;
  content: string;
}

export function exportChat(chatId: string, format: 'markdown' | 'json'): ChatExport {
  // requireChat throws not_found for an unknown id, so an export never invents
  // an empty transcript for a chat that does not exist.
  const chat = requireChat(chatId);
  const messages = listMessages(chatId);
  const stem = safeStem(chat.title, 'chat');

  if (format === 'json') {
    return {
      format,
      filename: `${stem}.json`,
      contentType: 'application/json; charset=utf-8',
      content: JSON.stringify(
        {
          chat: {
            id: chat.id,
            title: chat.title,
            tool: chat.tool,
            modelId: chat.modelId,
            createdAt: chat.createdAt,
            updatedAt: chat.updatedAt,
          },
          messages: messages.map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            modelId: message.modelId,
            providerName: message.providerName,
            tokensIn: message.tokensIn,
            tokensOut: message.tokensOut,
            createdAt: message.createdAt,
          })),
        },
        null,
        2,
      ),
    };
  }

  /*
   * Markdown is meant to read as a conversation, not as a table dump. Empty
   * assistant rows are skipped: a turn that failed or was cancelled mid-stream
   * leaves a row with no content, and rendering it produces a heading followed
   * by nothing, which reads as a bug in the export rather than a fact about
   * the chat.
   */
  const turns = messages
    .filter((message) => message.content.trim() !== '')
    .map((message) => {
      const speaker =
        message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : message.role;
      return `## ${speaker}\n\n${message.content.trim()}\n`;
    });

  const header = [`# ${chat.title}`, '', `*${chat.tool} · exported from Hyperion*`, '', '---', ''];

  return {
    format,
    filename: `${stem}.md`,
    contentType: 'text/markdown; charset=utf-8',
    content: [...header, ...turns].join('\n'),
  };
}

interface ArtifactRow {
  id: string;
  artifact_key: string;
  version: number;
  // Nullable in the schema: exactly one of content/rel_path is set.
  content: string | null;
  rel_path: string | null;
  label: string | null;
}

export interface ArtifactExport {
  filename: string;
  contentType: string;
  content: string;
}

/**
 * One artifact version, in whatever format it was written in. The stored
 * `rel_path` carries the extension the producing tool chose, so the export
 * does not have to guess a format from the content.
 *
 * `content` is nullable by design — `001_init.sql` stores small artifacts
 * inline and large ones by file reference, with a CHECK enforcing that exactly
 * one is present. Reading only the column would hand back an empty file for
 * every large artifact, which is the failure mode most likely to go unnoticed,
 * so a null `content` is resolved from disk instead.
 */
export function exportArtifact(id: string): ArtifactExport {
  const row = getDb()
    .prepare<ArtifactRow>(
      `SELECT id, artifact_key, version, content, rel_path, label
         FROM artifact_versions WHERE id = ?`,
    )
    .get(id);

  if (row === undefined) {
    throw new AppError('not_found', `No artifact version with id "${id}" exists.`, {
      details: { id },
    });
  }

  const relPath = row.rel_path ?? '';
  const basename = relPath === '' ? row.artifact_key : relPath.split(/[\\/]/).pop() ?? relPath;
  const dot = basename.lastIndexOf('.');
  // The extension is sanitised as well as the stem, not only for the
  // filesystem: this whole filename is interpolated into a Content-Disposition
  // header, and a stored rel_path containing a quote or a newline would let the
  // artifact's own data break the header apart.
  const extension = dot > 0 ? safeStem(basename.slice(dot), '') : '';
  const stem = safeStem(dot > 0 ? basename.slice(0, dot) : basename, 'artifact');

  return {
    filename: `${stem}-v${row.version}${extension}`,
    // Deliberately generic: the artifact's real type is whatever wrote it, and
    // claiming a specific one we have not verified would mislead the browser.
    contentType: 'application/octet-stream',
    content: row.content ?? readArtifactFile(row, relPath),
  };
}

/**
 * Body of a file-backed artifact version.
 *
 * The path goes back through `resolveInScope` rather than being trusted as
 * stored: it was scope-checked when written, but a row is long-lived and the
 * projects root can be repointed underneath it, so the check that matters is
 * the one made now. A `scope_violation` from here is therefore a real answer
 * and is left to propagate.
 *
 * A missing file is a 404 naming the artifact rather than an empty download —
 * the version record outlives the working tree it referenced, and "the file
 * this points at is gone" is the one thing the user needs told.
 */
function readArtifactFile(row: ArtifactRow, relPath: string): string {
  if (relPath === '') {
    throw new AppError('not_found', `Artifact version "${row.id}" has no stored content.`, {
      details: { id: row.id },
    });
  }

  const absolute = resolveInScope('projects', relPath);
  if (!existsSync(absolute)) {
    throw new AppError(
      'not_found',
      `The file backing artifact version "${row.id}" is no longer on disk.`,
      { details: { id: row.id, relPath }, privateDetails: { absolute } },
    );
  }

  return readFileSync(absolute, 'utf8');
}

export interface CodeTaskExport {
  filename: string;
  contentType: string;
  content: string;
}

/** Run git for a read-only query, with the same non-interactive guards as worktree.ts. */
function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: 15_000,
        maxBuffer: 32 * 1024 * 1024,
        // Nobody can answer a credential prompt here, so it would hang until
        // the timeout rather than failing.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      },
      (error, stdout) => {
        if (error) {
          reject(
            new AppError('internal_error', 'Could not read the task\u2019s changes from git.', {
              privateDetails: { args, error: String(error) },
            }),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * A code task's changes as a unified patch.
 *
 * The diff is taken against the commit the worktree started at, so it covers
 * committed *and* uncommitted work — which is what "the changes this task
 * made" means to the person asking, regardless of whether the agent got around
 * to committing.
 */
export async function exportCodeTask(taskId: string): Promise<CodeTaskExport> {
  const worktree = getWorktree(taskId);
  if (worktree === undefined) {
    throw new AppError('not_found', `No active code task with id "${taskId}".`, {
      details: { taskId },
    });
  }

  /*
   * A `direct`-mode task has no isolation and no base commit — git was missing,
   * or the target was not a repository. There is genuinely no diff to produce,
   * and that is a fact about how the task ran rather than a server fault, so it
   * is a 400 naming the reason instead of an empty patch that looks like "this
   * task changed nothing".
   */
  if (worktree.mode === 'direct' || worktree.baseCommit === null) {
    throw new AppError(
      'bad_request',
      `Task "${taskId}" ran without git isolation, so there is no patch to export.`,
      { details: { taskId, mode: worktree.mode, reason: worktree.reason } },
    );
  }

  const content = await git(['diff', worktree.baseCommit], worktree.dir);

  return {
    filename: `${safeStem(taskId, 'task')}.patch`,
    contentType: 'text/x-patch; charset=utf-8',
    content,
  };
}
