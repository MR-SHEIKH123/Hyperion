/**
 * Synchronous production composition for in-process agent capabilities.
 *
 * Registration is intentionally separate from module construction and lifecycle
 * startup. This gives boot one auditable boundary and ensures HTTP and scheduled
 * work see the same modules before either can begin.
 */
import { registerAgent, registerTerminal } from '../../orchestrator/agents.ts';
import { createCodeAgent } from '../code/agent.ts';
import { createCoworkAgent } from '../cowork/agent.ts';
import { createDesignAgent } from '../design/agent.ts';
import { terminalModule } from '../terminal/executor.ts';

export function registerProductionModules(): void {
  registerAgent('cowork', createCoworkAgent());
  registerAgent('code', createCodeAgent());
  registerAgent('design', createDesignAgent());
  registerTerminal(terminalModule);
}