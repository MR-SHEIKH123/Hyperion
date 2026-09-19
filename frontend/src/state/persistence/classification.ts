const forbiddenNormalizedKeys=new Set(['apikey','apitoken','token','accesstoken','refreshtoken','oauthtoken','password','passphrase','backuppassphrase','secret','approvalsecret','credential','credentials','rawcredential','rawcredentials','privatekey']);
const normalize=(key:string)=>key.replace(/[^a-z0-9]/gi,'').toLowerCase();
export class UnsafePersistenceError extends Error{readonly name='UnsafePersistenceError';constructor(readonly path:string){super(`Sensitive field cannot be persisted at ${path}.`);}}
export function assertPersistenceSafe(value:unknown,path='$'):void{
  if(value===null||typeof value!=='object')return;
  if(Array.isArray(value)){value.forEach((item,index)=>assertPersistenceSafe(item,`${path}[${index}]`));return;}
  for(const [key,nested] of Object.entries(value as Record<string,unknown>)){
    const next=`${path}.${key}`;
    if(forbiddenNormalizedKeys.has(normalize(key)))throw new UnsafePersistenceError(next);
    assertPersistenceSafe(nested,next);
  }
}
