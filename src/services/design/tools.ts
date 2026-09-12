/**
 * The Design agent's closed toolset and its versioned draft store.
 *
 * Two absences are the security model, and they are deliberate: nothing here
 * touches the shell (`bash`, `command`) and nothing writes the project tree
 * (`write`). Design's only mutation surface is its own artifact lineage in
 * `artifact_versions`, plus brand *proposals* that stay unapproved until the
 * user decides — the model cannot approve its own brand writes (migration
 * 011, and §3.5 of Master Plan v4).
 *
 * Every generate/revise writes a NEW version row rather than replacing one,
 * so the history is the undo substrate: `undo` restores by writing the prior
 * content as the next version. A run that keeps revising the same bytes is
 * caught by the loop's RepeatGuard like any other degenerate cycle.
 *
 * Model-correctable mistakes (revising a draft that does not exist, undoing
 * past the first version, generating twice) come back as guidance text, not
 * thrown errors: iteration is the core loop here, and one bad call should not
 * cost the run its twenty good revisions. Unknown tool names get the same
 * treatment — a refusal the model can read — because the permission gate has
 * already classified them; the dispatch table is where "closed" is enforced.
 */
import { getDb } from '../../db/adapter.ts';
import { AppError } from '../../util/errors.ts';

import type { ToolCall, ToolSchema } from '../../types/core.ts';

export const HTML_DRAFT = 'draft.html';

export const DESIGN_TOOL_NAMES = [
  'design.generate_html',
  'design.generate_svg',
  'design.revise',
  'design.preview_snapshot',
  'design.save_asset',
  'design.brand_read',
  'design.brand_propose',
  'design.undo',
  'design.vision_verify',
] as const;

export type DesignToolName = (typeof DESIGN_TOOL_NAMES)[number];

const READ_TOOLS: ReadonlySet<string> = new Set([
  'design.preview_snapshot',
  'design.brand_read',
  'design.vision_verify',
]);

/** A draft bigger than this is a bug or abuse, not a design. */
const MAX_ARTIFACT_BYTES = 256 * 1024;

/** Artifact keys live in the `design:` namespace, distinct from Code's `code:`. */
export function designArtifactKey(runKey: string, name: string): string {
  return `design:file:${runKey}:${name}`;
}

// --- version store ---------------------------------------------------------

interface VersionRow {
  id: string;
  version: number;
  content: string | null;
  label: string | null;
  bytes: number | null;
  sha256: string | null;
  created_at: number;
}

export interface DesignVersion {
  id: string;
  artifactKey: string;
  version: number;
  content: string;
  label: string | null;
  bytes: number;
  sha256: string | null;
  createdAt: number;
}

