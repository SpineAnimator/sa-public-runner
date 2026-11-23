'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createCatboxAssetUploader}=require('../engine/asset-upload-client.js');
const FileCtor=globalThis.File||require('node:buffer').File;
function makeFile(){return new FileCtor([new Uint8Array([0x38,0x42,0x50,0x53])],'character.psd',{type:'image/vnd.adobe.photoshop'});}
test('browser uploader creates session and returns only a verified public Catbox manifest',async()=>{
 const calls=[];
 const fetchImpl=async(url,options={})=>{
  calls.push({url,options});
  if(url.endsWith('/api/session'))return new Response(JSON.stringify({token:'session-token-12345678901234567890'}),{status:201});
  if(url.endsWith('/api/assets/catbox')){
   assert.equal(options.headers.authorization,'Bearer session-token-12345678901234567890');
   assert.equal(options.body.get('file').name,'character.psd');
   return new Response(JSON.stringify({provider:'catbox',url:'https://files.catbox.moe/abcd1234.psd',
    visibility:'public',bytes:4,sha256:'a'.repeat(64),verified:true,verification:'downloaded-url-sha256'}),{status:201});
  }
  throw Error('unexpected URL '+url);
 };
 const uploader=createCatboxAssetUploader({archiveApiUrl:'https://archive.example',fetchImpl});
 const manifest=await uploader.upload({file:makeFile(),purpose:'CV source'});
 assert.deepEqual(manifest,{url:'https://files.catbox.moe/abcd1234.psd',filename:'character.psd',mime:'image/vnd.adobe.photoshop',provider:'catbox',
  sha256:'a'.repeat(64),bytes:4,verified:true,verification:'downloaded-url-sha256',visibility:'public',temporary:false,
  expiresIn:null,expiresAt:null,purpose:'CV source'});
 assert.deepEqual(calls.map(x=>x.url),['https://archive.example/api/session','https://archive.example/api/assets/catbox']);
});
test('browser uploader rejects unsafe API URLs and incomplete or unverified manifests',async()=>{
 assert.throws(()=>createCatboxAssetUploader({archiveApiUrl:'http://archive.example'}),/HTTPS/);
 const uploader=createCatboxAssetUploader({archiveApiUrl:'https://archive.example',fetchImpl:async url=>
  url.endsWith('/api/session')?new Response(JSON.stringify({token:'session-token-12345678901234567890'})):
  new Response(JSON.stringify({provider:'catbox',url:'https://files.catbox.moe/abcd1234.psd',visibility:'public',
   bytes:4,sha256:'a'.repeat(64),verified:false,verification:'none'}),{status:201})});
 await assert.rejects(uploader.upload({file:makeFile()}),/verified asset manifest/);
});
test('browser uploader rejects unsupported types and oversized assets before network access',async()=>{
 let calls=0;const uploader=createCatboxAssetUploader({archiveApiUrl:'https://archive.example',fetchImpl:async()=>{calls++;}});
 await assert.rejects(uploader.upload({file:new FileCtor(['x'],'malware.exe')}),/unsupported/);
 await assert.rejects(uploader.upload({file:{name:'huge.psd',size:64*1024*1024+1,arrayBuffer:async()=>new ArrayBuffer(0)}}),/64 MiB/);
 assert.equal(calls,0);
});




test('browser uploader accepts only a verified first-party KV direct link with explicit expiry',async()=>{
 const expiry=new Date(Date.now()+30*86400000).toISOString();
 const uploader=createCatboxAssetUploader({archiveApiUrl:'https://archive.example',fetchImpl:async url=>
  url.endsWith('/api/session')?new Response(JSON.stringify({token:'session-token-12345678901234567890'})):
  new Response(JSON.stringify({provider:'cloudflare-kv',url:'https://spine-archive.spine-animator-f8692224.workers.dev/api/assets/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/character.psd',
   visibility:'public',bytes:4,sha256:'c'.repeat(64),verified:true,verification:'downloaded-url-sha256',temporary:false,expiresIn:'30d',expiresAt:expiry}),{status:201})});
 const result=await uploader.upload({file:makeFile()});
 assert.equal(result.provider,'cloudflare-kv');assert.equal(result.temporary,false);assert.equal(result.expiresAt,expiry);
});
