'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const SA=require('../engine/sa-agent.js');
const SceneIR=require('../engine/scene-ir.js');
function fixture(overrides={}){return {
 projectId:'casino.symbol',source:{format:'psd',sha256:'a'.repeat(64)},
 analysis:{requirements:{clippingMask:false,rigging:false,meshDeformation:false,particles:false}},
 animation:{description:'A short moving highlight',operations:[]},output:{nativeProject:true},...overrides
};}
function registryFor(capabilities,calls=[]){
 const registry=SA.createToolRegistry();
 for(const capability of capabilities)registry.register({id:'tool.'+capability.replaceAll('.','-'),
  capabilities:[capability],run:async({operation})=>{calls.push(operation.id);return {operation:operation.id};}});
 return registry;
}
test('mask is not planned unless CV explicitly requires clipping',()=>{
 const plan=SA.createPlan(fixture());
 assert.equal(plan.operations.some(op=>op.capability===SA.CAPABILITIES.MASK_GENERATE),false);
 assert.equal(plan.requirements.clippingMask,false);
});
test('explicit clipping requirement runs mask after Spine export and before native roundtrip',()=>{
 const plan=SA.createPlan(fixture({analysis:{requirements:{clippingMask:true}}}));
 const mask=plan.operations.find(op=>op.id==='mask.generate');
 const exported=plan.operations.find(op=>op.id==='spine.export');
 const native=plan.operations.find(op=>op.id==='spine.native-roundtrip');
 assert.deepEqual(mask.dependsOn,['spine.export']);
 assert.ok(plan.operations.indexOf(exported)<plan.operations.indexOf(mask));
 assert.ok(plan.operations.indexOf(mask)<plan.operations.indexOf(native));
 assert.deepEqual(native.dependsOn,['mask.generate']);
});
test('no clipping requirement leaves the optional mask tool out of the DAG',()=>{
 const plan=SA.createPlan(fixture());
 assert.equal(plan.operations.some(op=>op.capability===SA.CAPABILITIES.MASK_GENERATE),false);
 assert.deepEqual(plan.operations.find(op=>op.id==='spine.native-roundtrip').dependsOn,['spine.export']);
});
test('explicit semantic contour requirement inserts renderer before rigging and animation',()=>{
 const plan=SA.createPlan(fixture({analysis:{requirements:{semanticContour:true,rigging:true}}}));
 const contour=plan.operations.find(op=>op.id==='semantic.contour.render');
 const rig=plan.operations.find(op=>op.id==='rig.build');
 const animate=plan.operations.find(op=>op.id==='spine.animate');
 assert.ok(contour);
 assert.equal(contour.capability,SA.CAPABILITIES.CONTOUR_RENDER);
 assert.deepEqual(contour.dependsOn,['source.inspect','vision.analyze','animation.plan']);
 assert.deepEqual(rig.dependsOn,['animation.plan','semantic.contour.render']);
 assert.ok(plan.operations.indexOf(contour)<plan.operations.indexOf(rig));
 assert.ok(plan.operations.indexOf(rig)<plan.operations.indexOf(animate));
 assert.equal(plan.requirements.semanticContour,true);
});
test('semantic contour remains absent unless explicitly required',()=>{
 const plan=SA.createPlan(fixture());
 assert.equal(plan.operations.some(op=>op.capability===SA.CAPABILITIES.CONTOUR_RENDER),false);
 assert.equal(plan.requirements.semanticContour,false);
});
test('planner composes custom specialist operations into a new DAG',()=>{
 const plan=SA.createPlan(fixture({animation:{operations:[
  {id:'gold.glint',capability:'fx.gold-glint'},
  {id:'glint.composite',capability:'fx.composite',dependsOn:['gold.glint']}
 ]}}));
 const ids=plan.operations.map(op=>op.id);
 assert.ok(ids.indexOf('gold.glint')<ids.indexOf('glint.composite'));
 assert.ok(ids.indexOf('glint.composite')<ids.indexOf('spine.animate'));
});
test('mesh deformation requires explicit rigging',()=>{
 assert.throws(()=>SA.createPlan(fixture({analysis:{requirements:{meshDeformation:true}}})),/requires an explicit rigging requirement/);
});
test('executor invokes only the selected plan operations',async()=>{
 const plan=SA.createPlan(fixture({analysis:{requirements:{clippingMask:true}},output:{nativeProject:false}}));
 const calls=[],registry=registryFor(SA.DEFAULT_CAPABILITIES,calls);
 const result=await SA.executePlan(plan,registry,{jobId:'job-1'});
 assert.equal(result.status,'completed');assert.deepEqual(calls,plan.operations.map(op=>op.id));
 assert.ok(calls.includes('mask.generate'));
});
test('missing capabilities are preflighted before any side effect',async()=>{
 const plan=SA.createPlan(fixture()),calls=[],registry=registryFor([SA.CAPABILITIES.SOURCE_INSPECT],calls);
 const result=await SA.executePlan(plan,registry);
 assert.equal(result.status,'blocked');assert.deepEqual(calls,[]);
 assert.deepEqual(result.trace,[]);
});
test('dependency cycles fail closed',()=>{
 assert.throws(()=>SA.topologicalOrder([
  {id:'step.alpha',capability:'step.alpha',dependsOn:['step.beta']},
  {id:'step.beta',capability:'step.beta',dependsOn:['step.alpha']}
 ]),/dependency cycle/);
});
test('native Editor roundtrip is required by default',()=>{
 const native=SA.createPlan(fixture()),portable=SA.createPlan(fixture({output:{nativeProject:false}}));
 assert.ok(native.operations.some(op=>op.capability===SA.CAPABILITIES.NATIVE_ROUNDTRIP));
 assert.equal(portable.operations.some(op=>op.capability===SA.CAPABILITIES.NATIVE_ROUNDTRIP),false);
});
test('native Editor capability is preflighted before source inspection starts',async()=>{
 const plan=SA.createPlan(fixture()),calls=[];
 const capabilities=SA.DEFAULT_CAPABILITIES.filter(x=>x!==SA.CAPABILITIES.NATIVE_ROUNDTRIP);
 const result=await SA.executePlan(plan,registryFor(capabilities,calls));
 assert.equal(result.status,'blocked');
 assert.deepEqual(calls,[]);
 assert.match(result.blockedReason,/spine\.editor\.native-roundtrip/);
});
test('first failed operation stops execution and is never reported complete',async()=>{
 const plan=SA.createPlan(fixture({output:{nativeProject:false}})),registry=SA.createToolRegistry();
 for(const capability of SA.DEFAULT_CAPABILITIES)registry.register({id:'tool.'+capability.replaceAll('.','-'),
  capabilities:[capability],run:async({operation})=>{if(operation.id==='spine.export')throw Error('export failed');return operation.id;}});
 const result=await SA.executePlan(plan,registry);
 assert.equal(result.status,'failed');assert.equal(result.failedOperation,'spine.export');
 assert.equal(result.trace.at(-1).status,'failed');
});