function mapVersion(key: string, row: VersionRow): DesignVersion | null {
  // Design drafts are always inline content; a file-backed row under a design
  // key is not previewable and is treated as absent rather than followed.
  if (row.content === null) return null;
  return {
    id: row.id,
    artifactKey: key,
    version: row.version,
    content: row.content,
    label: row.label,
    bytes: row.bytes ?? Buffer.byteLength(row.content, 'utf8'),
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

export function latestDesignVersion(key: string): DesignVersion | null {
  const row = getDb()
    .prepare<VersionRow>(
      `SELECT id, version, content, label, bytes, sha256, created_at
         FROM artifact_versions
        WHERE artifact_key = ? AND tool = 'design'
        ORDER BY version DESC LIMIT 1`,
    )
    .get(key);
  return row ? mapVersion(key, row) : null;
}

/** Read one stored version for the preview route. Unknown, non-design and
 *  file-backed rows all answer null — the route must not confirm which. */
export function getDesignVersion(id: string): DesignVersion | null {
  const row = getDb()
    .prepare<VersionRow & { artifact_key: string }>(
      `SELECT id, artifact_key, version, content, label, bytes, sha256, created_at
         FROM artifact_versions
        WHERE id = ? AND tool = 'design'`,
    )
    .get(id);
  if (!row || !row.artifact_key.startsWith('design:')) return null;
  return mapVersion(row.artifact_key, row);
}

// --- schemas ---------------------------------------------------------------

const TARGET_PARAM = {
  type: 'string',
  description: `Which artifact to act on: omit for the HTML draft ("${HTML_DRAFT}"), or the filename of an SVG asset from this run.`,
};

export function designToolSchemas(): ToolSchema[] {
  return [
    {
      name: 'design.generate_html',
      description: "Create the run's HTML+CSS draft (first version). Revise afterwards; never regenerate.",
      parameters: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string', minLength: 1, description: 'A complete HTML document, CSS inline or in <style>.' },
          title: { type: 'string' },
        },
      },
    },
    {
      name: 'design.generate_svg',
      description: 'Create an SVG asset (logo, icon, illustration) as a new versioned artifact.',
      parameters: {
        type: 'object',
        required: ['filename', 'content'],
        properties: {
          filename: { type: 'string', minLength: 1, description: 'Must end in .svg' },
          content: { type: 'string', minLength: 1, description: 'The SVG document.' },
        },
      },
    },
    {
      name: 'design.revise',
      description: 'Apply one revision to an existing artifact, producing a new version. The iterative core: small, described changes.',
      parameters: {
        type: 'object',
        required: ['content', 'note'],
        properties: {
          target: TARGET_PARAM,
          content: { type: 'string', minLength: 1, description: 'The full revised document, not a diff.' },
          note: { type: 'string', minLength: 1, description: 'What this revision changes and why — it becomes the version label.' },
        },
      },
    },
    {
      name: 'design.preview_snapshot',
      description: 'Read the current state of an artifact: latest version and the URL the sandboxed preview iframe serves.',
      parameters: { type: 'object', properties: { target: TARGET_PARAM } },
    },
    {
      name: 'design.save_asset',
      description: 'Declare a version the deliverable of this run. The user closes the loop; save only finished work.',
      parameters: {
        type: 'object',
        properties: {
          target: TARGET_PARAM,
          version: { type: 'integer', minimum: 1, description: 'Defaults to the latest.' },
        },
      },
    },
    {
      name: 'design.brand_read',
      description: 'Read the approved brand assets (the canonical set). Only approved rows are ever returned.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'design.brand_propose',
      description: 'Propose a candidate brand asset (SVG). Lands unapproved; only the user can approve it.',
      parameters: {
        type: 'object',
        required: ['filename', 'content'],
        properties: {
          filename: { type: 'string', minLength: 1, description: 'Must end in .svg' },
          content: { type: 'string', minLength: 1 },
        },
      },
    },
    {
      name: 'design.undo',
      description: "Roll back the run's own last change to an artifact by restoring the previous content as a new version.",
      parameters: { type: 'object', properties: { target: TARGET_PARAM } },
    },
    {
      name: 'design.vision_verify',
      description: 'Visual verification STUB: always reports unverified. Never claim a draft was visually checked.',
      parameters: { type: 'object', properties: { target: TARGET_PARAM } },
    },
  ];
}

/** The loop reads unknown as mutating; the design names are classified here. */
export function designToolEffect(name: string): 'read' | 'mutate' | undefined {
  if (READ_TOOLS.has(name)) return 'read';
  if ((DESIGN_TOOL_NAMES as readonly string[]).includes(name)) return 'mutate';
  return undefined;
}

// --- dispatch --------------------------------------------------------------

import fs from 'node:fs';

import { assetPath } from '../storage/gallery.ts';

import type { AgentContext } from '../../types/core.ts';
import type { AssetPublic, AssetRecord, SaveAssetInput } from '../storage/gallery.ts';

/** What one design run mutates: the undo stacks, and the declared deliverables. */
export interface DesignRunState {
  /** The id used in artifact keys — the run id when the caller has one. */
  runKey: string;
  /** Per artifact: the content states this run overwrote, oldest first. null
   *  marks "the artifact did not exist before this run created it". */
  undo: Map<string, { content: string | null }[]>;
  deliverables: { key: string; version: number }[];
}

export function createDesignRunState(runKey: string): DesignRunState {
  return { runKey, undo: new Map(), deliverables: [] };
}

