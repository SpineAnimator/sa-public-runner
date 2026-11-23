/** Authenticated private library API. No repository credential ever reaches a client. */
import {createAccess,createGenerationStore,ArchiveError} from './generation-store.mjs';
import {createMotionHistory} from './motion-history.mjs';
import {createHash} from 'node:crypto';
const limit=64*1024*1024;
const bearer=request=>{const m=(request.headers.get('authorization')||'').match(/^Bearer ([A-Za-z0-9_.-]+)$/);return m?m[1]:'';};
async function json(request){if(!/^application\/json(?:;|$)/i.test(request.headers.get('content-type')||''))throw new ArchiveError(415,'CONTENT_TYPE','JSON is required');if(Number(request.headers.get('content-length'))>limit)throw new ArchiveError(413,'BODY_LIMIT','Archive request is too large');const reader=request.body?.getReader(),chunks=[];let size=0;if(reader)for(;;){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>limit){await reader.cancel();throw new ArchiveError(413,'BODY_LIMIT','Archive request is too large');}chunks.push(p.value);}const bytes=new Uint8Array(size);let i=0;for(const c of chunks){bytes.set(c,i);i+=c.length;}try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new ArchiveError(400,'JSON','Invalid request JSON');}}

const assetLimit=64*1024*1024;
const assetExtensions=new Set(['.psd','.psb','.png','.jpg','.jpeg','.webp','.gif','.zip','.json','.atlas','.skel','.spine','.txt','.md','.yaml','.yml','.toml','.csv','.xml','.js','.mjs','.ts','.py','.html','.css','.pdf','.wasm','.bin','.bytes','.mp4','.webm','.mov','.glb','.gltf','.obj','.fbx','.blend','.jsonl','.json5','.ini','.cfg','.sh','.ps1','.c','.h','.cpp','.rs','.go','.java','.kt','.swift','.lua','.gd','.tscn','.tres']);
const assetHosts=new Set(['files.catbox.moe','litter.catbox.moe']);

