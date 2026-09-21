/**
 * The availability question, and the ids it is asked about (Prompt 1.34).
 *
 * This module is deliberately a **leaf**: it imports the database module and the
 * tool vocabulary, and nothing else. The hub needs the registries (MCP servers,
 * skills, memory) to build a catalogue, and the modules that must *honour*
 * availability — memory itself, the agent context, Cowork's MCP use — would
 * otherwise have to import the hub, which imports them. That cycle is not
 * hypothetical: it is exactly the shape that bit the MCP supervisor before. So
 * the enforcement side imports this file, the presentation side imports the hub,
 * and neither imports the other.
 *
 * Plugin ids are composite and opaque: `mcp:<server id>`, `skill:<skill id>`,
 * `builtin:memory`. They cross an HTTP path segment, so the helpers here are the
 * single place that knows how they are spelled — a route that hand-built one
 * would eventually spell it differently from the writer.
 */
import { TOOLS, type ToolName } from '../../types/core.ts';
import { listPluginAvailability, type PluginAvailabilityRow } from '../../db/plugins.ts';

export type PluginKind = 'mcp' | 'skill' | 'builtin';

/** The Memory plugin. A built-in: it ships with Hyperion and has no install step. */
export const MEMORY_PLUGIN_ID = 'builtin:memory';

export function mcpPluginId(serverId: string): string {
  return `mcp:${serverId}`;
}

export function skillPluginId(skillId: string): string {
  return `skill:${skillId}`;
}

/** True for a string shaped like a plugin id. Does not mean the subject exists. */
export function isPluginId(value: string): boolean {
  return /^(mcp|skill|builtin):.+$/.test(value);
}

/** Is `tool` a tool this build has? Ids may be older than the check. */
export function isToolName(value: string): value is ToolName {
  return (TOOLS as readonly string[]).includes(value);
}

/**
 * Fold the stored overrides over the default.
 *
 * The default is `true` — available — for the reason migration `025` argues:
 * absence of a decision is not a decision to switch something off. This is the
 * only place that fold happens, so a reader and a writer cannot disagree about
 * what an empty table means.
 */
export function availabilityMap(rows: readonly PluginAvailabilityRow[]): {
  availability: Record<ToolName, boolean>;
  updatedAt: number | null;
} {
  const availability = {} as Record<ToolName, boolean>;
  for (const tool of TOOLS) availability[tool] = true;
  let updatedAt: number | null = null;
  for (const row of rows) {
    if (!isToolName(row.tool)) continue; // A row written by a build with another tool.
    availability[row.tool] = row.available;
    updatedAt = updatedAt === null ? row.updatedAt : Math.max(updatedAt, row.updatedAt);
  }
  return { availability, updatedAt };
}

/**
 * May `tool` use this plugin?
 *
 * Asked by the consumers: memory's recall and remember paths, the agent context
 * that lists skills, and Cowork's use of its MCP server. An unknown tool (a row
 * written by a newer build) falls back to the default rather than to `false`:
 * refusing would make this build *less* capable than the one that wrote the row.
 */
export function isPluginAvailableTo(pluginId: string, tool: ToolName): boolean {
  const rows = listPluginAvailability().filter((row) => row.pluginId === pluginId);
  return availabilityMap(rows).availability[tool];
}

/**
 * Is the plugin available to **any** tool?
 *
 * For a consumer that cannot name the tool it is acting for (a scheduled job, a
 * read with no run behind it), "someone may use this" is the honest question —
 * and it is deliberately not "everyone may", which would resurrect a plugin the
 * user switched off everywhere.
 */
export function isPluginAvailableAnywhere(pluginId: string): boolean {
  const rows = listPluginAvailability().filter((row) => row.pluginId === pluginId);
  const { availability } = availabilityMap(rows);
  return TOOLS.some((tool) => availability[tool]);
}