/** The two gallery seams the brand tools use; injectable for tests. */
export interface DesignToolServices {
  listApprovedAssets?: () => AssetPublic[];
  saveAsset?: (input: SaveAssetInput) => Promise<AssetRecord>;
}

const MAX_INLINE_BRAND_BYTES = 32 * 1024;
const UNDO_STACK_LIMIT = 100;

function parseArguments(raw: string): Record<string, unknown> {
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

function requiredString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError('bad_request', `${field} must be a non-empty string.`, { details: { field } });
  }
  return value;
}

function optionalString(args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError('bad_request', `${field} must be a non-empty string.`, { details: { field } });
  }
  return value;
}

function boundedContent(args: Record<string, unknown>, field: string): string {
  const content = requiredString(args, field);
  if (Buffer.byteLength(content, 'utf8') > MAX_ARTIFACT_BYTES) {
    throw new AppError('bad_request', `${field} exceeds the ${MAX_ARTIFACT_BYTES}-byte artifact limit.`, { details: { field } });
  }
  return content;
}

function targetName(args: Record<string, unknown>): string {
  return optionalString(args, 'target') ?? HTML_DRAFT;
}

function pushUndo(state: DesignRunState, key: string, content: string | null): void {
  const stack = state.undo.get(key) ?? [];
  if (stack.length >= UNDO_STACK_LIMIT) stack.shift();
  stack.push({ content });
  state.undo.set(key, stack);
}

function saveVersion(ctx: AgentContext, key: string, content: string, label: string | null): DesignVersion {
  ctx.saveArtifactVersion({
    artifactKey: key,
    tool: 'design',
    content,
    ...(label === null ? {} : { label }),
  });
  const stored = latestDesignVersion(key);
  if (!stored) {
    throw new AppError('internal_error', 'A design version was saved but could not be read back.');
  }
  return stored;
}

function previewUrl(version: DesignVersion): string {
  return `/api/design/preview/${version.id}`;
}

function describe(version: DesignVersion): string {
  return `${version.artifactKey.split(':').pop()} version ${version.version} (${version.bytes} bytes). Preview: ${previewUrl(version)}`;
}

function svgFilename(args: Record<string, unknown>): string | null {
  const filename = requiredString(args, 'filename');
  if (/[\\/]/.test(filename) || !/\.svg$/i.test(filename)) return null;
  return filename;
}

