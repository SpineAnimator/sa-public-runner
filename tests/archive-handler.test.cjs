'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto');
if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const load=()=>import('../server/archive-handler.mjs');
const env={GITHUB_LIBRARY_TOKEN:'test-token',SESSION_SECRET:'a'.repeat(64),GENERATION_REPOSITORY:'Test/private'};
const origin='https://spineanimator.github.io';
async function setup(remoteOverride,config=env,fetchOverride=null){
 const {createArchiveHandler}=await load();
 const source=new Uint8Array([0x38,0x42,0x50,0x53,0,1,0,0,0,0,0,0,0,3,0,0,0,0,0,2,0,0,0,8,0,0]);
 let remote=remoteOverride||source;
 const calls=[];
 const fetchImpl=async(input,options={})=>{
  const url=String(input);calls.push({url,method:options.method||'GET'});
  if(url==='https://catbox.moe/user/api.php'){
   assert.equal(options.method,'POST');
   const form=options.body;
   assert.equal(form.get('reqtype'),'fileupload');
   assert.equal(form.get('fileToUpload').name,'character.psd');
   return new Response('https://files.catbox.moe/abcd1234.psd');
  }
  if(url==='https://files.catbox.moe/abcd1234.psd')return new Response(remote);
  throw new Error('Unexpected fetch '+url);
 };
 const handler=createArchiveHandler(config,{fetchImpl:fetchOverride||fetchImpl});
 const session=await handler(new Request('https://archive.example/api/session',{
  method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'
 }));
 const {token}=await session.json();
 return {handler,token,source,calls,fetchImpl};
}
function uploadRequest(token,bytes,name='character.psd'){
 const form=new FormData();form.set('file',new Blob([bytes],{type:'image/vnd.adobe.photoshop'}),name);
 return new Request('https://archive.example/api/assets/catbox',{method:'POST',
  headers:{origin,authorization:'Bearer '+token},body:form});
}
test('authenticated browser Catbox upload verifies public URL bytes and SHA-256',async()=>{
 const {handler,token,source,calls}=await setup();
 const response=await handler(uploadRequest(token,source));
 assert.equal(response.status,201);
 const result=await response.json();
 assert.equal(result.provider,'catbox');
 assert.equal(result.visibility,'public');
 assert.equal(result.verified,true);
 assert.equal(result.bytes,source.length);
 assert.match(result.sha256,/^[a-f0-9]{64}$/);
 assert.equal(result.verification,'downloaded-url-sha256');
 assert.deepEqual(calls.map(x=>x.method),['POST','GET']);
});
test('browser Catbox upload rejects missing session and non-multipart bodies',async()=>{
 const {handler,token}=await setup();
 const noAuth=await handler(uploadRequest('',new Uint8Array([0x38,0x42,0x50,0x53])));
 assert.equal(noAuth.status,401);
 const badType=await handler(new Request('https://archive.example/api/assets/catbox',{
  method:'POST',headers:{origin,authorization:'Bearer '+token,'content-type':'application/json'},body:'{}'
 }));
 assert.equal(badType.status,415);
});
test('browser Catbox upload rejects source type and remote digest mismatches',async()=>{
 const {handler,token,source}=await setup();
 const invalid=await handler(uploadRequest(token,new Uint8Array([1,2,3])));
 assert.equal(invalid.status,415);
 const mismatch=await setup(new Uint8Array([0x38,0x42,0x50,0x53,9]));
 const response=await mismatch.handler(uploadRequest(mismatch.token,source));
 assert.equal(response.status,502);
 const body=await response.json();
 assert.equal(body.error.code,'CATBOX_MISMATCH');
});

test('Catbox upload worker can operate with only a session-signing secret',async()=>{
 const {handler,token,source}=await setup(undefined,{SESSION_SECRET:'b'.repeat(64)});
 const response=await handler(uploadRequest(token,source));
 assert.equal(response.status,201);
 const result=await response.json();
 assert.equal(result.verified,true);
 assert.equal(result.visibility,'public');
});

test('standalone upload worker reports readiness without exposing signing material',async()=>{
 const {handler}=await setup(undefined,{SESSION_SECRET:'c'.repeat(64)});
 const response=await handler(new Request('https://archive.example/api/health',{headers:{origin}}));
 assert.equal(response.status,200);
 assert.deepEqual(await response.json(),{ok:true,assetUpload:true,privateArchive:false,maxAssetBytes:64*1024*1024,provider:'catbox',fallbackProvider:'cloudflare-kv',fallbackTtlSeconds:2592000});
});