test('production orchestrator registers the semantic contour adapter when absent',()=>{
 const registry=SA.createToolRegistry();
 const orchestrator=SA.createProductionOrchestrator({registry,publish:async()=>({delivered:true})});
 assert.equal(registry.hasCapability(SA.CAPABILITIES.CONTOUR_RENDER),true);
 assert.equal(typeof orchestrator.plan,'function');
});
test('production orchestrator connects planning, registry execution and bidirectional edge events',async()=>{
 const events=[],registry=registryFor(SA.DEFAULT_CAPABILITIES,[]);
 const orchestrator=SA.createProductionOrchestrator({registry,publish:async event=>events.push(event),
  idFactory:(()=>{let n=0;return()=> 'orch-event-'+(++n);})(),
  now:()=>new Date('2026-11-21T10:00:00.000Z'),
  policyContext:{permission_scope:['artifact:read','artifact:write','spine:export'],
   data_classification:'project-private',expires_at:'2026-11-21T10:30:00.000Z'}
 });
 const result=await orchestrator.run(fixture({output:{nativeProject:false}}),{jobId:'orchestrator-job'});
 assert.equal(result.status,'completed');assert.ok(result.trace.length>=5);
 assert.equal(events.length,result.trace.length*2);
 assert.equal(events[0].direction,'command');assert.equal(events[1].direction,'feedback');
 assert.equal(events[0].correlation_id,'orchestrator-job');
});
test('production orchestrator sends universal Planner operations through correlated A1-A7 command and feedback events',async()=>{
 const events=[],registry=SA.createToolRegistry();
 registry.register({id:'tool.native-export',capabilities:['spine.export'],run:async({operation})=>({exported:operation.inputs.entityId})});
 const orchestrator=SA.createProductionOrchestrator({registry,publish:async event=>events.push(event),
  idFactory:(()=>{let n=0;return()=> 'universal-event-'+(++n);})(),
  now:()=>new Date('2026-11-21T10:00:00.000Z'),
  policyContext:{permission_scope:['artifact:read','artifact:write','spine:export'],
   data_classification:'project-private',expires_at:'2026-11-21T10:30:00.000Z'}
 });
 const scene=SceneIR.createSceneIR({source:{format:'psd',id:'source.project',width:64,height:64},
  entities:[{id:'layer.body',kind:'source-layer',bounds:{x:0,y:0,width:32,height:48}}]});
 const input={scene,intent:{goal:'Export the verified source layer',target:'layer.body'},
  proposal:{confidence:.95,rationale:'The export target is a measured source layer.',
   operations:[{id:'export.body',capability:'spine.export',inputs:{entityId:'layer.body'}}]}};
 const plan=orchestrator.planUniversal(input);
 assert.equal(plan.status,'ready');
 const result=await orchestrator.runUniversal(input,{jobId:'universal-job'});
 assert.equal(result.status,'completed');
 assert.equal(result.plan.status,'ready');
 assert.equal(result.results['export.body'].exported,'layer.body');
 assert.equal(events.length,2);
 assert.equal(events[0].direction,'command');
 assert.equal(events[1].direction,'feedback');
 assert.equal(events[0].project_id,'source.project');
 assert.equal(events[0].correlation_id,'universal-job');
 assert.equal(events[0].target,'A5.runtime');
});

