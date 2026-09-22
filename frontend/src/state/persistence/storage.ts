import { assertPersistenceSafe } from './classification';
import { migratePersistedState } from './migrations';
import { emptyPersistedState,persistedStateV1Schema,type PersistedStateV1,type safeDraftSchema,type projectPresentationSchema,type navigationHintSchema,type ScrollAnchor } from './schemas';
import type { z } from 'zod';

export const PERSISTENCE_KEY='hyperion.frontend.state';
type SafeDraft=z.infer<typeof safeDraftSchema>;type ProjectPresentation=z.infer<typeof projectPresentationSchema>;type NavigationHint=z.infer<typeof navigationHintSchema>;
export interface StorageLike{getItem(key:string):string|null;setItem(key:string,value:string):void;removeItem(key:string):void;}
export class PersistenceStore{
  private state:PersistedStateV1;
  constructor(private readonly storage:StorageLike,key=PERSISTENCE_KEY){this.key=key;this.state=this.read();}
  private readonly key:string;
  snapshot():PersistedStateV1{return structuredClone(this.state);}
  setProject(projectId:string,value:ProjectPresentation):void{this.commit({...this.state,projects:{...this.state.projects,[projectId]:value}});}
  removeProject(projectId:string):void{const projects={...this.state.projects};delete projects[projectId];this.commit({...this.state,projects});}
  setDraft(id:string,value:SafeDraft):void{this.commit({...this.state,drafts:{...this.state.drafts,[id]:value}});}
  removeDraft(id:string):void{const drafts={...this.state.drafts};delete drafts[id];this.commit({...this.state,drafts});}
  setNavigationHints(hints:NavigationHint[]):void{this.commit({...this.state,navigationHints:hints});}
  setScrollAnchor(viewKey:string,anchor:ScrollAnchor):void{this.commit({...this.state,scrollAnchors:{...this.state.scrollAnchors,[viewKey]:anchor}});}
  removeScrollAnchor(viewKey:string):void{const scrollAnchors={...this.state.scrollAnchors};delete scrollAnchors[viewKey];this.commit({...this.state,scrollAnchors});}
  replace(value:unknown):void{assertPersistenceSafe(value);const parsed=persistedStateV1Schema.parse(value);this.commit(parsed);}
  clear():void{this.state=emptyPersistedState();try{this.storage.removeItem(this.key);}catch{/* Storage denial must not block the app. */}}
  private read():PersistedStateV1{let raw:string|null;try{raw=this.storage.getItem(this.key);}catch{return emptyPersistedState();}if(raw===null)return emptyPersistedState();try{const value=JSON.parse(raw) as unknown;assertPersistenceSafe(value);return migratePersistedState(value);}catch{return emptyPersistedState();}}
  private commit(next:PersistedStateV1):void{
    assertPersistenceSafe(next);const parsed=persistedStateV1Schema.parse(next);
    // A refused write (private mode, quota, a hostile storage shim) must not throw out
    // of a keystroke or a scroll. The state still advances in memory, so this session
    // keeps the draft and the reading position; the browser just will not remember it.
    try{this.storage.setItem(this.key,JSON.stringify(parsed));}catch{/* Denied storage is not an application failure. */}
    this.state=parsed;
  }
}
