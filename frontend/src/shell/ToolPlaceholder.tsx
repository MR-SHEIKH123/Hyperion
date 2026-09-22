import { useLocation, useSearchParams } from 'react-router-dom';
import styles from './ToolPlaceholder.module.css';

/**
 * Honest placeholder for tools whose increment has not landed yet. States what
 * the tool is for and that it is not built here — no fake panels, no dead
 * controls. Replaced by the real tool when its milestone ships.
 */
const DESCRIPTIONS: Record<string, string> = {
  code: 'Multi-file editing in per-task git worktrees, terminal execution, and one-level subagents.',
  cowork: 'Knowledge-first research, scheduled tasks, and versioned artifacts.',
  design: 'Iterative HTML/CSS + SVG drafts with brand memory and a sandboxed preview.',
  playground: 'Direct, tool-less model exploration against the active provider.',
  plugins: 'Per-tool plugin availability across the workbench.',
  skills: 'Intake, risk-scan, and registry for SKILL.md-based skills.',
  settings: 'Providers, preferences, limits, and system configuration.',
};

export function ToolPlaceholder() {
  const location = useLocation();
  const [params] = useSearchParams();
  const tool = location.pathname.split('/').filter(Boolean)[0] ?? 'chat';
  const label = tool.charAt(0).toUpperCase() + tool.slice(1);
  const description = DESCRIPTIONS[tool] ?? 'A Hyperion tool.';

  // The Attention queue deep-links a waiting task here, with its ids attached. The
  // honest answer is not a fake task view: it is to name the task, say which state
  // it is in (waiting on you), and say that the live view is the thing still
  // missing. An empty page would look like the queue had lost the task.
  const taskId = params.get('task');
  const runId = params.get('run');

  return (
    <section className={styles.placeholder} aria-labelledby={`${tool}-placeholder-title`}>
      <h1 id={`${tool}-placeholder-title`} className={styles.title}>{label}</h1>
      <p className={styles.description}>{description}</p>
      {taskId === null ? null : (
        <p className={styles.task} role="note" data-task={taskId}>
          <strong>{taskId}</strong> is waiting on you
          {runId === null ? '' : ` (run ${runId})`}. The live view of a {label} task does not exist
          yet, so this page is where the queue’s link lands: the task itself is real and its state
          comes from the API.
        </p>
      )}
      <p className={styles.pending} role="note">
        Not built in this frontend milestone yet — the {label.toLowerCase()} backend is live, and this
        interface lands in a later increment.
      </p>
    </section>
  );
}

export default ToolPlaceholder;
