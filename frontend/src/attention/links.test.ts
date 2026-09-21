import { describe, expect, it } from 'vitest';

import { attentionDestination, relativeTime, KIND_LABEL, KIND_TONE } from './links';
import { attentionKindList, attentionItemSchema } from '../contracts/wire/attention';

import type { AttentionItem } from '../contracts/wire/attention';

const BASE: AttentionItem = {
  id: 'approval:a1',
  kind: 'approval_required',
  tool: 'code',
  title: 'bash needs a decision',
  detail: 'The project rules deny this command.',
  createdAt: 1_700_000_000_000,
  taskId: 'task-1',
  runId: 'run-1',
  resolve: { method: 'POST', path: '/api/code/tasks/task-1/approve' },
};

const item = (overrides: Partial<AttentionItem>): AttentionItem => ({ ...BASE, ...overrides });

describe('attentionDestination', () => {
  it('opens the exact conversation for a chat item', () => {
    const destination = attentionDestination(
      item({ kind: 'paused', tool: 'chat', chatId: 'chat-9', taskId: undefined, runId: 'run-9' }),
    );
    expect(destination.href).toBe('/chat/chat-9');
    expect(destination.label).toBe('Open conversation');
  });

  it('falls back to the chat list when a chat item carries no chat id', () => {
    // The backend always sends one for a chat item; if it ever stops, the link
    // must not silently become `/chat/undefined`.
    const destination = attentionDestination(item({ kind: 'paused', tool: 'chat', chatId: undefined }));
    expect(destination.href).toBe('/chat');
  });

  it('deep-links a Code item to the Code surface, with no caveat to explain away', () => {
    // Code's workspace landed (1.39 A3), so this is a real destination: the
    // caveat would now be the lie, claiming the surface is missing.
    const destination = attentionDestination(item({}));
    expect(destination.href).toBe('/code?task=task-1&run=run-1');
    expect(destination.label).toBe('Open in Code');
    expect(destination.caveat).toBeUndefined();
  });

  it('carries the task ids to a tool surface that does not exist yet, and says so', () => {
    const destination = attentionDestination(item({ tool: 'cowork' }));
    expect(destination.href).toBe('/cowork?task=task-1&run=run-1');
    expect(destination.label).toBe('Open in Cowork');
    expect(destination.caveat).toMatch(/not built yet/);
  });

  it('sends system items to the surface that owns the setting', () => {
    expect(attentionDestination(item({ kind: 'spending_cap', tool: 'system' })).href).toBe('/settings');
    expect(attentionDestination(item({ kind: 'mcp_disconnected', tool: 'system' })).href).toBe('/settings');
    expect(attentionDestination(item({ kind: 'backup_failure', tool: 'system' })).href).toBe('/settings');
    expect(attentionDestination(item({ kind: 'scheduled_run_failed', tool: 'cowork' })).href).toBe('/cowork');
  });

  it('never hands a user an invented destination for an item with no tool', () => {
    const destination = attentionDestination(item({ kind: 'blocked', tool: 'system' }));
    expect(destination.caveat).toMatch(/without a tool/);
  });

  it('has a label and a tone for every kind the backend can send', () => {
    for (const kind of attentionKindList) {
      expect(KIND_LABEL[kind]).toBeTruthy();
      expect(KIND_TONE[kind]).toBeTruthy();
      // Every kind must map somewhere — a switch that missed one would be a row
      // with no way to act on it.
      const destination = attentionDestination(item({ kind }));
      expect(destination.href.startsWith('/')).toBe(true);
    }
  });

  it('rejects a resolve path that is not an API path', () => {
    const parsed = attentionItemSchema.safeParse({
      ...BASE,
      resolve: { method: 'POST', path: 'https://example.com/approve' },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown kind rather than rendering a generic row', () => {
    const parsed = attentionItemSchema.safeParse({ ...BASE, kind: 'something_new' });
    expect(parsed.success).toBe(false);
  });
});

describe('relativeTime', () => {
  it('reads as a queue age, and never as a negative', () => {
    const now = 1_700_000_000_000;
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 3 * 60_000, now)).toBe('3m ago');
    expect(relativeTime(now - 5 * 3_600_000, now)).toBe('5h ago');
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2d ago');
    // A clock skew between server and browser must not print "in the future".
    expect(relativeTime(now + 60_000, now)).toBe('just now');
  });
});
