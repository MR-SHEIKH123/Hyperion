import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import { getCodeLane, getTaskState } from '../../api/tasks';
import { CodeLaneRail, TaskSpend } from './CodeSurface';
import { getArtifactVersions } from '../../api/provenance';
import { TaskStateBanner } from '../../components/TaskStateBanner/TaskStateBanner';
import { ErrorNotice } from '../../components/ErrorNotice/ErrorNotice';
import { VersionTimeline } from '../../components/Provenance/ProvenancePanel';
import { fromBackendRun } from '../../state/task-machine/task-state';
import { AgentWorkspace } from '../../workspaces/AgentWorkspace';
import { usePersistenceStore } from '../../state/persistence/PersistenceProvider';
import styles from './CodeSurface.module.css';

import type { AgentWorkspaceDefinition, WorkspaceLayoutState, WorkspacePanelId } from '../../workspaces/AgentWorkspace.types';

/** The panel ids the frame can collapse, so a value read back from storage is checked. */
const PANEL_IDS: readonly WorkspacePanelId[] = [
  'taskRail',
  'contextExplorer',
  'mainSurface',
  'progressStream',
  'inspector',
  'versionTimeline',
  'composer',
  'statusBanner',
];

/**
 * The stored layout is a generic record of panel sizes; the frame wants a left and
 * a right width. Translating here keeps the stored shape stable across tools — the
 * frame can add a panel without a migration — and means an unrecognised panel id
 * from an older build is dropped rather than cast into the frame's union.
 */
function layoutFromStore(saved: { sizes: Record<string, number>; collapsed: string[] } | undefined): WorkspaceLayoutState | undefined {
  if (saved === undefined) return undefined;
  return {
    leftWidth: saved.sizes.left ?? 280,
    rightWidth: saved.sizes.right ?? 340,
    collapsed: saved.collapsed.filter((panel): panel is WorkspacePanelId =>
      (PANEL_IDS as readonly string[]).includes(panel),
    ),
  };
}

function layoutToStore(layout: WorkspaceLayoutState): { sizes: Record<string, number>; collapsed: string[] } {
  return { sizes: { left: layout.leftWidth, right: layout.rightWidth }, collapsed: [...layout.collapsed] };
}

import type { taskStateResponseSchema } from '../../contracts/wire/tasks';
import type { z } from 'zod';

type TaskRun = z.infer<typeof taskStateResponseSchema>['run'];

/**
 * Code — the first tool to populate the shared workspace frame (1.39 A3).
 *
 * **What this surface is.** A read view of the Code lane: what is running, what
 * is queued, what is parked holding a worktree, and — for a selected task — its
 * state, its spend and (when a file is named) its version history. It is the
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
  const store = usePersistenceStore();

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

  // Presentation memory (1.39 A5): the panel widths are remembered per tool, and
  // the layout the frame reports is the one that gets stored.
  const savedLayout = layoutFromStore(store.snapshot().projects['active']?.panelLayouts['code']);

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
      <TaskSpend taskId={taskId} usage={task.data?.usage} isPending={task.isPending} isError={task.isError} />
    ),
    progressStream: (
      <p className={styles.idle}>
        Step-by-step progress arrives on the task&rsquo;s SSE stream while it runs. This surface shows
        the persisted state instead, so a reload or a dropped connection shows the truth rather than
        an empty stream.
      </p>
    ),
    versionTimeline:
      file === null ? (
        <p className={styles.idle}>
          Name a file with <code>?file=</code> to see its version history. Versions are written per
          file, before each edit, so they belong to a file rather than to the task.
        </p>
      ) : versions.isPending ? (
        <p className={styles.idle} role="status">
          Reading versions…
        </p>
      ) : versions.isError ? (
        <ErrorNotice onRetry={() => void versions.refetch()} />
      ) : (
        <VersionTimeline versions={versions.data.versions} />
      ),
    composer: (
      <p className={styles.idle}>
        Starting a Code task from here is not built yet — tasks are started from the API, the
        scheduler or Cowork today. The lane above is live, so a task started elsewhere appears here.
      </p>
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
      </div>
    ),
  };

  return (
    <AgentWorkspace
      definition={definition}
      {...(savedLayout === undefined ? {} : { initialLayout: savedLayout })}
      onLayoutChange={(layout) => {
        const previous = store.snapshot().projects['active'];
        store.setProject('active', {
          openViewIds: previous?.openViewIds ?? {},
          selectedViewIds: previous?.selectedViewIds ?? {},
          selectedModelIds: previous?.selectedModelIds ?? {},
          lastViewedVersions: previous?.lastViewedVersions ?? {},
          panelLayouts: { ...(previous?.panelLayouts ?? {}), code: layoutToStore(layout) },
          lastTool: 'code',
        });
      }}
    />
  );
}

