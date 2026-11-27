/** Real deployed MCP Streamable HTTP handshake probe.
 * Tests the transport a remote ChatGPT MCP client uses, not the ChatGPT UI.
 * NO user-agent spoofing, no claims about installed-plugin invocation.
 */
import assert from 'node:assert/strict';

const endpoint=(process.env.SPINE_MCP_URL ||
  'https://spine-studio.spine-animator-f8692224.workers.dev').replace(/\/$/,'')+'/mcp';
const version='2025-11-25';
let session;
async function post(payload,{protocol=false}={}){
  const headers={
    'content-type':'application/json',
    'accept':'application/json, text/event-stream'
  };
  if(protocol)headers['mcp-protocol-version']=version;
  if(session)headers['mcp-session-id']=session;
  const response=await fetch(endpoint,{
    method:'POST',headers,redirect:'error',body:JSON.stringify(payload),
    signal:AbortSignal.timeout(15000)
  });
  const assigned=response.headers.get('mcp-session-id');
  if(assigned)session=assigned;
  return response;
}
async function message(id,method,params,opts={}){
  const res=await post({jsonrpc:'2.0',id,method,params},opts);
  assert.equal(res.status,200,method+' HTTP status '+res.status);
  const type=(res.headers.get('content-type')||'').toLowerCase();
  let messages=[];
  if(type.includes('text/event-stream')){
    const raw=await res.text();
    messages=raw.split(/\r?\n\r?\n/).flatMap(event=>{
      const data=event.split(/\r?\n/).filter(l=>l.startsWith('data:'))
        .map(l=>l.slice(5).trimStart()).join('\n');
      if(!data||data==='[DONE]')return [];
      return [JSON.parse(data)];
    });
  }else{
    assert.match(type,/application\/json/,method+' must respond JSON or SSE');
    messages=[await res.json()];
  }
  const reply=messages.find(x=>x?.id===id);
  assert.ok(reply,method+' returned no JSON-RPC response for id '+id);
  assert.equal(reply.jsonrpc,'2.0');
  assert.equal(reply.error,undefined,method+' JSON-RPC error '+JSON.stringify(reply.error));
  assert.ok(reply.result&&typeof reply.result==='object',method+' missing result');
  return reply.result;
}
const init=await message(701,'initialize',{
  protocolVersion:version,capabilities:{},clientInfo:{name:'2spine-streamable-http-ci',version:'1.0.0'}
});
assert.equal(init.serverInfo?.name,'2Spine');
assert.ok(init.protocolVersion,'No negotiated MCP protocol version');
console.log('MCP_STREAMABLE_HTTP_INITIALIZED '+JSON.stringify({
  client_version:version,server_version:init.protocolVersion,
  session:session?'session-issued':'stateless'
}));

const initialized=await post({jsonrpc:'2.0',method:'notifications/initialized'}, {protocol:true});
assert.equal(initialized.status,202,
  'MCP notifications/initialized must be acknowledged with HTTP 202, got '+initialized.status);
assert.equal(await initialized.text(),'','Notification acknowledgement must not contain a JSON-RPC body');

const listed=await message(702,'tools/list',{}, {protocol:true});
const tools=listed.tools||[],names=tools.map(t=>t.name);
const requiredTools=[
  'spine.open','spine.mentions','spine.verify_psd_source','spine.verify_asset_source',
  'spine.build_zip_from_layers','spine.mask.preflight','spine.export_project'
];
for(const name of requiredTools)
  assert.ok(names.includes(name),'Missing live MCP tool '+name);
assert.equal(new Set(names).size,names.length,'MCP tool names must be unique');
assert.equal(names.length,requiredTools.length,
  'Final GPT-first MCP surface must contain exactly seven tools');
assert.deepEqual([...names].sort(),[...requiredTools].sort(),
  'Unexpected or missing tool in the final GPT-first MCP surface');
const openTool=tools.find(t=>t.name==='spine.open');
assert.ok(openTool?._meta?.['openai/ui']?.entrypoints
  ?.some(x=>x.type==='global'),'Global 2Spine entrypoint missing');
assert.equal(openTool?._meta?.ui?.resourceUri,'ui://2spine/studio.html',
  'The global entry must reference the 2Spine app resource');
const sourceTool=tools.find(t=>t.name==='spine.verify_psd_source');
const assetTool=tools.find(t=>t.name==='spine.verify_asset_source');
const zipTool=tools.find(t=>t.name==='spine.build_zip_from_layers');
const exportTool=tools.find(t=>t.name==='spine.export_project');
const maskTool=tools.find(t=>t.name==='spine.mask.preflight');
assert.ok(sourceTool.inputSchema.properties.expected_sha256);
assert.ok(sourceTool.inputSchema.properties.expected_bytes);
assert.ok(assetTool.inputSchema.properties.expected_mime);
assert.match(zipTool.description,/NOT a PSD URL-to-ZIP/i);
assert.match(zipTool.description,/not a native \.spine editor tool/i);
assert.ok(exportTool.inputSchema.required.includes('payload'));
assert.equal(exportTool.inputSchema.properties.publish_publicly.type,'boolean');
assert.match(maskTool.description,/read-only/i);
assert.match(maskTool.description,/never submits a ZIP or starts a runner/i);
// GPT-first policy intentionally removes legacy server-side inference tools.
for(const name of ['spine.segment_image','spine.plan_rig'])
  assert.ok(!names.includes(name),'Legacy Cloudflare inference tool must stay hidden: '+name);
for(const [id,name] of [[706,'spine.segment_image'],[707,'spine.plan_rig']]) {
  const blocked=await message(id,'tools/call',{name,arguments:{}},{protocol:true});
  assert.equal(blocked.structuredContent?.error,'GPT_FIRST_REQUIRED',
    name+' must be rejected by the GPT-first policy');
  assert.equal(blocked.isError,true);
}

const mentions=await message(703,'tools/call',{
  name:'spine.mentions',arguments:{query:'@2Spine'}
},{protocol:true});
assert.ok(mentions.structuredContent?.items?.some(x=>x.name==='2Spine'),
  '@2Spine composer mention did not resolve');

const opened=await message(704,'tools/call',{
  name:'spine.open',arguments:{}
},{protocol:true});
assert.equal(opened.structuredContent?.agent,'2Spine');
console.log('MCP_STREAMABLE_HTTP_COMPATIBILITY_PASSED '+JSON.stringify({tools:names,
  chatgpt_ui_invocation_verified:false,installed_plugin_invocation_verified:false}));