test('Catbox upload retries transient network errors and reports the attempt count',async()=>{
 const source=new Uint8Array([0x38,0x42,0x50,0x53,0,1,0,0,0,0,0,0,0,3,0,0,0,0,0,2,0,0,0,8,0,0]);
 let uploads=0;
 const {createArchiveHandler}=await load();
 const handler=createArchiveHandler(env,{fetchImpl:async(url,options={})=>{
  if(url==='https://catbox.moe/user/api.php'&&++uploads<3)throw new TypeError('temporary DNS failure');
  if(url==='https://catbox.moe/user/api.php')return new Response('https://files.catbox.moe/abcd1234.psd');
  if(url==='https://files.catbox.moe/abcd1234.psd')return new Response(source);
  throw new Error('Unexpected fetch '+url);
 }});
 const session=await handler(new Request('https://archive.example/api/session',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'}));
 const {token}=await session.json();
 const response=await handler(uploadRequest(token,source));
 assert.equal(response.status,201);
 const receipt=await response.json();
 assert.equal(receipt.uploadAttempts,3);
 assert.equal(receipt.verified,true);
});

test('Catbox network failure has a specific safe diagnostic instead of ARCHIVE_FAILURE',async()=>{
 const {createArchiveHandler}=await load();
 const handler=createArchiveHandler({SESSION_SECRET:'d'.repeat(64)},{fetchImpl:async()=>{throw new TypeError('private network details must not leak');}});
 const session=await handler(new Request('https://archive.example/api/session',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'}));
 const {token}=await session.json();
 const response=await handler(uploadRequest(token,new Uint8Array([0x38,0x42,0x50,0x53,0,1,0,0,0,0,0,0,0,3,0,0,0,0,0,2,0,0,0,8,0,0])));
 assert.equal(response.status,503);
 const body=await response.json();
 assert.equal(body.error.code,'ASSET_RELAY_UNAVAILABLE');
 assert.match(body.error.message,/storage is not configured/);
 assert.doesNotMatch(body.error.message,/private network details/);
});


function memoryKV(){
 const data=new Map();
 return {
  async put(key,value){
   if(typeof value==='string')data.set(key,value);
   else if(value instanceof ArrayBuffer)data.set(key,value.slice(0));
   else if(ArrayBuffer.isView(value))data.set(key,value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength));
   else throw new TypeError('Unsupported KV value');
  },
  async get(key,options={}){
   const value=data.get(key);if(value===undefined)return null;
   if(options.type==='arrayBuffer')return typeof value==='string'?new TextEncoder().encode(value).buffer:value.slice(0);
   return typeof value==='string'?value:new TextDecoder().decode(value);
  }
 };
}

test('Catbox network failure falls back to a verified 30-day first-party KV direct link',async()=>{
 const {createArchiveHandler}=await load();
 const source=new Uint8Array([0x38,0x42,0x50,0x53,0,1,0,0,0,0,0,0,0,3,0,0,0,0,0,2,0,0,0,8,0,0]);
 const sha=require('node:crypto').createHash('sha256').update(source).digest('hex');
 const kv=memoryKV();let permanentAttempts=0;
 const handler=createArchiveHandler({...env,ASSET_FILES:kv},{fetchImpl:async target=>{
  if(target==='https://catbox.moe/user/api.php'){permanentAttempts++;throw new TypeError('Catbox egress unavailable');}
  throw new Error('Unexpected fetch '+target);
 }});
 const session=await handler(new Request('https://archive.example/api/session',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'}));
 const {token}=await session.json();
 const response=await handler(uploadRequest(token,source));
 assert.equal(response.status,201);
 const receipt=await response.json();
 assert.equal(permanentAttempts,3);
 assert.equal(receipt.provider,'cloudflare-kv');assert.equal(new URL(receipt.url).hostname,'spine-archive.spine-animator-f8692224.workers.dev');assert.equal(receipt.filename,'character.psd');assert.equal(receipt.mime,'image/vnd.adobe.photoshop');assert.equal(receipt.temporary,false);
 assert.equal(receipt.expiresIn,'30d');assert.ok(Date.parse(receipt.expiresAt)>Date.now());
 assert.equal(receipt.verified,true);assert.equal(receipt.verification,'kv-readback-sha256');
 assert.equal(receipt.bytes,source.length);assert.equal(receipt.sha256,sha);
 const direct=await handler(new Request(receipt.url));
 assert.equal(direct.status,200);
 assert.equal(direct.headers.get('x-asset-sha256'),sha);
 assert.deepEqual(new Uint8Array(await direct.arrayBuffer()),source);
});

test('public KV asset route rejects unknown IDs and does not expose expired manifests',async()=>{
 const {createArchiveHandler}=await load();
 const handler=createArchiveHandler({...env,ASSET_FILES:memoryKV()});
 const response=await handler(new Request('https://archive.example/api/assets/'+'a'.repeat(32)+'/missing.psd'));
 assert.equal(response.status,404);
 const body=await response.json();assert.equal(body.error.code,'ASSET_NOT_FOUND');
});
