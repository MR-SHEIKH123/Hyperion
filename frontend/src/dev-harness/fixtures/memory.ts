import type { MemoryEntryWire, MemoryImportWire, MemoryStatusWire } from '../../contracts/wire/memory';

/**
 * Memory fixtures for the dev harness (Settings 2.5, slice 3a), typed
 * against the wire schemas. The three status fixtures are the point:
 * disabled, enabled-but-unavailable, and enabled are different answers
 * and the harness shows all three rather than a tidy default.
 */
export const memoryDisabledFixture: MemoryStatusWire = {
  enabled: false,
  available: false,
  error: null,
  llmModel: 'gpt-4o-mini',
  embedModel: 'text-embedding-3-small',
  retrieveLimit: 5,
  storeDir: '/home/user/Hyperion/Hyperion/memory',
};

export const memoryUnavailableFixture: MemoryStatusWire = {
  ...memoryDisabledFixture,
  enabled: true,
  available: false,
  error: 'mem0ai could not be imported (No module named mem0).',
};

export const memoryAvailableFixture: MemoryStatusWire = {
  ...memoryDisabledFixture,
  enabled: true,
  available: true,
};

export const memoryEntriesFixture: MemoryEntryWire[] = [
  {
    id: 'mem-1',
    memory: 'Prefers tea over coffee; takes it without sugar.',
    createdAt: '2026-10-01T09:15:00.000Z',
    updatedAt: null,
    score: null,
    tool: 'chat',
    chatId: 'chat-9',
  },
  {
    id: 'mem-2',
    memory: 'Works in the Asia/Dhaka timezone and keeps Fridays free.',
    createdAt: '2026-10-03T18:42:00.000Z',
    updatedAt: '2026-10-04T08:00:00.000Z',
    score: null,
    tool: 'settings',
    chatId: null,
  },
];

export const memoryImportFixture: MemoryImportWire = {
  imported: 3,
  dropped: 1,
  found: 4,
  error: null,
  files: [
    { name: 'prefs.md', imported: 2, dropped: 0, found: 2, error: null },
    { name: 'notes.txt', imported: 1, dropped: 1, found: 2, error: null },
    { name: 'scan.pdf', imported: 0, dropped: 0, found: 0, error: 'The file is not readable as text.' },
  ],
};
