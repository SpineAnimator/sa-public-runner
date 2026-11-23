/** Private GitHub generation archive. Every library bucket counts ALL descendant files. */
import {webcrypto} from 'node:crypto';
const C=globalThis.crypto||webcrypto, te=new TextEncoder(), td=new TextDecoder();
const MAX_FILES=999, ID=/^c\d{4}_[a-z0-9]{26}$/, BUCKET=/^library_\d{4}$/;
const hex=bytes=>Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('');
export const digest=async bytes=>hex(await C.subtle.digest('SHA-256',typeof bytes==='string'?te.encode(bytes):bytes));
const b64=b=>Buffer.from(b).toString('base64'),unb64=s=>new Uint8Array(Buffer.from(s,'base64'));
const url64=b=>Buffer.from(b).toString('base64url');
const equal=(a,b)=>{if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let n=0;for(let i=0;i<a.length;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0;};
export class ArchiveError extends Error{constructor(status,code,message){super(message);this.status=status;this.code=code;}}
const reject=(status,code,message)=>{throw new ArchiveError(status,code,message);};
export function safePath(path){if(typeof path!=='string'||!path||path.length>250||path.startsWith('/')||/[\\\r\n\x00]/.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..'||p.startsWith('.')))reject(400,'PATH','Invalid artifact path');return path;}
export function selectBucket(buckets,fileCount){
 if(!Number.isInteger(fileCount)||fileCount<1||fileCount>MAX_FILES)reject(413,'FILE_LIMIT','One generation exceeds 999 repository files');
 const sorted=[...buckets].sort((a,b)=>b.number-a.number);
 for(const b of sorted)if(b.files+fileCount<=MAX_FILES)return {name:'library_'+String(b.number).padStart(4,'0'),number:b.number};
 const number=(sorted[0]?.number||0)+1;if(number>9999)reject(507,'CATALOG_FULL','Library bucket namespace exhausted');return {name:'library_'+String(number).padStart(4,'0'),number};
}
export function createAccess({secret,now=()=>Date.now(),lifetime=30*86400}={}){
 if(typeof secret!=='string'||secret.length<32)throw Error('A server-only session secret of at least 32 characters is required');
 const key=C.subtle.importKey('raw',te.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
 const sign=async p=>{const payload=url64(te.encode(JSON.stringify(p))),sig=await C.subtle.sign('HMAC',await key,te.encode(payload));return payload+'.'+url64(sig);};
 return {
  async issue(subject){if(subject!==undefined&&(!/^anon_[a-f0-9]{32}$/.test(subject)))reject(400,'SUBJECT','Invalid anonymous identity');const sub=subject||'anon_'+hex(C.getRandomValues(new Uint8Array(16)));return {token:await sign({sub,aud:'spine-generation-owner',iat:Math.floor(now()/1000),exp:Math.floor(now()/1000)+lifetime}),subject:sub};},
  async issueForRecovery(recoveryKey){
   if(typeof recoveryKey!=='string'||!/^[a-f0-9]{64}$/.test(recoveryKey))
    reject(400,'RECOVERY_KEY','A 256-bit recovery key is required');
   const derived=hex(await C.subtle.sign('HMAC',await key,te.encode('2spine-recovery-v1:'+recoveryKey)));
   const sub='anon_'+derived.slice(0,32);
   return {token:await sign({sub,aud:'spine-generation-owner',iat:Math.floor(now()/1000),exp:Math.floor(now()/1000)+lifetime}),
    subject:sub};
  },
  async verify(token){try{const [p,s,extra]=String(token).split('.');if(extra||!p||!s||!await C.subtle.verify('HMAC',await key,Buffer.from(s,'base64url'),te.encode(p)))return null;const v=JSON.parse(td.decode(Buffer.from(p,'base64url')));if(v.aud!=='spine-generation-owner'||!/^anon_[a-f0-9]{32}$/.test(v.sub)||!Number.isFinite(v.exp)||v.exp<=now()/1000)return null;return Object.freeze({subject:v.sub,kind:'anonymous'});}catch{return null;}},
  // Production profile attachment must call an authenticated server identity
  // resolver. A client-supplied profile/user ID is never an authorization grant.
 };
}
export function createGenerationStore({repository,token,access,fetchImpl=fetch,now=()=>new Date(),siteOrigin='https://spineanimator.github.io',verifyVisualReview=async()=>null,verifyPoseReview=async()=>null,maxBlobBytes=48*1024*1024}={}){
 if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository||'')||!token||!access?.verify)throw Error('Private repository, credential and access verifier are required');
 const origin=new URL(siteOrigin);if(origin.protocol!=='https:')throw Error('Generation links require HTTPS');
 const base='/repos/'+repository;
 async function api(method,path,body){const response=await fetchImpl('https://api.github.com'+path,{method,headers:{authorization:'Bearer '+token,accept:'application/vnd.github+json','content-type':'application/json','user-agent':'SpineAnimator-private-library'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});if(!response.ok){const e=new ArchiveError(response.status,'GITHUB','Private archive operation failed');throw e;}return response.status===204?null:response.json();}
 async function privateRepo(){const r=await api('GET',base);if(r.private!==true)reject(503,'PRIVATE_REPOSITORY_REQUIRED','Generation storage is disabled because the repository is public');return r;}
 async function jsonAt(path,ref){try{const v=await api('GET',base+'/contents/'+path+(ref?'?ref='+encodeURIComponent(ref):''));return JSON.parse(td.decode(unb64(v.content)));}catch(e){if(e.status===404)return null;throw e;}}
 async function head(){const repo=await privateRepo(),branch=repo.default_branch||'main',ref=await api('GET',base+'/git/ref/heads/'+encodeURIComponent(branch)),commit=await api('GET',base+'/git/commits/'+ref.object.sha);return {branch,sha:ref.object.sha,tree:commit.tree.sha};}
 async function buckets(tree){const root=await api('GET',base+'/git/trees/'+tree),out=[];if(root.truncated)reject(503,'TREE_INCOMPLETE','Archive tree must be complete');for(const e of root.tree||[])if(e.type==='tree'&&BUCKET.test(e.path)){const t=await api('GET',base+'/git/trees/'+e.sha+'?recursive=1');if(t.truncated)reject(503,'TREE_INCOMPLETE','Archive tree must be complete');const files=t.tree.filter(x=>x.type==='blob').length;if(files>MAX_FILES)reject(503,'EXISTING_FILE_LIMIT','An existing library bucket already exceeds 999 files');out.push({number:Number(e.path.slice(8)),files});}return out;}
 async function principal(ownerToken){const p=await access.verify(ownerToken);if(!p)reject(401,'AUTH_REQUIRED','An authenticated generation session is required');return p;}
 async function authorize(id,bearer){if(!ID.test(id||''))reject(404,'NOT_FOUND','Generation unavailable');await privateRepo();const catalog=await jsonAt('catalog.json'),item=catalog?.generations?.[id];if(!item)reject(404,'NOT_FOUND','Generation unavailable');const record=await jsonAt(item.path+'/generation.json');if(!record)reject(404,'NOT_FOUND','Generation unavailable');const owner=await access.verify(bearer),readHash=await digest(String(bearer||''));if(owner?.subject!==record.owner.subject&&!equal(readHash,record.access.readKeySha256))reject(404,'NOT_FOUND','Generation unavailable');return {record,path:item.path,isOwner:owner?.subject===record.owner.subject};}
 return {
  async create(ownerToken,request){
   const owner=await principal(ownerToken);if(!request||typeof request!=='object'||request.owner||request.userId||request.profileId)reject(400,'OWNER_FROM_SERVER_ONLY','Owners must be resolved by the server session');
   const files=request.files;if(!Array.isArray(files)||!files.length)reject(400,'FILES','Generation files are required');
   const names=new Set();let total=0;const prepared=[];
   for(const f of files){const path=safePath(f.path);if(['generation.json','visual-review.json'].includes(path)||names.has(path))reject(400,'DUPLICATE_PATH','Artifact paths must be unique and not reserved');names.add(path);if(!(f.bytes instanceof Uint8Array))reject(400,'BYTES','Artifact bytes are required');total+=f.bytes.length;if(f.bytes.length>maxBlobBytes||total>maxBlobBytes)reject(413,'BYTE_LIMIT','Generation exceeds repository upload byte limit');prepared.push({path,bytes:f.bytes,sha256:await digest(f.bytes),size:f.bytes.length});}
   const fileCount=prepared.length+2;if(fileCount>MAX_FILES)reject(413,'FILE_LIMIT','One generation exceeds the library file limit');
   const artifact=prepared.find(f=>f.path==='artifact.zip')||prepared[0];
   // Fail closed: a single visual similarity report is NOT approval of all poses.
   // These callbacks must independently verify server-issued review proofs,
   // never trust a user-supplied JSON flag or a structural runtime report.
   const review=await verifyVisualReview(request.visualReviewToken,{artifactSha256:artifact.sha256});
   const pose=await verifyPoseReview(request.poseReviewToken,{artifactSha256:artifact.sha256});
   const visualApproved=review?.approved===true&&review.artifactSha256===artifact.sha256&&review.primaryCriterion==='visual'&&typeof review.etalonId==='string'&&!!review.etalonId;
   const poseApproved=pose?.approved===true&&pose.status==='verified'&&pose.archiveSha256===artifact.sha256&&pose.editorVersion==='4.3.26'&&
     Number.isInteger(pose.expectedFrames)&&pose.expectedFrames>0&&pose.approvedFrames===pose.expectedFrames&&
     Array.isArray(pose.failures)&&pose.failures.length===0&&Array.isArray(pose.clips)&&pose.clips.length>0&&
     pose.clips.every(c=>Number.isInteger(c.expectedFrames)&&c.expectedFrames>0&&c.approvedFrames===c.expectedFrames&&
       Array.isArray(c.failedCheckpoints)&&c.failedCheckpoints.length===0)&&
     pose.clips.reduce((n,c)=>n+c.expectedFrames,0)===pose.expectedFrames;
   const approved=visualApproved&&poseApproved;
   const stamp=now().toISOString(),requestKey=typeof request.idempotencyKey==='string'&&request.idempotencyKey.length<=200?request.idempotencyKey:null;
   if(!requestKey)reject(400,'IDEMPOTENCY_KEY','A stable generation request ID is required');
   const requestHash=await digest(owner.subject+'|'+requestKey),suffix=requestHash.slice(0,26),readKey=url64(C.getRandomValues(new Uint8Array(32))),readHash=await digest(readKey);
   for(let attempt=0;attempt<5;attempt++){
    const h=await head(),catalog=await jsonAt('catalog.json',h.sha)||{version:1,generations:{},requests:{}},existing=catalog.requests[requestHash];
    if(existing){const old=await authorize(existing,ownerToken);if(old.record.artifactSha256!==artifact.sha256)reject(409,'IDEMPOTENCY_CONFLICT','This generation request ID was used for different bytes');return {id:existing,path:old.path,created:false,ownerOnly:true,url:origin.origin+'/g/'+existing,commit:old.record.createdInParent,visualStatus:old.record.visual.status};}
    const bucket=selectBucket(await buckets(h.tree),fileCount),id='c'+String(bucket.number).padStart(4,'0')+'_'+suffix,path=bucket.name+'/'+id;
    const record={schemaVersion:1,id,path,createdAt:stamp,createdInParent:h.sha,owner:{subject:owner.subject,kind:owner.kind,profileId:null},access:{visibility:'private',readKeySha256:readHash},artifactSha256:artifact.sha256,files:prepared.map(({path,sha256,size})=>({path,sha256,size})),prompt:typeof request.prompt==='string'?request.prompt.slice(0,20000):'',visual:{status:approved?'verified':'pending',primaryCriterion:'visual+all-poses',etalonId:visualApproved?review.etalonId:null,report:visualApproved?review:null},pose:{status:poseApproved?'verified':'pending',report:poseApproved?pose:null},publishable:approved,history:{immutable:true,parentGenerationId:request.parentGenerationId||null}};
    if(record.history.parentGenerationId)await authorize(record.history.parentGenerationId,ownerToken);
    const all=[...prepared,{path:'generation.json',bytes:te.encode(JSON.stringify(record,null,2))},{path:'visual-review.json',bytes:te.encode(JSON.stringify(record.visual,null,2))}];
    catalog.generations[id]={path,bucket:bucket.name};catalog.requests[requestHash]=id;
    const indexBytes=te.encode(JSON.stringify(catalog));if(indexBytes.length>8*1024*1024)reject(507,'INDEX_FULL','Archive index requires a planned migration');
    const entries=[];for(const f of all){const b=await api('POST',base+'/git/blobs',{content:b64(f.bytes),encoding:'base64'});entries.push({path:path+'/'+f.path,mode:'100644',type:'blob',sha:b.sha});}
    const ib=await api('POST',base+'/git/blobs',{content:b64(indexBytes),encoding:'base64'});entries.push({path:'catalog.json',mode:'100644',type:'blob',sha:ib.sha});
    const tree=await api('POST',base+'/git/trees',{base_tree:h.tree,tree:entries}),commit=await api('POST',base+'/git/commits',{message:'Archive generation '+id+' ('+record.visual.status+')',tree:tree.sha,parents:[h.sha]});
    try{await privateRepo();await api('PATCH',base+'/git/refs/heads/'+encodeURIComponent(h.branch),{sha:commit.sha,force:false});return {id,path,created:true,url:origin.origin+'/g/'+id+'#k='+readKey,commit:commit.sha,visualStatus:record.visual.status,publishable:approved};}catch(e){if(![409,422].includes(e.status))throw e;}
   }
   reject(409,'CONCURRENT_WRITE','Archive changed repeatedly; retry the same request ID');
  },
  async read(id,bearer){const {record,isOwner}=await authorize(id,bearer);const {access:_,owner,...safe}=record;return {...safe,isOwner,owner:isOwner?owner:{kind:owner.kind}};},
  async artifact(id,bearer,file='artifact.zip'){const {record,path}=await authorize(id,bearer);safePath(file);const known=record.files.find(x=>x.path===file);if(!known)reject(404,'NOT_FOUND','Generation unavailable');const data=await api('GET',base+'/contents/'+path+'/'+file),bytes=unb64(data.content);if(await digest(bytes)!==known.sha256)reject(503,'INTEGRITY','Archived artifact integrity check failed');return bytes;}
 };
}