test('production orchestrator blocks an unready universal plan before edge events',async()=>{
 const events=[],registry=SA.createToolRegistry();
 registry.register({id:'tool.native-export',capabilities:['spine.export'],run:async()=>({})});
 const orchestrator=SA.createProductionOrchestrator({registry,publish:async event=>events.push(event)});
 const scene=SceneIR.createSceneIR({source:{format:'psd',id:'source.blocked',width:32,height:32},
  entities:[{id:'layer.body',kind:'source-layer',bounds:{x:0,y:0,width:16,height:16}}]});
 const result=await orchestrator.runUniversal({scene,intent:{goal:'Use an unavailable capability'},
  proposal:{operations:[{id:'unavailable',capability:'geometry.not-registered',inputs:{entityId:'layer.body'}}]}});
 assert.equal(result.status,'blocked');
 assert.equal(result.plan.status,'blocked');
 assert.equal(events.length,0);
});

test('production orchestrator refuses to start without an event publisher',()=>{
 assert.throws(()=>SA.createProductionOrchestrator({registry:registryFor(SA.DEFAULT_CAPABILITIES)}),/event publisher is required/);
});

test('Cloudflare production factory connects orchestration directly to the durable queue API',async()=>{
 const requests=[],registry=registryFor(SA.DEFAULT_CAPABILITIES,[]);
 const runtime=SA.createCloudflareProductionOrchestrator({registry,accountId:'a'.repeat(32),queueId:'b'.repeat(32),
  apiToken:'token-'+'x'.repeat(32),fetchImpl:async(url,init)=>{
   requests.push({url,init});return new Response(JSON.stringify({success:true,result:{message_id:'m1'}}),{status:200});
  },idFactory:(()=>{let n=0;return()=> 'queue-event-'+(++n);})(),
  now:()=>new Date('2026-11-21T10:00:00.000Z'),
  policyContext:{permission_scope:['queue:write'],data_classification:'project-private',expires_at:'2026-11-21T10:30:00.000Z'}
 });
 const result=await runtime.run(fixture({output:{nativeProject:false}}),{jobId:'queue-job'});
 assert.equal(result.status,'completed');assert.equal(requests.length,result.trace.length*2);
 assert.ok(requests.every(x=>x.url.endsWith('/messages')));
 assert.equal(requests[0].init.headers.Authorization,'Bearer token-'+'x'.repeat(32));
});

