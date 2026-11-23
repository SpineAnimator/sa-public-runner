/** Private, owner-bound motion-history sync. Raw PSD pixels are never sent.
 * Records live in the preconfigured PRIVATE GitHub archive repository, grouped by
 * HMAC-derived anonymous owner and SHA-256 source provenance.
 */
import {ArchiveError} from './generation-store.mjs';
const SHA=/^[a-f0-9]{64}$/, ID=/^c\d{4}_[a-z0-9]{26}$/, MAX_RECORDS=128;
const fail=(code,msg,status=400)=>{throw new ArchiveError(status,code,msg);};
function safeRecord(r){
 if(!r||r.version!==1||!ID.test(r.id||'')||!SHA.test(r.sourceSha256||'')||
    !Array.isArray(r.fingerprints)||!r.fingerprints.length||r.fingerprints.length>64)
  fail('MOTION_RECORD','Invalid private motion fingerprint record');
 if(typeof r.createdAt!=='string'||!Number.isFinite(Date.parse(r.createdAt)))
  fail('MOTION_TIMESTAMP','Invalid record timestamp');
 for(const f of r.fingerprints){
  if(f?.version!==1||typeof f.clipId!=='string'||!f.clipId||f.clipId.length>200||
     !Number.isInteger(f.samples)||f.samples<9||f.samples>33||
     !Array.isArray(f.selectedNodes)||f.selectedNodes.length<1||f.selectedNodes.length>256||
     f.selectedNodes.some(x=>typeof x!=='string'||!x||x.length>200)||
     f.complete!==true||!Array.isArray(f.vector)||!f.vector.length||f.vector.length>40000||
     f.vector.some(v=>typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>1))
   fail('MOTION_FINGERPRINT','Incomplete fingerprints cannot be persisted as a cross-device uniqueness check');
 }
 const clean={version:1,id:r.id,sourceSha256:r.sourceSha256,createdAt:r.createdAt,
  fingerprints:r.fingerprints.map(f=>({version:1,clipId:f.clipId,samples:f.samples,
   selectedNodes:f.selectedNodes,complete:true,vector:f.vector})),visualVerified:false};
 if(JSON.stringify(clean).length>380000)fail('MOTION_SIZE','Motion record exceeds privacy storage limit',413);
 return clean;
}
export function createMotionHistory({repository,token,access,fetchImpl=fetch}={}){
 if(!repository||!token||!access?.verify)throw Error('Private motion history requires archive credentials');
 const base='https://api.github.com/repos/'+repository,enc=new TextEncoder();
 const github=async(method,path,body)=>{
  const response=await fetchImpl(base+path,{method,headers:{authorization:'Bearer '+token,
   accept:'application/vnd.github+json','content-type':'application/json',
   'user-agent':'2Spine-private-motion-history'},
   body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  if(!response.ok){if(method==='GET'&&response.status===404)return null;
   throw new ArchiveError(response.status,'MOTION_BACKEND','Private motion storage unavailable');}
  return response.json();
 };
 async function privateRepo(){
   // Never cache the visibility decision. A repository changed to public must
   // stop serving and accepting motion fingerprints immediately.
   const info=await github('GET','');
   if(info?.private!==true)
    fail('PRIVATE_REPOSITORY_REQUIRED','History must never be saved in a public repository',503);
 }
 async function owner(token){
  const principal=await access.verify(token);
  if(!principal||!/^anon_[a-f0-9]{32}$/.test(principal.subject))
    fail('AUTH_REQUIRED','Authenticated owner session required',401);
  await privateRepo();
  return principal.subject;
 }
 const location=(subject,hash)=>'/contents/motion-history/'+subject+'/'+hash+'.json';
 async function load(subject,sourceSha256){
  const remote=await github('GET',location(subject,sourceSha256));
  if(!remote)return {sha:null,records:[]};
  let parsed;
  try{parsed=JSON.parse(Buffer.from(remote.content,'base64').toString('utf8'));}
  catch(_){fail('MOTION_CORRUPT','Private motion history is corrupt',503);}
  if(parsed?.version!==1||parsed.sourceSha256!==sourceSha256||
     !Array.isArray(parsed.records)||parsed.records.length>MAX_RECORDS)
   fail('MOTION_CORRUPT','Private motion history is inconsistent',503);
  return {sha:remote.sha,records:parsed.records};
 }
 return {
  async list(token,sourceSha256){
   if(!SHA.test(sourceSha256||''))fail('MOTION_SOURCE','SHA-256 provenance required');
   const sub=await owner(token),data=await load(sub,sourceSha256);
   return {scope:'authenticated-owner',sourceSha256,records:data.records,
    synchronized:true,visualVerified:false};
  },
  async save(token,input){
   const record=safeRecord(input),sub=await owner(token),
    path=location(sub,record.sourceSha256),dataLength=enc.encode(JSON.stringify(record)).length;
   if(dataLength>400000)fail('MOTION_SIZE','Fingerprint too large',413);
   for(let attempt=0;attempt<4;attempt++){
    const current=await load(sub,record.sourceSha256);
    const existing=current.records.find(x=>x.id===record.id);
    if(existing){
     if(JSON.stringify(existing)!==JSON.stringify(record))
      fail('MOTION_CONFLICT','Generation ID already has different fingerprints',409);
     return {stored:true,created:false,sourceSha256:record.sourceSha256};
    }
    const next=[...current.records,record].slice(-MAX_RECORDS);
    const content=Buffer.from(JSON.stringify({version:1,sourceSha256:record.sourceSha256,
     records:next})).toString('base64');
    if(content.length>3800000)fail('MOTION_SIZE','Private history needs pruning before another append',413);
    try{
     await github('PUT',path,{message:'Append private motion preflight record',
      content,...(current.sha?{sha:current.sha}:{})});
     return {stored:true,created:true,sourceSha256:record.sourceSha256};
    }catch(error){
     if(![409,422].includes(error.status)||attempt===3)throw error;
    }
   }
   fail('MOTION_CONCURRENT_WRITE','Private history changed during save',409);
  }
 };
}
