import{forwardRef,useImperativeHandle,useMemo,useRef,useState,type CSSProperties,type KeyboardEvent}from'react';
import type{AgentWorkspaceDefinition,AgentWorkspaceHandle,WorkspaceLayoutState,WorkspacePanelId}from'./AgentWorkspace.types';import styles from'./AgentWorkspace.module.css';
export interface AgentWorkspaceProps{definition:AgentWorkspaceDefinition;initialLayout?:Partial<WorkspaceLayoutState>;onLayoutChange?:(layout:WorkspaceLayoutState)=>void;}
type WorkspaceStyle=CSSProperties&{'--left-width':string;'--right-width':string};
const clamp=(value:number)=>Math.min(520,Math.max(240,value));
export const AgentWorkspace=forwardRef<AgentWorkspaceHandle,AgentWorkspaceProps>(function AgentWorkspace({definition,initialLayout,onLayoutChange},ref){
 const[layout,setLayout]=useState<WorkspaceLayoutState>(()=>({leftWidth:clamp(initialLayout?.leftWidth??280),rightWidth:clamp(initialLayout?.rightWidth??340),collapsed:initialLayout?.collapsed??[]}));
 const regions=useRef(new Map<WorkspacePanelId,HTMLElement>());
 const available=useMemo(()=>new Set<WorkspacePanelId>(['taskRail',...(definition.contextExplorer===undefined?[]:['contextExplorer']as WorkspacePanelId[]),'mainSurface','progressStream',...(definition.inspector===undefined?[]:['inspector']as WorkspacePanelId[]),...(definition.versionTimeline===undefined?[]:['versionTimeline']as WorkspacePanelId[]),'composer',...(definition.statusBanner===undefined?[]:['statusBanner']as WorkspacePanelId[])]),[definition]);
 useImperativeHandle(ref,()=>({focusPanel(panel){if(!available.has(panel))return false;regions.current.get(panel)?.focus();return regions.current.has(panel);}}),[available]);
 const register=(id:WorkspacePanelId)=>(node:HTMLElement|null)=>{if(node===null)regions.current.delete(id);else regions.current.set(id,node);};
 const update=(side:'left'|'right',delta:number)=>{setLayout(current=>{const next={...current,[side==='left'?'leftWidth':'rightWidth']:clamp(current[side==='left'?'leftWidth':'rightWidth']+delta)};onLayoutChange?.(next);return next;});};
 const resizeKey=(side:'left'|'right')=>(event:KeyboardEvent<HTMLDivElement>)=>{if(event.key==='ArrowLeft'){event.preventDefault();update(side,side==='left'?-16:16);}if(event.key==='ArrowRight'){event.preventDefault();update(side,side==='left'?16:-16);}};
 const panel=(id:WorkspacePanelId,label:string,content:React.ReactNode)=><section ref={register(id)} tabIndex={-1} data-panel={id} aria-label={label} className={`${styles.panel} ${styles.region}`}>{content}</section>;
 const style:WorkspaceStyle={'--left-width':`${layout.leftWidth}px`,'--right-width':`${layout.rightWidth}px`};
 return <div className={styles.frame} data-tool={definition.tool}>
  <div className={styles.workspace} style={style}>
   {definition.statusBanner!==undefined&&<div className={styles.status}>{panel('statusBanner','Task status',definition.statusBanner)}</div>}
   <aside className={styles.left} aria-label={`${definition.tool} navigation`}>{panel('taskRail','Tasks',definition.taskRail)}{definition.contextExplorer!==undefined&&panel('contextExplorer','Context explorer',definition.contextExplorer)}</aside>
   <main className={styles.main}>{panel('mainSurface','Main workspace',definition.mainSurface)}{panel('progressStream','Task progress',definition.progressStream)}</main>
   {(definition.inspector!==undefined||definition.versionTimeline!==undefined)&&<aside className={styles.right} aria-label={`${definition.tool} inspector`}>{definition.inspector!==undefined&&panel('inspector','Inspector',definition.inspector)}{definition.versionTimeline!==undefined&&panel('versionTimeline','Version timeline',definition.versionTimeline)}</aside>}
   <div className={styles.composer}>{panel('composer','Task composer',definition.composer)}</div>
  </div>
  {/* ARIA's separator pattern is focusable when it controls a resizable split pane. */}
  {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
  <div className={styles.resizeLeft} role="separator" tabIndex={0} aria-label="Resize navigation panels" aria-orientation="vertical" aria-valuemin={240} aria-valuemax={520} aria-valuenow={layout.leftWidth} onKeyDown={resizeKey('left')}/>
  {(definition.inspector!==undefined||definition.versionTimeline!==undefined)&&<>
   {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
   <div className={styles.resizeRight} role="separator" tabIndex={0} aria-label="Resize inspector panels" aria-orientation="vertical" aria-valuemin={240} aria-valuemax={520} aria-valuenow={layout.rightWidth} onKeyDown={resizeKey('right')}/>
  </>} 
 </div>;
});