test('universal executor exposes capability aliases when model DAG uses arbitrary operation IDs',async()=>{
 const registry=SA.createToolRegistry(),seen={};
 registry.register({id:'tool.custom-export',capabilities:['spine.export'],run:async()=>({artifact:'native.zip'})});
 registry.register({id:'tool.custom-mask',capabilities:['spine.mask.generate'],run:async({dependencies})=>{
  seen.byId=dependencies['export.native'];seen.byCapability=dependencies['spine.export'];
  return {masked:true};
 }});
 const scene=SceneIR.createSceneIR({source:{format:'psd',id:'source.aliases',width:64,height:64},
  entities:[{id:'layer.body',kind:'source-layer',bounds:{x:0,y:0,width:32,height:32}}]});
 const plan=SA.createUniversalPlan({scene,intent:{goal:'Mask a model-generated attachment'},registry,
  proposal:{operations:[
   {id:'export.native',capability:'spine.export',dependsOn:[]},
   {id:'mask.native',capability:'spine.mask.generate',dependsOn:['export.native']}
  ]}});
 assert.equal(plan.status,'ready');
 const result=await SA.executePlan(plan,registry);
 assert.equal(result.status,'completed');
 assert.deepEqual(seen.byId,{artifact:'native.zip'});
 assert.deepEqual(seen.byCapability,{artifact:'native.zip'});
 assert.deepEqual(result.results['mask.native'],{masked:true});
});

test('universal executor omits ambiguous capability aliases but preserves each explicit dependency ID',async()=>{
 const registry=SA.createToolRegistry();let observed;
 registry.register({id:'tool.inspect',capabilities:['source.inspect'],run:async({operation})=>({id:operation.id})});
 registry.register({id:'tool.join',capabilities:['vision.analyze'],run:async({dependencies})=>{
  observed=dependencies;return {joined:true};
 }});
 const scene=SceneIR.createSceneIR({source:{format:'psd',id:'source.ambiguous',width:32,height:32},
  entities:[{id:'layer.body',kind:'source-layer',bounds:{x:0,y:0,width:16,height:16}}]});
 const plan=SA.createUniversalPlan({scene,intent:{goal:'Join independent inspection outputs'},registry,
  proposal:{operations:[
   {id:'inspect.first',capability:'source.inspect'},
   {id:'inspect.second',capability:'source.inspect'},
   {id:'vision.join',capability:'vision.analyze',dependsOn:['inspect.first','inspect.second']}
  ]}});
 assert.equal(plan.status,'ready');
 const result=await SA.executePlan(plan,registry);
 assert.equal(result.status,'completed');
 assert.deepEqual(observed['inspect.first'],{id:'inspect.first'});
 assert.deepEqual(observed['inspect.second'],{id:'inspect.second'});
 assert.equal(Object.hasOwn(observed,'source.inspect'),false);
});
