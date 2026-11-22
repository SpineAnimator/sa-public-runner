/** Live ChatGPT-facing MCP source tool acceptance smoke. No mocks. */
import {strict as assert} from 'node:assert';
const endpoint='https://spine-studio.spine-animator-f8692224.workers.dev/mcp';
async function rpc(id,method,params={}){
 const res=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params}),signal:AbortSignal.timeout(30000)});
 assert.equal(res.status,200,'MCP HTTP status');
 const data=await res.json();
 if(data.error)throw Error('MCP_'+method+'_ERROR_'+JSON.stringify(data.error));
 return data.result;
}
const init=await rpc(100,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'2spine-ci-acceptance',version:'1.0.0'}});
assert.equal(init.serverInfo?.name,'2Spine','ChatGPT agent must identify as 2Spine');
assert.equal(init.capabilities?.extensions?.['openai/mentions']?.searchTool,'spine.mentions','@2Spine composer search must be advertised');
const list=await rpc(1,'tools/list');
const names=(list.tools||[]).map(x=>x.name);
for(const name of ['spine.open','spine.mentions','spine.verify_psd_source','spine.build_zip_from_layers'])assert.ok(names.includes(name),'Missing live MCP tool '+name);
assert.ok(list.tools.find(x=>x.name==='spine.open')?._meta?.['openai/ui']?.entrypoints?.some(x=>x.type==='global'),'Global ChatGPT 2Spine UI entrypoint is missing');
const mentions=await rpc(101,'tools/call',{name:'spine.mentions',arguments:{query:'@2Spine'}});
assert.ok(mentions.structuredContent?.items?.some(x=>x.name==='2Spine'),'Composer @2Spine must resolve to a 2Spine entry');
const open=await rpc(102,'tools/call',{name:'spine.open',arguments:{}});
assert.equal(open.structuredContent?.agent,'2Spine');
assert.equal(open.structuredContent?.output,'animation.zip');
console.log('MCP_CHATGPT_ENTRY_CONTRACT_PASSED');
console.log('MCP_LIVE_TOOLS '+JSON.stringify(names));
const approved=[
 {url:'https://files.catbox.moe/clgb71.psd',bytes:4485543,sha256:'7adee866547a3b3cc9838b655cf70865980c5dba00313373cbf903fed776c7b2'},
 {url:'https://litter.catbox.moe/w9kn7qz47ph79wny.psd',bytes:1184570,sha256:'fc5f899776f928c87adefc4aab6a7287b28bfd4c3bf2a7050ed1ca74857d60a5'}
];
for(let i=0;i<approved.length;i++){
 const item=approved[i],result=await rpc(i+2,'tools/call',{name:'spine.verify_psd_source',arguments:{url:item.url,expected_sha256:item.sha256,expected_bytes:item.bytes}});
 const report=result.structuredContent;
 assert.ok(report?.ok,'Full PSD failed live MCP integrity check: '+JSON.stringify(report));
 assert.equal(report.bytes,item.bytes);
 assert.equal(report.sha256,item.sha256);
 assert.equal(report.psd_header_verified,true);
 const attemptOrder=[...(report.attempts||[]).map(x=>x.route),report.route];
 const expectedOrder=['verified-kv','restricted-generator','catbox-origin','public-files-mirror'];
 assert.ok(attemptOrder.length>=1,'MCP must return a verified route');
 assert.deepEqual(attemptOrder,expectedOrder.slice(0,attemptOrder.length),'Unexpected MCP source fallback order');
 console.log('MCP_LIVE_PSD '+JSON.stringify({url:item.url,bytes:report.bytes,sha256:report.sha256,route:report.route,attempt_order:attemptOrder}));
}
console.log('MCP_SOURCE_ACCEPTANCE_PASSED');
await import('./mcp-streamable-http-live.mjs');
