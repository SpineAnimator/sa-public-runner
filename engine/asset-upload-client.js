(function(root){
'use strict';
const hosts=new Set(['files.catbox.moe','litter.catbox.moe','spine-archive.vladyslavchaplygin.workers.dev']);
const extensions=new Set(['.psd','.psb','.png','.jpg','.jpeg','.webp','.gif','.zip','.json','.atlas','.skel','.spine','.txt','.md','.yaml','.yml','.toml','.csv','.xml','.js','.mjs','.ts','.py','.html','.css','.pdf','.wasm','.bin','.bytes','.mp4','.webm','.mov','.glb','.gltf','.obj','.fbx','.blend','.jsonl','.json5','.ini','.cfg','.sh','.ps1','.c','.h','.cpp','.rs','.go','.java','.kt','.swift','.lua','.gd','.tscn','.tres']);
function fail(message){throw new Error('SA asset upload: '+message);}
function createCatboxAssetUploader({archiveApiUrl,fetchImpl}={}){
 let base;
 try{const u=new URL(archiveApiUrl||'');if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)fail('a configured HTTPS archive API URL is required');base=u.toString();while(base.endsWith('/'))base=base.slice(0,-1);}
 catch(e){if(e&&e.message&&e.message.startsWith('SA asset upload:'))throw e;fail('archive API URL is invalid');}
 const request=fetchImpl||root.fetch;
 if(typeof request!=='function')fail('fetch is unavailable');
 async function upload({file,signal,purpose}={}){
  if(!file||typeof file.arrayBuffer!=='function'||!Number.isSafeInteger(file.size)||file.size<1||file.size>64*1024*1024)
   fail('file is missing, empty or exceeds 64 MiB');
  const name=String(file.name||'asset.bin').split(String.fromCharCode(92)).join('/').split('/').pop();
  const dot=name.lastIndexOf('.');
  if(dot<1||!extensions.has(name.slice(dot).toLowerCase()))fail('unsupported Spine asset type');
  const sessionResponse=await request(base+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal});
  if(!sessionResponse||!sessionResponse.ok)fail('archive session could not be created');
  const session=await sessionResponse.json();
  if(!session||typeof session.token!=='string'||session.token.length<20)fail('archive returned an invalid upload session');
  const form=new FormData();form.set('file',file,name);
  const response=await request(base+'/api/assets/catbox',{method:'POST',headers:{authorization:'Bearer '+session.token},body:form,signal});
  if(!response||!response.ok)fail('archive rejected the asset upload');
  const result=await response.json();
  let url;try{url=new URL(result.url);}catch{fail('archive returned an invalid asset URL');}
  if(url.protocol!=='https:'||!hosts.has(url.hostname)||url.username||url.password||url.search||url.hash)
   fail('archive returned a URL outside the public asset allowlist');
  const hasExpiry=typeof result.expiresAt==='string'&&Number.isFinite(Date.parse(result.expiresAt))&&Date.parse(result.expiresAt)>Date.now();
  const isPermanent=result.provider==='catbox'&&url.hostname==='files.catbox.moe'&&result.temporary!==true;
  const isCloudflare=result.provider==='cloudflare-kv'&&url.hostname==='spine-archive.vladyslavchaplygin.workers.dev'&&
    result.temporary===false&&result.expiresIn==='30d'&&hasExpiry;
  const isTemporary=result.provider==='litterbox'&&url.hostname==='litter.catbox.moe'&&result.temporary===true&&
    result.expiresIn==='72h'&&hasExpiry;
  if((!isPermanent&&!isCloudflare&&!isTemporary)||result.visibility!=='public'||result.verified!==true||
    !['downloaded-url-sha256','kv-readback-sha256'].includes(result.verification)||result.bytes!==file.size||
    typeof result.sha256!=='string'||!/^[a-f0-9]{64}$/i.test(result.sha256))
   fail('archive did not return a complete verified asset manifest');
  return {url:url.toString(),filename:typeof result.filename==='string'?result.filename:name,mime:typeof result.mime==='string'?result.mime:(file.type||'application/octet-stream'),
    provider:result.provider,sha256:result.sha256.toLowerCase(),bytes:result.bytes,verified:true,verification:result.verification,
    visibility:'public',temporary:result.temporary===true,expiresIn:result.expiresIn||null,expiresAt:hasExpiry?result.expiresAt:null,
    purpose:typeof purpose==='string'?purpose.slice(0,240):'source-asset'};
 }
 return Object.freeze({upload});
}
const api={createCatboxAssetUploader};
if(typeof module==='object'&&module.exports)module.exports=api;
else root.SAAssetUploadClient=api;
})(typeof globalThis!=='undefined'?globalThis:this);