function assetName(value){
 const name=String(value||'asset.bin').split(String.fromCharCode(92)).join('/').split('/').pop().replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,120);
 const dot=name.lastIndexOf('.');
 if(dot<1||!assetExtensions.has(name.slice(dot).toLowerCase()))throw new ArchiveError(415,'ASSET_TYPE','Unsupported Spine asset type');
 return name;
}
async function assetBytes(request){
 const form=await request.formData(),file=form.get('file');
 if(!file||typeof file.arrayBuffer!=='function'||typeof file.size!=='number')throw new ArchiveError(400,'ASSET_FILE','A file field is required');
 if(file.size<1||file.size>assetLimit)throw new ArchiveError(413,'ASSET_LIMIT','Asset is empty or exceeds 64 MiB');
 const name=assetName(file.name);
 const bytes=new Uint8Array(await file.arrayBuffer());
 if(bytes.length!==file.size)throw new ArchiveError(400,'ASSET_SIZE','Asset size changed during read');
 const ext=name.slice(name.lastIndexOf('.')).toLowerCase();
 const starts=(...v)=>v.every((x,i)=>bytes[i]===x);
 if((ext==='.psd'||ext==='.psb')&&(!starts(0x38,0x42,0x50,0x53)||bytes[4]!==0||bytes[5]!== (ext==='.psd'?1:2)))throw new ArchiveError(415,'ASSET_SIGNATURE','PSD/PSB signature or version is invalid');
 if(ext==='.png'&&!starts(0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a))throw new ArchiveError(415,'ASSET_SIGNATURE','PNG signature is invalid');
 if((ext==='.jpg'||ext==='.jpeg')&&!starts(0xff,0xd8,0xff))throw new ArchiveError(415,'ASSET_SIGNATURE','JPEG signature is invalid');
 if(ext==='.gif'&&!(starts(0x47,0x49,0x46,0x38,0x37,0x61)||starts(0x47,0x49,0x46,0x38,0x39,0x61)))throw new ArchiveError(415,'ASSET_SIGNATURE','GIF signature is invalid');
 if(ext==='.webp'&&!(starts(0x52,0x49,0x46,0x46)&&bytes.length>=12&&starts(0x57,0x45,0x42,0x50)))throw new ArchiveError(415,'ASSET_SIGNATURE','WebP signature is invalid');
 if(ext==='.zip'&&!starts(0x50,0x4b))throw new ArchiveError(415,'ASSET_SIGNATURE','ZIP signature is invalid');
 if(ext==='.pdf'&&!starts(0x25,0x50,0x44,0x46))throw new ArchiveError(415,'ASSET_SIGNATURE','PDF signature is invalid');
 if(ext==='.wasm'&&!starts(0x00,0x61,0x73,0x6d))throw new ArchiveError(415,'ASSET_SIGNATURE','WASM signature is invalid');
 if(ext==='.glb'&&!starts(0x67,0x6c,0x54,0x46))throw new ArchiveError(415,'ASSET_SIGNATURE','GLB signature is invalid');
 if(ext==='.webm'&&!starts(0x1a,0x45,0xdf,0xa3))throw new ArchiveError(415,'ASSET_SIGNATURE','WebM signature is invalid');
 if((ext==='.mp4'||ext==='.mov')&&!(bytes.length>=12&&bytes[4]===0x66&&bytes[5]===0x74&&bytes[6]===0x79&&bytes[7]===0x70))throw new ArchiveError(415,'ASSET_SIGNATURE','MP4/MOV signature is invalid');
 if(ext==='.blend'&&!starts(0x42,0x4c,0x45,0x4e,0x44,0x45,0x52))throw new ArchiveError(415,'ASSET_SIGNATURE','Blender signature is invalid');
 return {name,bytes,type:file.type||'application/octet-stream'};
}
async function catboxRequest(fetchImpl,url,init,stage){
 let lastNetworkError=null,lastStatus=null;
 for(let attempt=1;attempt<=3;attempt++){
  try{
   const response=await fetchImpl(url,init);
   if(response.ok)return {response,attempts:attempt};
   lastStatus=response.status;
   if(![408,425,429].includes(response.status)&&response.status<500)
    throw new ArchiveError(502,`CATBOX_${stage}_HTTP`,`Catbox ${stage.toLowerCase()} returned HTTP ${response.status}`);
  }catch(error){
   if(error instanceof ArchiveError)throw error;
   lastNetworkError=error;
  }
  if(attempt<3)await new Promise(resolve=>setTimeout(resolve,150*attempt));
 }
 if(lastStatus!==null)throw new ArchiveError(502,`CATBOX_${stage}_HTTP`,`Catbox ${stage.toLowerCase()} failed after 3 attempts (HTTP ${lastStatus})`);
 const errorName=String(lastNetworkError?.name||'NetworkError').replace(/[^A-Za-z0-9_-]/g,'').slice(0,40)||'NetworkError';
 throw new ArchiveError(502,`CATBOX_${stage}_NETWORK`,`Catbox ${stage.toLowerCase()} failed after 3 network attempts (${errorName})`);
}
async function verifyHostedAsset({url,bytes,sha256,fetchImpl,stage}){
 const verification=await catboxRequest(fetchImpl,url,{method:'GET',redirect:'error'},stage);
 if(!verification.response.body)throw new ArchiveError(502,'CATBOX_VERIFY','Uploaded Catbox asset could not be downloaded');
 const reader=verification.response.body.getReader(),remoteHash=createHash('sha256');let size=0;
 try{
  for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>assetLimit){await reader.cancel();throw new ArchiveError(413,'CATBOX_VERIFY_LIMIT','Downloaded Catbox asset exceeds verification limit');}remoteHash.update(part.value);}
 }catch(error){
  if(error instanceof ArchiveError)throw error;
  throw new ArchiveError(502,'CATBOX_VERIFY_NETWORK','Catbox verification download was interrupted');
 }
 if(size!==bytes.byteLength||remoteHash.digest('hex')!==sha256)
  throw new ArchiveError(502,'CATBOX_MISMATCH','Downloaded Catbox asset does not match the source SHA-256 and byte count');
 return verification.attempts;
}
function hostedUrl(raw,hosts){
 let url;try{url=new URL(String(raw||'').trim());}catch{throw new ArchiveError(502,'CATBOX_RESPONSE','Catbox returned an invalid URL');}
 if(url.protocol!=='https:'||!hosts.has(url.hostname)||url.username||url.password||url.port||url.search||url.hash||url.pathname.length<2)
  throw new ArchiveError(502,'CATBOX_HOST','Catbox returned a URL outside the approved host list');
 return url;
}
const assetChunk=16*1024*1024,assetTTL=2592000;
async function uploadVerifiedCloudflareKV({name,bytes,type,sha256,env,fallbackReason}){
 let stage='binding';
 try{
  const ns=env.ASSET_FILES;if(!ns)throw new ArchiveError(503,'ASSET_RELAY_UNAVAILABLE','First-party asset storage is not configured');
  stage='id';const id=crypto.randomUUID().replace(/-/g,''),prefix='sa-assets:'+id+':',chunks=Math.ceil(bytes.byteLength/assetChunk);
  stage='chunk-put';
  for(let i=0;i<chunks;i++){const part=bytes.slice(i*assetChunk,Math.min(bytes.byteLength,(i+1)*assetChunk));await ns.put(prefix+'chunk:'+i,part.buffer,{expirationTtl:assetTTL});}
  stage='manifest-put';
  const expiresAt=new Date(Date.now()+assetTTL*1000).toISOString();
  const manifest={version:1,id,name,mime:type||'application/octet-stream',bytes:bytes.byteLength,sha256,chunks,createdAt:new Date().toISOString(),expiresAt,fallbackReason:fallbackReason||'CATBOX_UNAVAILABLE'};
  await ns.put(prefix+'manifest',JSON.stringify(manifest),{expirationTtl:assetTTL});
  stage='readback';let verified=false,verificationAttempts=0;
  for(let attempt=0;attempt<5&&!verified;attempt++){
   verificationAttempts=attempt+1;
   const restored=new Uint8Array(bytes.byteLength);let offset=0,complete=true;
   for(let i=0;i<chunks;i++){const part=await ns.get(prefix+'chunk:'+i,{type:'arrayBuffer'});if(!part){complete=false;break;}restored.set(new Uint8Array(part),offset);offset+=part.byteLength;}
   if(complete&&offset===bytes.byteLength&&createHash('sha256').update(restored).digest('hex')===sha256)verified=true;
   else if(attempt<4)await new Promise(resolve=>setTimeout(resolve,150*(attempt+1)));
  }
  if(!verified)throw new ArchiveError(503,'ASSET_RELAY_VERIFY','Cloudflare KV read-back verification failed');
  stage='receipt';
  const origin=String(env.ASSET_PUBLIC_ORIGIN||'https://spine-archive.spine-animator-f8692224.workers.dev').trim();
  let base;
  try{
   base=new URL(origin);
   if(base.protocol!=='https:'||base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw new Error('invalid origin');
  }catch{throw new ArchiveError(503,'ASSET_PUBLIC_ORIGIN','Asset public origin is not configured correctly');}
  const url=new URL('/api/assets/'+id+'/'+encodeURIComponent(name),base).toString();
  return {provider:'cloudflare-kv',url,filename:name,mime:type||'application/octet-stream',visibility:'public',temporary:false,expiresIn:'30d',expiresAt,
   bytes:bytes.byteLength,sha256,verified:true,verification:'kv-readback-sha256',uploadAttempts:0,verificationAttempts,fallbackReason:fallbackReason||'CATBOX_UNAVAILABLE'};
 }catch(error){
  if(error instanceof ArchiveError)throw error;
  const errorName=String(error?.name||'Error').replace(/[^A-Za-z0-9_-]/g,'').slice(0,32)||'Error';
  throw new ArchiveError(502,'ASSET_RELAY_KV_'+stage.toUpperCase(),'Cloudflare KV '+stage+' failed ('+errorName+')');
 }
}
async function getPublicAsset(id,encodedName,env){
 let name;try{name=decodeURIComponent(encodedName);}catch{throw new ArchiveError(400,'ASSET_NAME','Asset filename is invalid');}
 const ns=env.ASSET_FILES;if(!ns)throw new ArchiveError(503,'ASSET_RELAY_UNAVAILABLE','First-party asset storage is not configured');
 const prefix='sa-assets:'+id+':',raw=await ns.get(prefix+'manifest');
 if(!raw)throw new ArchiveError(404,'ASSET_NOT_FOUND','Asset link expired or unavailable');
 let manifest;try{manifest=JSON.parse(raw);}catch{throw new ArchiveError(503,'ASSET_MANIFEST','Asset manifest is corrupt');}
 if(manifest.version!==1||manifest.id!==id||manifest.name!==name||!Number.isInteger(manifest.bytes)||manifest.bytes<1||manifest.bytes>assetLimit||
    !Number.isInteger(manifest.chunks)||manifest.chunks<1||manifest.chunks>4||typeof manifest.sha256!=='string')
  throw new ArchiveError(503,'ASSET_MANIFEST','Asset manifest is invalid');
 if(Date.parse(manifest.expiresAt)<=Date.now())throw new ArchiveError(410,'ASSET_EXPIRED','Asset link expired');
 const bytes=new Uint8Array(manifest.bytes);let offset=0;
 for(let i=0;i<manifest.chunks;i++){
  const part=await ns.get(prefix+'chunk:'+i,{type:'arrayBuffer'});
  if(!part)throw new ArchiveError(503,'ASSET_PROPAGATING','Asset chunks are temporarily unavailable; retry shortly');
  bytes.set(new Uint8Array(part),offset);offset+=part.byteLength;
 }
 if(offset!==manifest.bytes||createHash('sha256').update(bytes).digest('hex')!==manifest.sha256)
  throw new ArchiveError(503,'ASSET_HASH_MISMATCH','Stored asset failed SHA-256 verification');
 return new Response(bytes,{status:200,headers:{
  'access-control-allow-origin':'*','cache-control':'public, max-age=300, s-maxage=300',
  'x-content-type-options':'nosniff','content-type':manifest.mime,
  'content-disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(name),
  'x-asset-sha256':manifest.sha256,'x-asset-bytes':String(manifest.bytes),'x-asset-expires-at':manifest.expiresAt
 }});
}
async function uploadVerifiedCatbox({name,bytes,type,fetchImpl,env}){
 const sha256=createHash('sha256').update(bytes).digest('hex');
 const form=new FormData();form.set('reqtype','fileupload');form.set('fileToUpload',new Blob([bytes],{type}),name);
 try{
  const upload=await catboxRequest(fetchImpl,'https://catbox.moe/user/api.php',
   {method:'POST',body:form,redirect:'error'},'UPLOAD');
  const url=hostedUrl(await upload.response.text(),assetHosts);
  const verificationAttempts=await verifyHostedAsset({url:url.toString(),bytes,sha256,fetchImpl,stage:'VERIFY'});
  return {provider:'catbox',url:url.toString(),filename:name,mime:type||'application/octet-stream',visibility:'public',temporary:false,bytes:bytes.byteLength,sha256,verified:true,
   verification:'downloaded-url-sha256',uploadAttempts:upload.attempts,verificationAttempts};
 }catch(error){
  const fallbackCodes=new Set(['CATBOX_UPLOAD_NETWORK','CATBOX_UPLOAD_HTTP','CATBOX_RESPONSE','CATBOX_VERIFY_NETWORK','CATBOX_VERIFY']);
  if(!(error instanceof ArchiveError)||!fallbackCodes.has(error.code))throw error;
  return uploadVerifiedCloudflareKV({name,bytes,type,sha256,env,fallbackReason:String(error?.code||'CATBOX_UNAVAILABLE').replace(/[^A-Z0-9_]/g,'').slice(0,64)});
 }
}
export function createArchiveHandler(env,{fetchImpl=fetch,verifyVisualReview,verifyPoseReview}={}){
 const uploadReady=!!env.SESSION_SECRET;
 const ready=!!(env.GITHUB_LIBRARY_TOKEN&&uploadReady&&env.GENERATION_REPOSITORY),origins=(env.APP_ORIGIN||'https://spineanimator.github.io').split(',').map(x=>x.trim());
 const access=uploadReady?createAccess({secret:env.SESSION_SECRET}):null;
 const store=ready?createGenerationStore({repository:env.GENERATION_REPOSITORY,token:env.GITHUB_LIBRARY_TOKEN,access,fetchImpl,siteOrigin:env.SITE_ORIGIN||'https://spineanimator.github.io',verifyVisualReview,verifyPoseReview}):null;
 const motion=ready?createMotionHistory({repository:env.GENERATION_REPOSITORY,token:env.GITHUB_LIBRARY_TOKEN,
    access,fetchImpl}):null;
 const rates=new Map();
 return async function(request){
  const path=new URL(request.url).pathname,origin=request.headers.get('origin');
  const headers={'cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
  const send=(status,value)=>Response.json(value,{status,headers});
  if(origin&&!origins.includes(origin))return send(403,{error:{code:'ORIGIN_FORBIDDEN',message:'Origin unavailable'}});
  if(origin){headers['access-control-allow-origin']=origin;headers.vary='Origin';}
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...headers,'access-control-allow-methods':'GET, POST, OPTIONS','access-control-allow-headers':'Content-Type, Authorization'}});
  if(!uploadReady)return send(503,{error:{code:'UPLOAD_STORAGE_UNAVAILABLE',message:'Asset upload session signing is not configured'}});
  try{
   if(request.method==='POST'){
    const ip=request.headers.get('cf-connecting-ip')||'unknown',stamp=Date.now(),old=rates.get(ip),v=old&&stamp-old.since<60000?old:{since:stamp,count:0};v.count++;if(rates.size>10000)rates.clear();rates.set(ip,v);if(v.count>20)throw new ArchiveError(429,'RATE_LIMIT','Generation request limit reached');
   }
   if(path==='/api/health'&&request.method==='GET')return send(200,{ok:true,assetUpload:uploadReady,privateArchive:ready,maxAssetBytes:assetLimit,provider:'catbox',fallbackProvider:'cloudflare-kv',fallbackTtlSeconds:2592000});
   if(path==='/api/session'&&request.method==='POST'){
    let recoveryKey=null;
    if(/^application\/json(?:;|$)/i.test(request.headers.get('content-type')||'')){
     const body=await json(request);recoveryKey=body?.recoveryKey||null;
    }
    const issued=recoveryKey?await access.issueForRecovery(recoveryKey):await access.issue();
    return send(201,{token:issued.token,kind:recoveryKey?'recovery':'anonymous',expiresIn:30*86400});
   }
   if(path==='/api/assets/catbox'&&request.method==='POST'){
    if(!await access.verify(bearer(request)))throw new ArchiveError(401,'AUTH_REQUIRED','Asset upload session required');
    if(!new RegExp('^multipart/form-data(?:;|$)','i').test(request.headers.get('content-type')||''))throw new ArchiveError(415,'CONTENT_TYPE','Multipart form data is required');
    const declared=Number(request.headers.get('content-length')||0);
    if(declared>assetLimit+1024*1024)throw new ArchiveError(413,'ASSET_LIMIT','Asset request exceeds the upload limit');
    const asset=await assetBytes(request);
    return send(201,await uploadVerifiedCatbox({...asset,fetchImpl,env}));
   }
   const assetMatch=path.match(/^\/api\/assets\/([a-f0-9]{32})\/([^/]+)$/i);
   if(assetMatch&&request.method==='GET'){
    try{return await getPublicAsset(assetMatch[1].toLowerCase(),assetMatch[2],env);}
    catch(e){return send(e.status||502,{error:{code:e.code||'ASSET_READ',message:e.message||'Asset unavailable'}});}
   }
   if(!ready)return send(503,{error:{code:'PRIVATE_STORAGE_UNAVAILABLE',message:'Private generation storage is not configured'}});
   if(path==='/api/motion-history'&&request.method==='GET'){
    const sha=new URL(request.url).searchParams.get('sourceSha256')||'';
    return send(200,await motion.list(bearer(request),sha));
   }
   if(path==='/api/motion-history'&&request.method==='POST'){
    const record=await json(request);
    return send(201,await motion.save(bearer(request),record));
   }
   if(path==='/api/generations'&&request.method==='POST'){
    if(!await access.verify(bearer(request)))throw new ArchiveError(401,'AUTH_REQUIRED','Generation session required');
    const body=await json(request);if(typeof body.archive!=='string'||body.archive.length%4||body.archive.length>limit||!/^[A-Za-z0-9+/]+={0,2}$/.test(body.archive))throw new ArchiveError(400,'BASE64','Invalid archive encoding');
    const bytes=new Uint8Array(Buffer.from(body.archive,'base64'));if(bytes[0]!==80||bytes[1]!==75)throw new ArchiveError(400,'ZIP','ZIP archive required');
    const result=await store.create(bearer(request),{idempotencyKey:body.requestId,prompt:body.prompt,files:[{path:'artifact.zip',bytes}],visualReviewToken:body.visualReviewToken,poseReviewToken:body.poseReviewToken,parentGenerationId:body.parentGenerationId});return send(result.created?201:200,result);
   }
   const match=path.match(/^\/api\/generations\/(c\d{4}_[a-z0-9]{26})(\/archive)?$/);
   if(match&&request.method==='GET'){if(match[2])return new Response(await store.artifact(match[1],bearer(request)),{headers:{...headers,'content-type':'application/zip','content-disposition':'attachment; filename="'+match[1]+'.zip"'}});return send(200,await store.read(match[1],bearer(request)));}
   return send(404,{error:{code:'NOT_FOUND',message:'Generation unavailable'}});
  }catch(e){return send(e instanceof ArchiveError?e.status:502,{error:{code:e instanceof ArchiveError?e.code:'ARCHIVE_FAILURE',message:e instanceof ArchiveError?e.message:'Private archive operation failed'}});}
 };
}
