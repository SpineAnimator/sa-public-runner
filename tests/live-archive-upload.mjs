import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
let base=process.env.SA_ARCHIVE_API_URL||'https://spine-archive.spine-animator-f8692224.workers.dev';while(base.endsWith('/'))base=base.slice(0,-1);
const origin='https://spineanimator.github.io';
const healthResponse=await fetch(base+'/api/health',{headers:{origin}});
assert.equal(healthResponse.status,200,'archive Worker health endpoint must be reachable');
const health=await healthResponse.json();assert.equal(health.assetUpload,true);assert.equal(health.maxAssetBytes,64*1024*1024);
const sessionResponse=await fetch(base+'/api/session',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'});
assert.equal(sessionResponse.status,201,'archive must issue an upload session');
const session=await sessionResponse.json();
assert.equal(typeof session.token,'string');
const source=Uint8Array.from([0x38,0x42,0x50,0x53,0,1,0,0,0,0,0,0,0,3,0,0,0,0,0,1,0,0,0,8,0,0]);
const form=new FormData();
form.set('file',new Blob([source],{type:'image/vnd.adobe.photoshop'}),'sa-live-smoke.psd');
const uploadResponse=await fetch(base+'/api/assets/catbox',{method:'POST',headers:{origin,authorization:'Bearer '+session.token},body:form});
assert.equal(uploadResponse.status,201,'archive must upload and verify the Catbox asset');
const manifest=await uploadResponse.json();
assert.ok(['catbox','cloudflare-kv'].includes(manifest.provider),'archive must use Catbox or verified first-party KV');
assert.equal(manifest.visibility,'public');
assert.equal(manifest.verified,true);
assert.equal(manifest.bytes,source.length);
assert.equal(manifest.sha256,createHash('sha256').update(source).digest('hex'));
if(manifest.provider==='catbox'){
 const host=new URL(manifest.url).hostname;
 assert.ok(['files.catbox.moe','litter.catbox.moe'].includes(host),'Catbox URL must use an approved host');
 assert.equal(manifest.verification,'downloaded-url-sha256');
}else{
 assert.equal(new URL(manifest.url).hostname,'spine-archive.spine-animator-f8692224.workers.dev');
 assert.equal(manifest.expiresIn,'30d');
 assert.equal(manifest.verification,'kv-readback-sha256');
}
const hosted=await fetch(manifest.url,{redirect:'error'});
assert.equal(hosted.status,200);
const downloaded=new Uint8Array(await hosted.arrayBuffer());
assert.deepEqual(downloaded,source);
console.log(JSON.stringify({ok:true,provider:manifest.provider,bytes:manifest.bytes,sha256:manifest.sha256,verification:manifest.verification}));
