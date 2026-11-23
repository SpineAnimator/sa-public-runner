'use strict';
const Contract=require('./sa-edge-contract.js');
const {topologicalOrder}=require('./sa-agent.js');
const ROLE_BY_CAPABILITY=Object.freeze({
 'source.inspect':'A2','vision.analyze':'A2','vision.contour.render':'A2','animation.plan':'A1','model.infer':'A1',
 'spine.mask.generate':'A2','spine.rig.build':'A3','spine.mesh.deform':'A3',
 'fx.particles.build':'A3','spine.animate':'A4','spine.export':'A5',
 'spine.editor.native-roundtrip':'A5','project.package':'A6','result.deliver':'A6'
});
function fail(message){throw new Error('SA Edge Runtime: '+message);}
function createHttpPublisher({endpoint,token,fetchImpl=globalThis.fetch,timeoutMs=10000}={}){
 if(typeof endpoint!=='string'||!/^https:\/\//.test(endpoint))fail('HTTPS event endpoint is required');
 if(typeof fetchImpl!=='function')fail('fetch is unavailable');
 if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>60000)fail('publisher timeout must be 100..60000 ms');
 return async function publish(event){
  const controller=typeof AbortController==='function'?new AbortController():null;
  let timer;
  try{
   const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller?.abort();reject(new Error('event transport timeout'));},timeoutMs);});
   const request=fetchImpl(endpoint,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},
    body:JSON.stringify(event),redirect:'error',credentials:'omit',...(controller?{signal:controller.signal}:{})});
   const response=await Promise.race([request,timeout]);
   if(!response||!response.ok)throw new Error('event transport HTTP '+(response?response.status:'unavailable'));
   return {delivered:true,status:response.status};
  }finally{if(timer)clearTimeout(timer);}
 };
}

function createCloudflareQueueTransport({accountId,queueId,apiToken,fetchImpl=globalThis.fetch,baseUrl='https://api.cloudflare.com/client/v4'}={}){
 if(typeof accountId!=='string'||! /^[a-f0-9]{32}$/.test(accountId))fail('Cloudflare accountId must be a 32-character ID');
 if(typeof queueId!=='string'||! /^[a-f0-9]{32}$/.test(queueId))fail('Cloudflare queueId must be a 32-character ID');
 if(typeof apiToken!=='string'||apiToken.length<20)fail('Cloudflare API token is required');
 if(typeof fetchImpl!=='function')fail('fetch is unavailable');
 const base=baseUrl.replace(/\/+$/,'')+'/accounts/'+accountId+'/queues/'+queueId;
 async function request(path,body){
  const response=await fetchImpl(base+path,{method:'POST',headers:{Authorization:'Bearer '+apiToken,'Content-Type':'application/json'},
   body:JSON.stringify(body),credentials:'omit',redirect:'error'});
  let data={};try{data=await response.json();}catch(_){}
  if(!response||!response.ok||data.success===false)fail('Cloudflare Queue API failed: HTTP '+(response?response.status:'unavailable'));
  return data.result??data;
 }
 return Object.freeze({
  publish:event=>request('/messages',{body:event,content_type:'json'}),
  pull:async({batchSize=10,visibilityTimeoutMs=60000}={})=>{
   if(!Number.isInteger(batchSize)||batchSize<1||batchSize>100)fail('batchSize must be 1..100');
   if(!Number.isInteger(visibilityTimeoutMs)||visibilityTimeoutMs<1000||visibilityTimeoutMs>120000)fail('visibilityTimeoutMs must be 1000..120000');
   const result=await request('/messages/pull',{batch_size:batchSize,visibility_timeout_ms:visibilityTimeoutMs});
   return Array.isArray(result.messages)?result.messages.map(message=>{
    if(typeof message.body!=='string')return message;
    let body;try{body=JSON.parse(message.body);}catch(_){fail('Cloudflare Queue delivered a non-JSON event body');}
    return {...message,body};
   }):[];
  },
  ack:leases=>{
   if(!Array.isArray(leases)||!leases.length||leases.some(x=>typeof x!=='string'||!x))fail('ack requires non-empty lease IDs');
   return request('/messages/ack',{acks:leases.map(lease_id=>({lease_id})),retries:[]});
  },
  retry:(leases,delaySeconds=30)=>{
   if(!Array.isArray(leases)||!leases.length||leases.some(x=>typeof x!=='string'||!x))fail('retry requires non-empty lease IDs');
   if(!Number.isInteger(delaySeconds)||delaySeconds<0||delaySeconds>86400)fail('retry delay is invalid');
   return request('/messages/ack',{acks:[],retries:leases.map(lease_id=>({lease_id,delay_seconds:delaySeconds}))});
  }
 });
}

