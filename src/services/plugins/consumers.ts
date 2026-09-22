/**
 * The consumer side of plugin availability (Prompt 1.34).
 *
 * A hub that reports availability but is not read by anything that *uses* a
 * plugin would be a settings screen with switches wired to nothing. This module
 * is the seam the consumers call, and it exists as its own file for a plain
 * reason: the alternative was for `orchestrator/agentContext.ts` to import the
 * catalogue (which imports the memory service and both registries) to answer a
 * question about one list of skills.
 *
 * Only the skills half lives here. Memory's two call sites ask
 * `isPluginAvailableTo(MEMORY_PLUGIN_ID, tool)` directly — one expression, no
 * list to build — and Cowork's MCP readiness does the same for its server.
 */
import type { ToolName } from '../../types/core.ts';
import { skillPluginId, isPluginAvailableTo } from './availability.ts';
import { skillsSummary, type SkillSummaryEntry } from '../skills/registry.ts';

/**
 * The skills a run for `tool` may be told about: the enabled ones, minus the
 * ones this tool may not use.
 *
 * Availability is applied here rather than inside `skillsSummary()` on purpose.
 * The summary is also the Settings library's read (`GET /api/skills/summary`),
 * and a user who switched a skill off for Code must still find it in the library
 * — with the switch visible — instead of watching it disappear from the one
 * screen that could explain where it went.
 */
export function skillsAvailableTo(tool: ToolName): SkillSummaryEntry[] {
  return skillsSummary().filter((skill) => isPluginAvailableTo(skillPluginId(skill.id), tool));
}
