import { useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import { getCodeLane, getTaskRecovery, getTaskState } from '../../api/tasks';
import { RecoveryPanel } from '../../components/RecoveryPanel/RecoveryPanel';
import { ParkedTask } from './ParkedTask';
import { ChangedFiles } from './ChangedFiles';
import { PreviewRow } from './PreviewRow';
import { CanvasTabs } from './CanvasTabs';
import { useCanvasTab } from './useCanvasTab';
import { Processes } from './Processes';
import { StartTask } from './StartTask';
import { RunProgress } from './RunProgress';
import { useTaskStart } from './useTaskStart';
import { CodeLaneRail, TaskSpend } from './CodeSurface';
import { getArtifactVersions } from '../../api/provenance';
import { SelectionTimeline } from './SelectionTimeline';
import { TaskStateBanner } from '../../components/TaskStateBanner/TaskStateBanner';
import { fromBackendRun } from '../../state/task-machine/task-state';
import { AgentWorkspace } from '../../workspaces/AgentWorkspace';
import { useWorkspaceLayout } from '../../state/persistence/useWorkspaceLayout';
import styles from './CodeSurface.module.css';

import type { AgentWorkspaceDefinition, AgentWorkspaceHandle } from '../../workspaces/AgentWorkspace.types';

import type { taskStateResponseSchema } from '../../contracts/wire/tasks';
import type { z } from 'zod';

type TaskRun = z.infer<typeof taskStateResponseSchema>['run'];

/**
 * Code — the first tool to populate the shared workspace frame (1.39 A3).
 *
 * **What this surface is.** A read view of the Code lane: what is running, what
 * is queued, what is parked holding a worktree, and — for a selected task — its
 * state, its spend and (when a file is named) its version history. A task whose
 * run was **interrupted** also gets the recovery panel in this region, because
 * that state carries a decision — what survived, and whether to keep the leftover
 * checkout — that a badge cannot express (1.31). It is the
 * destination the Attention Center's Code items already deep-link to, so the ids
 * in `?task=` and `?file=` are the contract between the two.
 *
 * **What this surface is not, stated rather than implied by a missing control.**
 * It does not *start* a task: `POST /api/code/run-task` streams an SSE session and
 * deserves the same care the chat stream got, which is its own piece of work. The
 * composer region says that in words instead of rendering a disabled box that
 * looks like a bug, and it is the one region of the frame that is honest about
 * being unfinished.
 *
 * **Why the rail is the lane and not a list of tasks.** The backend has no
 * per-project task history (`frontend/contracts/gaps.md` names it), and inventing
 * one in the browser from a live view would be a lie that decays: a finished task
 * would vanish on reload while a cached list looked stable. So the rail shows what
 * the lane actually reports, including its capacity, and the empty state says
 * "nothing is running" rather than "you have no tasks".
 */
export default function CodeTool() {
  const [params, setParams] = useSearchParams();
  const taskId = params.get('task');
  const file = params.get('file');
  const [canvasTab, setCanvasTab] = useCanvasTab(taskId ?? '');

  const selectFile = (path: string, openDiff = false) => {
    const next = new URLSearchParams(params);
    next.set('file', path);
    setParams(next, { replace: true });
    if (openDiff) setCanvasTab('diff');
  };
  // Presentation memory (1.39 A5): the panel widths and folds are remembered per
  // tool. The frame owns the translation; this surface only hands over what it
  // last left behind (see `useWorkspaceLayout`).
  const layout = useWorkspaceLayout('code');
  // Owned here, not inside the composer: the composer renders the controls, and the
  // progress region renders the frames of the run those controls started. One hook
  // instance is what makes them provably the same run.
  const start = useTaskStart();
  // The frame's own handle, for one thing: the recovery panel's resume gesture fills
  // the composer with the interrupted task's id, and a handoff the user cannot see is
  // not a handoff. `focusPanel` expands the region if it was folded away, which is
  // exactly the case this exists for.
  const frame = useRef<AgentWorkspaceHandle>(null);

  const lane = useQuery({ queryKey: ['code', 'lane'], queryFn: ({ signal }) => getCodeLane(signal), retry: false, refetchInterval: 10_000 });
  const task = useQuery({
    queryKey: ['code', 'task', taskId],
    queryFn: ({ signal }) => getTaskState('code', taskId ?? '', signal),
    enabled: taskId !== null,
    retry: false,
  });
  const versions = useQuery({
    queryKey: ['provenance', 'versions', file],
    queryFn: ({ signal }) => getArtifactVersions(file ?? '', signal),
    enabled: file !== null,
    retry: false,
  });
  // The steps column of the same rail. The same query key `RecoveryPanel` uses, so
  // a task that is both interrupted and selected is read once, and the two views
  // cannot disagree about what the run did.
  //
  // Gated on a selected file, and that is a cost decision rather than a
  // presentational one: the recovery route is the only read that carries steps,
  // and answering it runs a worktree check (`findOrphanForTask`) for every caller
  // whether or not there is a recovery case. The rail only exists once a file is
  // named, so the read is made then — one read per selection, shared with the
  // recovery panel, never on a poll.
  const steps = useQuery({
    queryKey: ['recovery', 'code', taskId],
    queryFn: ({ signal }) => getTaskRecovery('code', taskId ?? '', signal),
    enabled: taskId !== null && file !== null,
    retry: false,
  });

  const state = useMemo(() => {
    const run: TaskRun | undefined = task.data?.run;
    return run === undefined ? null : fromBackendRun(run);
  }, [task.data?.run]);

  const definition: AgentWorkspaceDefinition = {
    tool: 'code',
    statusBanner:
      state === null ? (
        <p className={styles.idle}>No task is selected. Pick one from the lane, or open a link from the Attention Center.</p>
      ) : (
        <TaskStateBanner state={state} />
      ),
    taskRail: <CodeLaneRail lane={lane.data} isPending={lane.isPending} isError={lane.isError} selectedTaskId={taskId} />,
    mainSurface: taskId === null ? (
      <p className={styles.idle}>
        Nothing to show yet. Selecting a task in the lane shows its state and recorded spend; the
        attention queue links here with the task already chosen.
      </p>
    ) : (
      <CanvasTabs taskId={taskId} file={file} activeTab={canvasTab} onTabChange={setCanvasTab}
        onSelectFile={(path) => selectFile(path)}>
        {state?.kind === 'interrupted' ? (
          // The one state where a read is not enough: an interrupted run has a
          // decision attached to it, and the frame's main region is where the
          // surface answers its own banner (1.31).
          <RecoveryPanel
            tool="code"
            taskId={taskId}
            onResume={(resumeTaskId) => {
              start.setTaskId(resumeTaskId);
              frame.current?.focusPanel('composer');
            }}
          />
        ) : null}
        {state?.kind === 'approval_required' || state?.kind === 'ready_for_review' ? (
          // The parked states, and the only place a parked task can be continued:
          // both are `isParked` on the server, which is what `/continue` accepts.
          // The backend's `paused` state is deliberately *not* here — it is a park
          // with no continuation path (`not_parked`), and offering the button would
          // make the surface promise something the route refuses.
          <ParkedTask
            tool="code"
            taskId={taskId}
            state={task.data?.run.state ?? ''}
            pauseReason={state.kind === 'approval_required' ? state.reason : (task.data?.run.pauseReason ?? null)}
          />
        ) : null}
        <TaskSpend taskId={taskId} usage={task.data?.usage} isPending={task.isPending} isError={task.isError} />
      </CanvasTabs>
    ),
    // The progress region is where a run this surface started streams. A task started
    // elsewhere is shown by its persisted state in the main region, and this says so
    // rather than looking like a stream that never arrived.
    progressStream: (
      <RunProgress
        state={start.state}
        taskId={start.isStreaming || start.state.phase === 'ended' ? start.taskId : null}
        onDismiss={start.state.phase === 'ended' ? start.dismiss : undefined}
      />
    ),
    versionTimeline: (
      <SelectionTimeline
        taskId={taskId}
        file={file}
        versions={{ isPending: versions.isPending, isError: versions.isError, data: versions.data?.versions }}
        onRetryVersions={() => void versions.refetch()}
        steps={{ isPending: steps.isPending, isError: steps.isError, data: steps.data }}
        onRetrySteps={() => void steps.refetch()}
      />
    ),
    // Starting a task is the composer's job, and `onStarted` is what makes the surface
    // follow the run it just began: the id goes into `?task=`, so the main region and
    // the banner show the task whose frames are arriving.
    composer: (
      <StartTask
        stream={start}
        onStarted={(startedTaskId) => {
          const next = new URLSearchParams(params);
          next.set('task', startedTaskId);
          setParams(next, { replace: true });
        }}
      />
    ),
    inspector: (
      <div className={styles.inspector}>
        <h3 className={styles.heading}>Selection</h3>
        <p className={styles.meta}>
          {taskId === null ? 'No task' : `Task ${taskId}`}
          {file === null ? '' : ` · file ${file}`}
        </p>
        <button
          type="button"
          className={styles.clear}
          disabled={taskId === null && file === null}
          onClick={() => {
            const next = new URLSearchParams(params);
            next.delete('task');
            next.delete('file');
            setParams(next, { replace: true });
          }}
        >
          Clear selection
        </button>
        {/* The task's changes, which is what a reader asks about a task that has
            been running. Selecting a file writes `?file=`, the same parameter the
            version timeline already reads, so the two regions stay in step
            without either one knowing about the other. */}
        {taskId !== null && (
          <ChangedFiles
            taskId={taskId}
            selectedPath={file}
            onSelect={(path) => selectFile(path, true)}
          />
        )}
        {/* The live preview, under the changes because that is the order a
            reader asks: what changed, then where it is running. Like the file
            list, it needs a task — there is nothing to serve without one. */}
        {taskId !== null && <PreviewRow taskId={taskId} />}
        {/* Processes is not scoped to a task the way the two rows above are: the
            route lists sessions for the whole process, and hiding the ones bound
            elsewhere would make this host look idle when it is not. The selected
            task is a label here, not a filter. */}
        <Processes taskId={taskId} />
      </div>
    ),
  };

  return (
    <AgentWorkspace
      ref={frame}
      definition={definition}
      {...(layout.initialLayout === undefined ? {} : { initialLayout: layout.initialLayout })}
      onLayoutChange={layout.onLayoutChange}
    />
  );
}

