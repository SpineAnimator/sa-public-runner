/** Real deployed MCP Streamable HTTP handshake probe. */
import assert from 'node:assert/strict';
const endpoint='https://spine-studio.spine-animator-f8692224.workers.dev/mcp';
const version='2025-11-25';
let session;
async function post(payload,{protocol=false}={}){
 const headers={'content-type':'application/json','accept':'application/json, text/event-stream'};
 if(protocol)headers['mcp-protocol-version']=version;
 if(session)headers['mcp-session-id']=session;
 const response=await fetch(endpoint,{method:'POST',headers,redirect:'error',body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
 const assigned=response.headers.get('mcp-session-id'); if(assigned)session=assigned; return response;
}
async function message(id,method,params,opts={}){
 const res=await post({jsonrpc:'2.0',id,method,params},opts);
 assert.equal(res.status,200,method+' HTTP status '+res.status);
 const type=(res.headers.get('content-type')||'').toLowerCase(); let messages=[];
 if(type.includes('text/event-stream')){
  const raw=await res.text(); messages=raw.split(/\r?\n\r?\n/).flatMap(event=>{const data=event.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!data||data==='[DONE]')return [];return [JSON.parse(data)];});
 }else{assert.match(type,/application\/json/,method+' must respond JSON or SSE');messages=[await res.json()];}
 const reply=messages.find(x=>x?.id===id); assert.ok(reply,method+' returned no JSON-RPC response');
 assert.equal(reply.jsonrpc,'2.0'); assert.equal(reply.error,undefined,method+' JSON-RPC error');
 assert.ok(reply.result&&typeof reply.result==='object',method+' missing result'); return reply.result;
}
const init=await message(701,'initialize',{protocolVersion:version,capabilities:{},clientInfo:{name:'2spine-streamable-http-ci',version:'1.0.0'}});
assert.equal(init.serverInfo?.name,'2Spine'); assert.ok(init.protocolVersion,'No negotiated MCP protocol version');
console.log('MCP_STREAMABLE_HTTP_INITIALIZED '+JSON.stringify({client_version:version,server_version:init.protocolVersion,session:session?'session-issued':'stateless'}));
const initialized=await post({jsonrpc:'2.0',method:'notifications/initialized'},{protocol:true});
assert.equal(initialized.status,202,'MCP notifications/initialized must return HTTP 202');
assert.equal(await initialized.text(),'','Notification acknowledgement must be empty');
const listed=await message(702,'tools/list',{}, {protocol:true}); const tools=listed.tools||[],names=tools.map(t=>t.name);
for(const name of ['spine.open','spine.mentions','spine.verify_psd_source','spine.build_zip_from_layers'])assert.ok(names.includes(name),'Missing live MCP tool '+name);
assert.ok(tools.find(t=>t.name==='spine.open')?._meta?.['openai/ui']?.entrypoints?.some(x=>x.type==='global'),'Global 2Spine entrypoint missing');
const mentions=await message(703,'tools/call',{name:'spine.mentions',arguments:{query:'@2Spine'}},{protocol:true});
assert.ok(mentions.structuredContent?.items?.some(x=>x.name==='2Spine'),'@2Spine mention did not resolve');
const opened=await message(704,'tools/call',{name:'spine.open',arguments:{}},{protocol:true});
assert.equal(opened.structuredContent?.agent,'2Spine');
console.log('MCP_STREAMABLE_HTTP_COMPATIBILITY_PASSED '+JSON.stringify({tools:names,chatgpt_ui_invocation_verified:false,installed_plugin_invocation_verified:false}));
