import { Button } from '../../design-system/components/Button/Button';
import { useModelSelection } from '../chat/useModelSelection';
import { PrivacyIndicator } from '../../components/PrivacyIndicator/PrivacyIndicator';
import styles from './StartTask.module.css';

import type { StartStream } from './useTaskStart';

/**
 * Starting a Code task from the Code surface (docs/API.md §12).
 *
 * The composer region of the shared frame had a sentence here saying that starting a
 * task was "not built yet — tasks are started from the API, the scheduler or Cowork
 * today". That sentence was true and load-bearing, and it was load-bearing in three
 * places at once: this region, the recovery panel's `resume` verb (resuming an
 * interrupted run *is* a re-run through this same route, so with no way to start a run
 * the panel could only report it), and the ledger's `tasks.recovery` status, which
 * stayed `partial` on exactly that clause. This is the control that closes them.
 *
 * **What it asks for, and what it deliberately does not.** The route needs
 * `{taskId, chatId, modelId, prompt, mode?}`. Three of those are real user decisions
 * here — the task id (the run's identity for its whole life: the worktree key, the
 * lane slot, `/api/code/tasks`), the model, and the instruction — so they are on
 * screen. `mode` defaults to `act`, the route's own default and what a Code task
 * almost always means; Plan and Ask are offered because they are how the permission
 * engine is exercised. `cwd` and `attachments` are **not** offered: this surface has
 * no project picker and no attachment store, and a control that posted a path nobody
 * chose would be guessing on the user's behalf.
 *
 * **The conversation question is answered in words, not faked.** A Code task started
 * here has no chat behind it. The route requires a `chatId` string anyway
 * (`linkedChatId`: `chat_id` is a real foreign key, and a run about to start must not
 * lose its state row over a convenience link), so the surface passes its own handle,
 * `code_<taskId>`, exactly as the scheduler does for an unattended run
 * (`sched_<task>_<runId>`). The run stores `NULL` for the chat and stays continuable.
 * The note under the form says all of that rather than leaving the user to wonder where
 * the conversation went.
 *
 * The frames of the run this starts are rendered by `RunProgress` in the progress
 * region, from the same hook instance — the state is hoisted (see `useTaskStart`), so
 * the region cannot show a different run from the one the form started.
 */
export function StartTask({ stream, onStarted }: { stream: StartStream; onStarted?: (taskId: string) => void }) {
  const model = useModelSelection(null);
  const canStart = stream.canStart && model.selectedId !== null && model.ready && model.error === null;

  return (
    <section className={styles.composer} aria-label="Start a Code task">
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          if (!canStart || model.selectedId === null) return;
          if (stream.begin(model.selectedId)) onStarted?.(stream.taskId);
        }}
      >
        <label className={styles.field}>
          <span className={styles.label}>Instruction</span>
          <textarea
            className={styles.prompt}
            value={stream.prompt}
            onChange={(event) => stream.setPrompt(event.target.value)}
            placeholder="What should this task do? It works inside its own checkout — one git worktree per task id."
            rows={3}
            disabled={stream.isStreaming}
            aria-label="Instruction"
          />
        </label>

        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.label}>Task id</span>
            <input
              className={styles.input}
              value={stream.taskId}
              onChange={(event) => stream.setTaskId(event.target.value)}
              disabled={stream.isStreaming}
              spellCheck={false}
              aria-label="Task id"
              aria-invalid={!stream.idValid}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Mode</span>
            <select
              className={styles.input}
              value={stream.mode}
              onChange={(event) => stream.setMode(event.target.value as 'ask' | 'plan' | 'act')}
              disabled={stream.isStreaming}
              aria-label="Mode"
            >
              <option value="act">Act — make the changes</option>
              <option value="plan">Plan — propose, change nothing</option>
              <option value="ask">Ask — read and answer</option>
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Model</span>
            <select
              className={styles.input}
              value={model.selectedId ?? ''}
              onChange={(event) => model.setSelectedId(event.target.value)}
              disabled={stream.isStreaming || model.models.length === 0 || model.error !== null}
              aria-label="Model"
            >
              {model.models.length === 0 ? (
                <option value="" disabled>
                  No models offered
                </option>
              ) : null}
              {model.models.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label ?? entry.id}
                </option>
              ))}
            </select>
          </label>
        </div>

        {!stream.idValid ? (
          <p className={styles.warning}>
            A task id becomes a directory name and a git branch: start with a letter or digit, then letters, digits,{' '}
            <code>.</code>, <code>-</code> or <code>_</code> — at most 100 characters, and never <code>..</code>.
          </p>
        ) : null}

        <div className={styles.actions}>
          {stream.isStreaming ? (
            <Button variant="quiet" onClick={stream.detach}>
              Stop watching
            </Button>
          ) : (
            <Button variant="primary" type="submit" disabled={!canStart}>
              Start task
            </Button>
          )}
          {model.privacy !== null ? <PrivacyIndicator privacy={model.privacy} /> : null}
        </div>
      </form>

      <p className={styles.notes}>
        {model.error !== null
          ? // The 404 this usually is, is `no_active_provider` — the model list is
            // read per active provider, so an empty install fails *here* rather than
            // returning an empty list, and "could not be read" would send the user
            // looking for a broken provider instead of a missing one. The hook's own
            // string is kept for every other failure.
            model.activeProviderId === null && model.ready
            ? 'No provider is enabled, so there is nothing to run on. Add one and enable it, then the model list appears here.'
            : `The model list could not be read: ${model.error}`
          : model.ready && model.models.length === 0
            ? 'No active provider offers a model, so there is nothing to run on. Configure a provider and its model list first.'
            : 'The task runs in its own git worktree under worktrees/<task id>.'}{' '}
        A Code task started here has no conversation attached — the run is recorded against this surface&apos;s own
        handle (<code>code_{stream.taskId}</code>), so it will not appear in a chat&apos;s history, and it stays
        continuable from this surface. Re-using a task id re-runs that same work: the leftover checkout is adopted
        rather than replaced.
      </p>

      {stream.isStreaming ? (
        <p className={styles.warning}>
          Dropping this stream stops a queued task from ever starting and leaves a running one to notice the
          disconnect. To stop the work itself, use the task&apos;s cancel.
        </p>
      ) : null}
    </section>
  );
}
