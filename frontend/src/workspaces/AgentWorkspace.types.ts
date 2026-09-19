import type{ReactNode}from'react';
export type AgentWorkspaceTool='code'|'design'|'cowork';
export type WorkspacePanelId='taskRail'|'contextExplorer'|'mainSurface'|'progressStream'|'inspector'|'versionTimeline'|'composer'|'statusBanner';
export interface WorkspaceLayoutState{leftWidth:number;rightWidth:number;collapsed:WorkspacePanelId[];}
export interface AgentWorkspaceDefinition{
 tool:AgentWorkspaceTool;taskRail:ReactNode;contextExplorer?:ReactNode;mainSurface:ReactNode;progressStream:ReactNode;inspector?:ReactNode;versionTimeline?:ReactNode;composer:ReactNode;statusBanner?:ReactNode;
}
export interface AgentWorkspaceHandle{focusPanel(panel:WorkspacePanelId):boolean;}
