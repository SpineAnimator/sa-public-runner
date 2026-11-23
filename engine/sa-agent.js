/* SA Agent orchestration contract. Plans only operations justified by structured analysis. */
'use strict';
(function(){
const browser=typeof module!=='object'||!module.exports;
const AnimationPlanner=browser?(typeof globalThis!=='undefined'?globalThis.SAAnimationPlanner:null):require('./animation-planner.js');
const Roles=browser?(typeof globalThis!=='undefined'?globalThis.SARoles:null):require('./sa-roles.js');
const ExecutionPolicy=browser?(typeof globalThis!=='undefined'?globalThis.SAExecutionPolicy:null):require('./sa-execution-policy.js');
const SemanticContourAdapter=browser?(typeof globalThis!=='undefined'?globalThis.SASemanticContourAdapter:null):require('./sa-semantic-contour-adapter.js');
if(!AnimationPlanner||!Roles||!ExecutionPolicy)throw new Error('SA Agent: planner, role or execution policy contracts are unavailable');
const CAPABILITIES=Object.freeze({
 SOURCE_INSPECT:'source.inspect',VISION_ANALYZE:'vision.analyze',ANIMATION_PLAN:'animation.plan',MODEL_INFER:'model.infer',ASSET_UPLOAD:'asset.upload',CONTOUR_RENDER:'vision.contour.render',
 LIBRARY_SEARCH:'library.examples.search',MASK_GENERATE:'spine.mask.generate',RESIZE:'spine.skeleton.resize',RIG_BUILD:'spine.rig.build',MESH_DEFORM:'spine.mesh.deform',
 PARTICLES_BUILD:'fx.particles.build',ANIMATE:'spine.animate',EXPORT:'spine.export',
 NATIVE_ROUNDTRIP:'spine.editor.native-roundtrip',PACKAGE:'project.package',DELIVER:'result.deliver'
});
const DEFAULT_CAPABILITIES=Object.freeze(Object.values(CAPABILITIES));
const ID=/^[a-z][a-z0-9._-]{1,79}$/;
function fail(message){throw new Error('SA Agent: '+message);}
function object(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function checkedId(value,label){if(typeof value!=='string'||!ID.test(value))fail(label+' is invalid');return value;}
function createToolRegistry(){
 const tools=new Map();
 function register(tool){
  if(!object(tool))fail('tool descriptor must be an object');
  const id=checkedId(tool.id,'tool id');
  if(tools.has(id))fail('duplicate tool id '+id);
  if(!Array.isArray(tool.capabilities)||!tool.capabilities.length)fail('tool '+id+' must declare capabilities');
  const capabilities=[...new Set(tool.capabilities.map(x=>checkedId(x,'capability')))];
  if(typeof tool.run!=='function')fail('tool '+id+' needs a run function');
  const priority=tool.priority===undefined?0:tool.priority;
  if(typeof priority!=='number'||!Number.isFinite(priority))fail('tool priority must be finite');
  if(tool.parallelSafe!==undefined&&typeof tool.parallelSafe!=='boolean')fail('tool parallelSafe must be boolean');
  tools.set(id,Object.freeze({id,capabilities,priority,parallelSafe:tool.parallelSafe===true,run:tool.run}));return id;
 }
 function resolve(capability){
  return [...tools.values()].filter(t=>t.capabilities.includes(capability))
   .sort((a,b)=>b.priority-a.priority||a.id.localeCompare(b.id))[0]||null;
 }
 return Object.freeze({register,resolve,hasCapability:c=>resolve(c)!==null,
  list:()=>[...tools.values()].map(({id,capabilities,priority,parallelSafe})=>({id,capabilities:[...capabilities],priority,parallelSafe}))});
}
function topologicalOrder(operations){
 const byId=new Map(operations.map(op=>[op.id,op]));
 if(byId.size!==operations.length)fail('operation IDs must be unique');
 for(const op of operations){
  if(!Array.isArray(op.dependsOn))fail('dependencies must be an array for '+op.id);
  for(const dep of op.dependsOn){if(!byId.has(dep))fail('unknown dependency '+dep+' for '+op.id);if(dep===op.id)fail('operation cannot depend on itself: '+op.id);}
 }
 const pending=new Map(operations.map(op=>[op.id,new Set(op.dependsOn)])),ordered=[];
 while(pending.size){
  const ready=operations.filter(op=>pending.has(op.id)&&pending.get(op.id).size===0);
  if(!ready.length)fail('operation dependency cycle detected');
  for(const op of ready){ordered.push(op);pending.delete(op.id);for(const deps of pending.values())deps.delete(op.id);}
 }
 return ordered;
}
/** Build a minimal DAG. A mask is selected only by explicit structured CV output. */
function createPlan({projectId,source,analysis,animation,output={}}={}){
 checkedId(projectId||'project.default','project id');
 if(!object(source)||!['psd','spine-json','spine-binary'].includes(source.format))fail('source.format must be psd, spine-json or spine-binary');
 if(!object(analysis)||!object(analysis.requirements))fail('structured Computer Vision analysis is required');
 if(!object(animation))fail('Animation Planner decision is required');
 const req=analysis.requirements;
 for(const key of ['clippingMask','rigging','meshDeformation','particles','semanticContour'])
  if(req[key]!==undefined&&typeof req[key]!=='boolean')fail('analysis.requirements.'+key+' must be boolean');
 const operations=[];
 const add=(id,capability,dependsOn=[])=>operations.push({id,capability,dependsOn:[...new Set(dependsOn)]});
 add('source.inspect',CAPABILITIES.SOURCE_INSPECT);
 add('vision.analyze',CAPABILITIES.VISION_ANALYZE,['source.inspect']);
 add('animation.plan',CAPABILITIES.ANIMATION_PLAN,['vision.analyze']);
 const preparation=[];
 if(req.semanticContour===true){
  add('semantic.contour.render',CAPABILITIES.CONTOUR_RENDER,['source.inspect','vision.analyze','animation.plan']);
  preparation.push('semantic.contour.render');
 }
 if(req.rigging===true){add('rig.build',CAPABILITIES.RIG_BUILD,['animation.plan',...(req.semanticContour===true?['semantic.contour.render']:[])]);preparation.push('rig.build');}
 if(req.meshDeformation===true){
  if(req.rigging!==true)fail('mesh deformation requires an explicit rigging requirement');
  add('mesh.deform',CAPABILITIES.MESH_DEFORM,['rig.build']);preparation.push('mesh.deform');
 }
 if(req.particles===true){add('particles.build',CAPABILITIES.PARTICLES_BUILD,['animation.plan']);preparation.push('particles.build');}
 const custom=animation.operations===undefined?[]:animation.operations;
 if(!Array.isArray(custom)||custom.length>64)fail('animation.operations must contain at most 64 operations');
 for(const item of custom){
  if(!object(item))fail('custom operation must be an object');
  const id=checkedId(item.id,'custom operation id');
  if(operations.some(op=>op.id===id)||id.startsWith('result.'))fail('custom operation ID is reserved or duplicated: '+id);
  const capability=checkedId(item.capability,'custom capability');
  const deps=item.dependsOn===undefined?['animation.plan']:item.dependsOn;
  if(!Array.isArray(deps))fail('custom dependsOn must be an array');
  add(id,capability,[...new Set(['animation.plan',...deps])]);preparation.push(id);
 }
 add('spine.animate',CAPABILITIES.ANIMATE,['animation.plan',...preparation]);
 add('spine.export',CAPABILITIES.EXPORT,['spine.animate']);
 if(req.clippingMask===true)add('mask.generate',CAPABILITIES.MASK_GENERATE,['spine.export']);
 const nativeProject=output.nativeProject!==false;
 const nativeInput=req.clippingMask===true?'mask.generate':'spine.export';
 if(nativeProject)add('spine.native-roundtrip',CAPABILITIES.NATIVE_ROUNDTRIP,[nativeInput]);
 add('project.package',CAPABILITIES.PACKAGE,[nativeProject?'spine.native-roundtrip':nativeInput]);
 add('result.deliver',CAPABILITIES.DELIVER,['project.package']);
 return {schemaVersion:1,projectId:projectId||'project.default',
  source:{format:source.format,...(source.sha256?{sha256:source.sha256}:{})},
  requirements:{clippingMask:req.clippingMask===true,semanticContour:req.semanticContour===true,rigging:req.rigging===true,
   meshDeformation:req.meshDeformation===true,particles:req.particles===true},
  nativeProject,operations:topologicalOrder(operations)};
}
function createUniversalPlan({scene,intent,proposal,registry,policy,review}={}) {
 Roles.validateRoleGraph();
 const descriptors=registry&&typeof registry.list==='function'?registry.list():(Array.isArray(registry)?registry:[]);
 return AnimationPlanner.compilePlan({scene,intent,proposal,registry:descriptors,policy,review});
}
async function executePlan(plan,registry,context={}){
 const executionPolicy=ExecutionPolicy.resolveExecutionPolicy(context.executionProfile||'animation-task');
 const executionContext={...context,executionPolicy};
 const universal=object(plan)&&plan.schema==='sa.animation-plan'&&plan.version===1;
 if(!object(plan)||(!universal&&plan.schemaVersion!==1)||!Array.isArray(plan.operations))fail('unsupported or malformed execution plan');
 if(!registry||typeof registry.resolve!=='function')fail('a Tool Registry is required');
 if(universal&&plan.status!=='ready')return {status:'blocked',blockedReason:'Animation Planner did not produce a ready plan: '+(plan.missingCapabilities||[]).join(', '),executionPolicy,trace:[],results:Object.create(null)};
 const ordered=topologicalOrder(plan.operations);
 if(!executionPolicy.runFullTestSuite&&ordered.some(operation=>ExecutionPolicy.isTestCapability(operation.capability)))
  return {status:'blocked',blockedReason:'Test-suite tools are disabled during animation tasks.',executionPolicy,trace:[],results:Object.create(null)};
 let selected;
 try{
  selected=ordered.map(operation=>{
   const tool=registry.resolve(operation.capability);
   if(!tool)fail('no registered tool provides '+operation.capability);
   return {operation,tool};
  });
 }catch(error){
  return {status:'blocked',blockedReason:String(error&&error.message?error.message:error).slice(0,500),
   executionPolicy,trace:[],results:Object.create(null)};
 }
 const maxParallel=executionContext.maxParallelOperations===undefined?4:executionContext.maxParallelOperations;
 if(!Number.isInteger(maxParallel)||maxParallel<1||maxParallel>16)fail('maxParallelOperations must be an integer from 1 to 16');
 const results=Object.create(null),trace=[];
 let remaining=[...selected];
 while(remaining.length){
  const ready=remaining.filter(({operation})=>operation.dependsOn.every(id=>Object.prototype.hasOwnProperty.call(results,id)));
  if(!ready.length)fail('execution graph has unresolved dependencies');
  const first=ready[0];
  // Parallel execution is opt-in per tool. Unknown adapters remain serialized.
  const batch=first.tool.parallelSafe===true
   ?ready.filter(({tool})=>tool.parallelSafe===true).slice(0,maxParallel)
   :[first];
  const batchIds=new Set(batch.map(({operation})=>operation.id));
  remaining=remaining.filter(({operation})=>!batchIds.has(operation.id));
  const entries=batch.map(({operation,tool})=>{
   const entry={operationId:operation.id,capability:operation.capability,toolId:tool.id,status:'running'};
   trace.push(entry);return entry;
  });
  const settled=await Promise.allSettled(batch.map(async({operation,tool})=>{
   // Operation IDs belong to the model-generated DAG and are intentionally
   // arbitrary. Adapters consume stable capability aliases, so expose both
   // the explicit dependency IDs and unambiguous capability names.
   const dependencies=Object.create(null),parents=operation.dependsOn.map(id=>ordered.find(candidate=>candidate.id===id));
   for(const id of operation.dependsOn)dependencies[id]=results[id];
   const capabilityCounts=new Map();
   for(const parent of parents)if(parent)
    capabilityCounts.set(parent.capability,(capabilityCounts.get(parent.capability)||0)+1);
   for(let index=0;index<parents.length;index++){
    const parent=parents[index];
    if(parent&&capabilityCounts.get(parent.capability)===1&&
       !Object.prototype.hasOwnProperty.call(dependencies,parent.capability))
     dependencies[parent.capability]=results[operation.dependsOn[index]];
   }
   return tool.run({operation:{...operation,dependsOn:[...operation.dependsOn]},context:executionContext,dependencies});
  }));
  let failed=null;
  settled.forEach((result,index)=>{
   const operation=batch[index].operation,entry=entries[index];
   if(result.status==='fulfilled'){
    results[operation.id]=result.value;entry.status='completed';
   }else{
    entry.status='failed';entry.error=String(result.reason&&result.reason.message?result.reason.message:result.reason).slice(0,500);
    if(!failed)failed=operation.id;
   }
  });
  if(failed)return {status:'failed',failedOperation:failed,executionPolicy,trace,results};
 }
 return {status:'completed',executionPolicy,trace,results};
}
function createProductionOrchestrator({registry,publish,idFactory,now,policyContext}={}){
 if(!registry||typeof registry.resolve!=='function')fail('Tool Registry is required');
 if(typeof registry.register==='function'&&(!registry.hasCapability||!registry.hasCapability(CAPABILITIES.CONTOUR_RENDER))){
  if(!SemanticContourAdapter||typeof SemanticContourAdapter.registerSemanticContourRendererTool!=='function')
   fail('semantic contour adapter is unavailable in the production runtime');
  SemanticContourAdapter.registerSemanticContourRendererTool(registry);
 }
 const {createEdgeRuntime}=require('./sa-edge-runtime.js');
 const edge=createEdgeRuntime({registry,publish,idFactory,now,policyContext});
 const planUniversal=input=>createUniversalPlan({...input,registry});
 const runUniversal=async(input,context={})=>{
  const plan=planUniversal(input);
  if(plan.status!=='ready')return {status:'blocked',blockedReason:'Animation Planner did not produce a ready plan: '+(plan.missingCapabilities||[]).join(', '),
   plan,executionPolicy:ExecutionPolicy.resolveExecutionPolicy(context.executionProfile||'animation-task'),trace:[],results:Object.create(null)};
  const executionPolicy=ExecutionPolicy.resolveExecutionPolicy(context.executionProfile||'animation-task');
  if(!executionPolicy.runFullTestSuite&&plan.operations.some(operation=>ExecutionPolicy.isTestCapability(operation.capability)))
   return {status:'blocked',blockedReason:'Test-suite tools are disabled during animation tasks.',plan,executionPolicy,trace:[],results:Object.create(null)};
  const sourceId=plan.scene&&plan.scene.source&&plan.scene.source.id;
  const result=await edge.execute(plan,{...context,projectId:context.projectId||sourceId||'sa-project'});
  return {...result,plan,executionPolicy};
 };
 return Object.freeze({
  plan:input=>createPlan(input),
  run:async(input,context={})=>{
   const plan=createPlan(input);
   return edge.execute(plan,{...context,projectId:context.projectId||plan.projectId});
  },
  planUniversal,
  runUniversal
 });
}


function createCloudflareProductionOrchestrator({registry,accountId,queueId,apiToken,fetchImpl,...options}={}){
 const {createCloudflareQueueTransport}=require('./sa-edge-runtime.js');
 const transport=createCloudflareQueueTransport({accountId,queueId,apiToken,fetchImpl});
 const orchestrator=createProductionOrchestrator({...options,registry,publish:transport.publish});
 return Object.freeze({plan:orchestrator.plan,run:orchestrator.run,planUniversal:orchestrator.planUniversal,runUniversal:orchestrator.runUniversal,transport});
}


function createCloudflareEventConsumer({accountId,queueId,apiToken,fetchImpl,idempotencyStore,
 roleHandlers=[],now,retryDelaySeconds}={}) {
 if(!idempotencyStore)fail('a durable idempotencyStore is required for the production event consumer');
 if(!Array.isArray(roleHandlers))fail('roleHandlers must be an array');
 const {createCloudflareQueueTransport}=require('./sa-edge-runtime.js');
 const {createEventFabric}=require('./sa-event-fabric.js');
 const transport=createCloudflareQueueTransport({accountId,queueId,apiToken,fetchImpl});
 const fabric=createEventFabric({transport,idempotencyStore,now,retryDelaySeconds});
 for(const handler of roleHandlers)fabric.registerRole(handler);
 return Object.freeze({
  transport,
  fabric,
  consumeOnce:options=>fabric.consumeOnce(options),
  publish:event=>fabric.publish(event),
  listRoles:()=>fabric.listRoles()
 });
}


const api={CAPABILITIES,DEFAULT_CAPABILITIES,ROLE_GRAPH:Roles.ROLE_GRAPH,createToolRegistry,createPlan,createUniversalPlan,executePlan,topologicalOrder};
if(typeof module==='object'&&module.exports){api.createProductionOrchestrator=createProductionOrchestrator;api.createCloudflareProductionOrchestrator=createCloudflareProductionOrchestrator;api.createCloudflareEventConsumer=createCloudflareEventConsumer;module.exports=api;}
else if(typeof globalThis!=='undefined')globalThis.SAAgent=api;
})();
