import type { ArtifactVersion, RunKnowledgeSource } from '../../contracts/wire/provenance';

/**
 * Provenance fixtures (Prompt 1.39 A6) for the dev harness.
 *
 * Written to show the three things a real version list does, because those are
 * the ones a display gets wrong: a first version with no parent, a middle version
 * that names what it replaced, and a digest that was never recorded. The
 * timestamps are fixed so a screenshot is reproducible.
 */
const T = 1_766_000_000_000;

export const artifactVersionsFixture: ArtifactVersion[] = [
  {
    id: 'ver-3',
    artifactKey: 'plan.md',
    tool: 'code',
    version: 3,
    label: 'present',
    inline: true,
    bytes: 812,
    sha256: '9f2c1ad4f1b30c0d3b7e6a5c41d2e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293a',
    createdAt: T - 60_000,
    parentVersion: 2,
  },
  {
    id: 'ver-2',
    artifactKey: 'plan.md',
    tool: 'code',
    version: 2,
    label: 'present',
    inline: true,
    bytes: 640,
    sha256: '4b8e0c9d2a1f3e5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b',
    createdAt: T - 120_000,
    parentVersion: 1,
  },
  {
    /**
     * The state before the first edit — and the one entry that says what a missing
     * record looks like: a version saved by a path that did not hash it, so the
     * display has to say "not hashed" rather than showing an empty digest.
     */
    id: 'ver-1',
    artifactKey: 'plan.md',
    tool: 'code',
    version: 1,
    label: 'the file before this task touched it',
    inline: true,
    bytes: 512,
    sha256: null,
    createdAt: T - 180_000,
    parentVersion: null,
  },
];

export const knowledgeSourcesFixture: RunKnowledgeSource[] = [
  {
    sourceId: 'src-house-style',
    label: 'House style',
    filename: 'style.md',
    bytes: 4096,
    sha256: 'c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2',
    usedAt: T - 30_000,
  },
  {
    sourceId: 'src-release-notes',
    label: null,
    filename: 'release-notes-2026.csv',
    bytes: 1204,
    sha256: null,
    usedAt: T - 30_000,
  },
];