export async function dispatchDesignTool(
  call: ToolCall,
  state: DesignRunState,
  ctx: AgentContext,
  services: DesignToolServices,
): Promise<string> {
  const args = parseArguments(call.arguments);
  const key = designArtifactKey(state.runKey, targetName(args));

  switch (call.name) {
    case 'design.generate_html':
    case 'design.generate_svg': {
      const content = boundedContent(args, 'content');
      let name = HTML_DRAFT;
      if (call.name === 'design.generate_svg') {
        const filename = svgFilename(args);
        if (filename === null) {
          return 'generate_svg needs a plain filename ending in .svg (no directories). Nothing was saved.';
        }
        if (!content.includes('<svg')) {
          return 'The content does not look like an SVG document (no <svg element). Nothing was saved.';
        }
        name = filename;
      }
      const artifactKey = designArtifactKey(state.runKey, name);
      const existing = latestDesignVersion(artifactKey);
      if (existing) {
        return `${name} already exists at version ${existing.version}. Call design.revise with your changes — regenerating would discard the revision history.`;
      }
      pushUndo(state, artifactKey, null);
      const label = call.name === 'design.generate_html' ? optionalString(args, 'title') ?? null : name;
      const saved = saveVersion(ctx, artifactKey, content, label);
      return `Created ${describe(saved)}`;
    }

    case 'design.revise': {
      const content = boundedContent(args, 'content');
      const note = requiredString(args, 'note');
      const existing = latestDesignVersion(key);
      if (!existing) {
        return `Nothing exists at that target yet. Generate it first (design.generate_html / design.generate_svg), then revise.`;
      }
      pushUndo(state, key, existing.content);
      const saved = saveVersion(ctx, key, content, note);
      return `Revised: ${describe(saved)} Revision note: ${note}`;
    }

    case 'design.preview_snapshot': {
      const existing = latestDesignVersion(key);
      if (!existing) return 'Nothing exists at that target yet — nothing to preview.';
      return JSON.stringify({
        artifactKey: existing.artifactKey,
        version: existing.version,
        versionId: existing.id,
        previewUrl: previewUrl(existing),
        bytes: existing.bytes,
        sha256: existing.sha256,
        label: existing.label,
      });
    }

    case 'design.save_asset': {
      const requested = args.version;
      if (requested !== undefined && (typeof requested !== 'number' || !Number.isInteger(requested) || requested < 1)) {
        throw new AppError('bad_request', 'version must be a positive integer.', { details: { field: 'version' } });
      }
      const existing = latestDesignVersion(key);
      if (!existing) return 'Nothing exists at that target yet — nothing to save.';
      if (requested !== undefined && requested !== existing.version) {
        return `Only the latest version (${existing.version}) can be the deliverable; earlier versions stay browsable history.`;
      }
      if (state.deliverables.some((d) => d.key === key && d.version === existing.version)) {
        return `${describe(existing)} is already the declared deliverable.`;
      }
      state.deliverables.push({ key, version: existing.version });
      return `Saved as the deliverable: ${describe(existing)}`;
    }

    case 'design.undo': {
      const stack = state.undo.get(key) ?? [];
      const prior = stack.pop();
      if (prior === undefined) {
        return 'Nothing to undo: this run has not changed that target, or its changes are all undone already.';
      }
      if (prior.content === null) {
        return 'That was the first version of the target — there is no earlier state to restore. The draft stays as it is.';
      }
      const current = latestDesignVersion(key);
      const saved = saveVersion(ctx, key, prior.content, `undo: back to the state before version ${current?.version ?? '?'}`);
      return `Undone: ${describe(saved)}`;
    }

    case 'design.brand_read': {
      const list = (services.listApprovedAssets ?? (() => []))();
      if (list.length === 0) return 'No brand assets are approved yet. Only approved assets are canonical.';
      const assets = list.map((asset) => {
        let inline: string | undefined;
        if (asset.mimeType === 'image/svg+xml' && asset.bytes <= MAX_INLINE_BRAND_BYTES && !asset.missing) {
          try {
            inline = fs.readFileSync(assetPath(asset), 'utf8');
          } catch {
            inline = undefined;
          }
        }
        return {
          id: asset.id,
          filename: asset.filename,
          mimeType: asset.mimeType,
          url: asset.url,
          bytes: asset.bytes,
          approvedAt: asset.brandApprovedAt,
          ...(inline === undefined ? {} : { svg: inline }),
        };
      });
      return JSON.stringify({ approved: assets });
    }

    case 'design.brand_propose': {
      const save = services.saveAsset;
      if (!save) throw new AppError('internal_error', 'Brand storage is not wired into this run.');
      const filename = svgFilename(args);
      if (filename === null) {
        return 'brand_propose needs a plain filename ending in .svg (no directories). Nothing was saved.';
      }
      const content = boundedContent(args, 'content');
      if (!content.includes('<svg')) {
        return 'The content does not look like an SVG document (no <svg element). Nothing was saved.';
      }
      const asset = await save({
        filename,
        buffer: Buffer.from(content, 'utf8'),
        mimeType: 'image/svg+xml',
        origin: 'generated',
        tool: 'design',
      });
      return `Proposed brand asset ${asset.id} (${asset.filename}). It is NOT approved: approval is the user\'s decision, and this asset must not be treated as canonical brand until then.`;
    }

    case 'design.vision_verify': {
      return JSON.stringify({
        status: 'unverified',
        checks: [
          { name: 'layout_integrity', status: 'pending' },
          { name: 'contrast', status: 'pending' },
          { name: 'brand_adherence', status: 'pending' },
        ],
        note: 'Visual verification is not implemented. Report the draft as unverified; never claim it was visually checked.',
      });
    }

    default:
      return `"${call.name}" is not available to the Design agent. The toolset is closed: ${DESIGN_TOOL_NAMES.join(', ')}. Continue with those.`;
  }
}
