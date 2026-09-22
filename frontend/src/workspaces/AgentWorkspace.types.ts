/**
 * The shape of the shared workspace frame's contents — the plug, not the case.
 *
 * `AgentWorkspaceTool` is wider than the three tools that occupy the frame today
 * (Code, Cowork, Design) on purpose: the frame itself is tool-agnostic and derives
 * nothing from this value except the `data-tool` attribute, so declaring the
 * wider set costs nothing and means a fourth occupant needs no change here. Chat
 * is in the set and not in the frame, which is a decision rather than a
 * limitation — its two-pane conversation has no task rail or progress stream to
 * fill, and it keeps its own surface.
 */
export type AgentWorkspaceTool = 'chat' | 'code' | 'cowork' | 'design' | 'playground';

export type WorkspacePanelId =
  | 'taskRail'
  | 'contextExplorer'
  | 'mainSurface'
  | 'progressStream'
  | 'inspector'
  | 'versionTimeline'
  | 'composer'
  | 'statusBanner';

/** Every panel id, in region order. A stored layout is checked against this list. */
export const WORKSPACE_PANEL_IDS: readonly WorkspacePanelId[] = [
  'taskRail',
  'contextExplorer',
  'mainSurface',
  'progressStream',
  'inspector',
  'versionTimeline',
  'composer',
  'statusBanner',
];

export interface WorkspaceLayoutState {
  leftWidth: number;
  rightWidth: number;
  collapsed: WorkspacePanelId[];
}

export interface AgentWorkspaceDefinition {
  tool: AgentWorkspaceTool;
  taskRail: React.ReactNode;
  contextExplorer?: React.ReactNode;
  mainSurface: React.ReactNode;
  progressStream: React.ReactNode;
  inspector?: React.ReactNode;
  versionTimeline?: React.ReactNode;
  composer: React.ReactNode;
  statusBanner?: React.ReactNode;
  /**
   * Which of the occupant's foldable panels may be folded, when the default set
   * (see `FOLDABLE` in `AgentWorkspace.tsx`) is wrong for this tool. It can only
   * narrow the default — an occupant cannot make the task rail unfoldable by
   * omitting the field.
   */
  collapsible?: readonly WorkspacePanelId[];
}

export interface AgentWorkspaceHandle {
  /** Focuses a region, expanding it first when the user had folded it away. */
  focusPanel(panel: WorkspacePanelId): boolean;
}
