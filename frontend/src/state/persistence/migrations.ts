import { emptyPersistedState,persistedStateV1Schema,type PersistedStateV1 } from './schemas';

interface LegacyV0{version:0;projects?:unknown;drafts?:unknown;navigationHints?:unknown;}
export function migratePersistedState(input:unknown):PersistedStateV1{
  const current=persistedStateV1Schema.safeParse(input);if(current.success)return current.data;
  if(typeof input==='object'&&input!==null&&(input as {version?:unknown}).version===0){
    const legacy=input as LegacyV0;
    const candidate={version:1,projects:legacy.projects??{},drafts:legacy.drafts??{},navigationHints:legacy.navigationHints??[]};
    const migrated=persistedStateV1Schema.safeParse(candidate);if(migrated.success)return migrated.data;
  }
  return emptyPersistedState();
}