function artifactRefsFrom(value){
 if(!value||typeof value!=='object')return [];
 if(Array.isArray(value.artifact_refs))return value.artifact_refs;
 if(typeof value.artifactSha256==='string'&&/^[a-f0-9]{64}$/.test(value.artifactSha256)&&typeof value.id==='string')
  return [{uri:'archive://generation/'+value.id,sha256:value.artifactSha256}];
 if(typeof value.sha256==='string'&&/^[a-f0-9]{64}$/.test(value.sha256))
  return [{uri:'artifact://sha256/'+value.sha256,sha256:value.sha256}];
 return [];
}
function createEdgeRuntime({registry,publish,idFactory,now,policyContext}={}){
 if(!registry||typeof registry.resolve!=='function')fail('Tool Registry is required');
 if(typeof publish!=='function')fail('event publisher is required; execution is fail-closed without feedback transport');
 const make=(input)=>Contract.createEnvelope(input,{idFactory,now});
 async function send(event){Contract.validateEnvelope(event);await publish(event);}
 async function execute(plan,context={}){
  const ordered=topologicalOrder(plan.operations);
  const selected=[];
  for(const operation of ordered){
   const tool=registry.resolve(operation.capability);
   if(!tool)return {status:'blocked',blockedReason:'No tool provides '+operation.capability,trace:[],results:Object.create(null)};
   selected.push({operation,tool});
  }
  const correlationId=context.correlationId||context.jobId||'sa-run-'+Date.now().toString(36);
  const projectId=context.projectId||plan.projectId;
  const workItemId=context.workItemId||correlationId;
  const results=Object.create(null),trace=[];
  for(const {operation,tool} of selected){
   const roleId=ROLE_BY_CAPABILITY[operation.capability]||'A1';
   const dependencies=Object.fromEntries(operation.dependsOn.map(id=>[id,results[id]]));
   const inputRefs=Object.values(dependencies).flatMap(artifactRefsFrom);
   const command=make({correlation_id:correlationId,project_id:projectId,work_item_id:workItemId,
    ...(inputRefs.length===1?{input_sha256:inputRefs[0].sha256}:{}),artifact_refs:inputRefs,
    role_id:'A1',source:'A1.orchestrator',target:roleId+'.runtime',direction:'command',
    kind:'capability.invoke',payload:{operation_id:operation.id,capability_id:operation.capability,tool_id:tool.id},
    status:'requested',policy_context:policyContext});
   try{await send(command);}catch(error){return {status:'blocked',blockedReason:'command event delivery failed: '+String(error.message||error),trace,results};}
   const entry={operationId:operation.id,capability:operation.capability,toolId:tool.id,roleId,status:'running'};
   trace.push(entry);
   try{
    const value=await tool.run({operation:{...operation,dependsOn:[...operation.dependsOn]},context,dependencies});
    results[operation.id]=value;entry.status='completed';
    const feedback=Contract.createFeedback(command,{role_id:roleId,source:roleId+'.runtime',target:'A1.orchestrator',
     kind:'capability.completed',status:'succeeded',artifact_refs:artifactRefsFrom(value),
     evidence_refs:Array.isArray(value?.evidence_refs)?value.evidence_refs:[],payload:{operation_id:operation.id,capability_id:operation.capability,
      result_summary:{type:value===null?'null':Array.isArray(value)?'array':typeof value,
       keys:value&&typeof value==='object'?Object.keys(value).slice(0,32):[]}},
     policy_context:policyContext},{idFactory,now});
    try{await send(feedback);}catch(error){entry.status='feedback_delivery_failed';entry.error=String(error.message||error).slice(0,300);
     return {status:'feedback_delivery_failed',failedOperation:operation.id,trace,results};}
   }catch(error){
    entry.status='failed';entry.error=String(error.message||error).slice(0,300);
    const feedback=Contract.createFeedback(command,{role_id:roleId,source:roleId+'.runtime',target:'A1.orchestrator',
     kind:'capability.failed',status:'failed',payload:{operation_id:operation.id,error:entry.error},
     policy_context:policyContext},{idFactory,now});
    try{await send(feedback);}catch(deliveryError){entry.feedbackError=String(deliveryError.message||deliveryError).slice(0,300);}
    return {status:'failed',failedOperation:operation.id,trace,results};
   }
  }
  return {status:'completed',trace,results,correlationId};
 }
 return Object.freeze({execute});
}
module.exports={ROLE_BY_CAPABILITY,createHttpPublisher,createCloudflareQueueTransport,createEdgeRuntime};
