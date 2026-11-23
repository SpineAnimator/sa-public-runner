'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const IR=require('../engine/scene-ir.js');
const Planner=require('../engine/animation-planner.js');
const scene={source:{format:'psd',width:1024,height:768,sha256:'a'.repeat(64)},
 entities:[{id:'layer.body',kind:'raster-layer',bounds:{x:10,y:20,width:200,height:300},drawOrder:0},
 {id:'layer.tail',kind:'raster-layer',bounds:{x:100,y:220,width:180,height:100},drawOrder:1,parentId:'layer.body',
  hypotheses:[{label:'appendage',confidence:.72,provider:'vision-model'}]}],
 relations:[{type:'attached-to',from:'layer.tail',to:'layer.body',confidence:.6}],
 evidence:[{id:'evidence.bounds',kind:'pixel-bounds',entityId:'layer.body',confidence:1}]};
test('Scene IR is compact, format-neutral and preserves evidence separately from hypotheses',()=>{
 const ir=IR.createSceneIR(scene);
 assert.equal(ir.schema,'sa.scene-ir');assert.equal(ir.entities.length,2);
 assert.equal(ir.entities[1].hypotheses[0].confidence,.72);
 assert.equal(ir.relations[0].type,'attached-to');
 assert.equal(IR.summarizeScene(ir).entityCount,2);
});
test('Scene IR rejects broken references and invalid geometry',()=>{
 assert.throws(()=>IR.createSceneIR({...scene,relations:[{type:'parent',from:'layer.body',to:'missing'}]}),/unknown entity/);
 assert.throws(()=>IR.createSceneIR({...scene,entities:[{id:'bad',bounds:{x:0,y:0,width:-1,height:2}}]}),/bounds are invalid/);
 assert.throws(()=>IR.createSceneIR({...scene,entities:[{id:'a'},{id:'a'}]}),/duplicate entity/);
});
test('planner composes arbitrary animation workflows without a fixed action taxonomy',()=>{
 const registry=[{id:'vision.mesh',capabilities:['geometry.mesh']},{id:'fx.spark',capabilities:['fx.sparkle']},{id:'spine.export',capabilities:['spine.export']}];
 const plan=Planner.compilePlan({scene,intent:{goal:'Make the tail wave and emit a short sparkle burst',target:'layer.tail'},
  registry,proposal:{confidence:.91,rationale:'Tail is an appendage hypothesis; sparkle is a separate effect.',
   operations:[{id:'tail.mesh',capability:'geometry.mesh',inputs:{entityId:'layer.tail'}},
    {id:'sparkle',capability:'fx.sparkle',dependsOn:['tail.mesh']},
    {id:'export',capability:'spine.export',dependsOn:['sparkle']}]}});
 assert.equal(plan.status,'ready');assert.deepEqual(plan.operationOrder,['tail.mesh','sparkle','export']);
 assert.deepEqual(plan.operations[0].inputs,{entityId:'layer.tail'});
});
test('planner reports unavailable required capabilities before execution',()=>{
 const plan=Planner.compilePlan({scene,intent:{goal:'Animate the scene'},registry:[],
  proposal:{operations:[{id:'rig',capability:'spine.rig.build'}]}});
 assert.equal(plan.status,'blocked');assert.deepEqual(plan.missingCapabilities,['spine.rig.build']);
});
test('planner does not silently invent or run optional tools',()=>{
 const plan=Planner.compilePlan({scene,intent:{goal:'Move one layer'},registry:[],
  proposal:{operations:[{id:'optional.fx',capability:'fx.optional',optional:true}]}});
 assert.equal(plan.status,'ready');assert.deepEqual(plan.operations,[]);
});
test('planner rejects cycles, unknown dependencies and malformed confidence',()=>{
 assert.throws(()=>Planner.compilePlan({scene,intent:{goal:'x'},registry:[],proposal:{operations:[
  {id:'step.alpha',capability:'cap.alpha',dependsOn:['step.beta']},{id:'step.beta',capability:'cap.beta',dependsOn:['step.alpha']}
 ]}}),/dependency cycle/);
 assert.throws(()=>Planner.compilePlan({scene,intent:{goal:'x'},registry:[],proposal:{confidence:2,operations:[]}}),/confidence/);
});

const VisionAdapter=require('../engine/vision-scene-adapter.js');
const SA=require('../engine/sa-agent.js');
test('Computer Vision output becomes shared Scene IR without promoting hypotheses to facts',()=>{
 const ir=VisionAdapter.fromVision({source:{format:'psd',width:100,height:80},
  layers:[{id:'layer.1',name:'Body Artwork',left:2,top:3,width:40,height:20,order:0}],
  analysis:{subject:{kind:'unknown-character',confidence:.7},model:'vision-v1',
   parts:[{id:'part.1',kind:'appendage',confidence:.6,layerIds:['layer.1'],chains:[]}]}});
 assert.equal(ir.entities[0].kind,'source-layer');
 assert.equal(ir.entities[0].name,'Body Artwork');
 assert.equal(ir.entities[0].hypotheses[0].label,'appendage');
 assert.equal(ir.metadata.semanticStatus,'model-proposal');
});
test('CV -> Animation Planner -> executable orchestrator is one validated path',async()=>{
 const registry=SA.createToolRegistry(),calls=[];
 registry.register({id:'tool.rig',capabilities:['spine.rig.build'],run:async({operation})=>{calls.push(operation.id);return {rig:true};}});
 registry.register({id:'tool.animate',capabilities:['spine.animate'],run:async({operation})=>{calls.push(operation.id);return {animated:true};}});
 const sceneIR=VisionAdapter.fromVision({source:{format:'psd',width:100,height:80},
  layers:[{id:'layer.character',left:0,top:0,width:80,height:80,order:0}]});
 const plan=SA.createUniversalPlan({scene:sceneIR,intent:{goal:'Build a flexible character rig and animate a wave'},
  registry,proposal:{confidence:.9,operations:[
   {id:'rig',capability:'spine.rig.build',inputs:{rigPlan:{rig:{armIK:{enabled:false}}}}},
   {id:'wave',capability:'spine.animate',dependsOn:['rig']}
  ]}});
 assert.equal(plan.status,'ready');
 const result=await SA.executePlan(plan,registry,{projectId:'project.test'});
 assert.equal(result.status,'completed');
 assert.deepEqual(calls,['rig','wave']);
});
test('blocked universal plan is rejected before any executor side effect',async()=>{
 const registry=SA.createToolRegistry(),calls=[];
 registry.register({id:'tool.present',capabilities:['spine.animate'],run:async()=>calls.push('run')});
 const sceneIR=IR.createSceneIR(scene);
 const plan=SA.createUniversalPlan({scene:sceneIR,intent:{goal:'Create a complex simulation'},
  registry,proposal:{operations:[{id:'simulation',capability:'physics.simulate'}]}});
 const result=await SA.executePlan(plan,registry);
 assert.equal(result.status,'blocked');assert.deepEqual(calls,[]);
});

test('animation execution blocks test-suite capabilities before side effects',async()=>{
 const registry=SA.createToolRegistry(),calls=[];
 registry.register({id:'test-suite',capabilities:['test.suite.run'],run:async()=>calls.push('ran')});
 const result=await SA.executePlan({schemaVersion:1,operations:[
  {id:'suite',capability:'test.suite.run',dependsOn:[]}
 ]},registry);
 assert.equal(result.status,'blocked');
 assert.match(result.blockedReason,/disabled during animation tasks/);
 assert.deepEqual(calls,[]);
});

test('Orchestrator runs explicitly parallel-safe independent operations concurrently and waits for dependencies',async()=>{
 const registry=SA.createToolRegistry();
 let active=0,peak=0,release;
 const gate=new Promise(resolve=>{release=resolve;});
 registry.register({id:'tool.parallel.a',capabilities:['test.parallel.a'],parallelSafe:true,run:async()=>{
  active++;peak=Math.max(peak,active);await gate;active--;return {a:true};
 }});
 registry.register({id:'tool.parallel.b',capabilities:['test.parallel.b'],parallelSafe:true,run:async()=>{
  active++;peak=Math.max(peak,active);await gate;active--;return {b:true};
 }});
 registry.register({id:'tool.dependent',capabilities:['test.dependent'],run:async({dependencies})=>{
  assert.deepEqual(Object.keys(dependencies).sort(),['parallel.a','parallel.b','test.parallel.a','test.parallel.b']);
  assert.deepEqual(dependencies['parallel.a'],{a:true});
  assert.deepEqual(dependencies['parallel.b'],{b:true});
  return {joined:true};
 }});
 const sceneIR=VisionAdapter.fromVision({source:{format:'image',width:20,height:20},
  layers:[{id:'layer.root',left:0,top:0,width:10,height:10,order:0}]});
 const plan=SA.createUniversalPlan({scene:sceneIR,intent:{goal:'Run independent preparation and join results'},registry,
  proposal:{operations:[
   {id:'parallel.a',capability:'test.parallel.a'},
   {id:'parallel.b',capability:'test.parallel.b'},
   {id:'join',capability:'test.dependent',dependsOn:['parallel.a','parallel.b']}
  ]}});
 const pending=SA.executePlan(plan,registry,{projectId:'parallel.test',maxParallelOperations:2,executionProfile:'development-ci'});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(peak,2,'both independent operations should overlap');
 release();
 const result=await pending;
 assert.equal(result.status,'completed');
 assert.deepEqual(result.trace.map(item=>item.operationId),['parallel.a','parallel.b','join']);
 assert.equal(result.results.join.joined,true);
});

test('seven role contracts form a valid dependency graph and are bound to SA Core',()=>{
 const order=SA.ROLE_GRAPH.map(role=>role.id);
 assert.equal(order.length,7);
 assert.ok(order.includes('computer.vision'));
 assert.ok(order.includes('animation.planner'));
 assert.ok(SA.ROLE_GRAPH.find(role=>role.id==='animation.planner').dependsOn.includes('computer.vision'));
 assert.ok(SA.ROLE_GRAPH.find(role=>role.id==='animation.planner').dependsOn.includes('tool.registry'));
 assert.ok(SA.ROLE_GRAPH.find(role=>role.id==='tool.orchestrator').dependsOn.includes('animation.planner'));
});

test('CV refuses to manufacture geometry, visibility or raster type when source metadata is absent',()=>{
 assert.throws(()=>VisionAdapter.fromVision({source:{format:'psd',width:20,height:20},
  layers:[{id:'layer.missing',left:0,top:0,width:10}]}),/layer.height must be present and finite/);
 const ir=VisionAdapter.fromVision({source:{format:'psd',width:20,height:20},
  layers:[{id:'layer.unknown',left:1,top:2,width:3,height:4}]});
 assert.equal(ir.entities[0].kind,'source-layer');
 assert.equal(Object.hasOwn(ir.entities[0],'visible'),false);
});
test('CV rejects semantic proposals and parent links that reference nonexistent source layers',()=>{
 assert.throws(()=>VisionAdapter.fromVision({source:{format:'psd',width:20,height:20},
  layers:[{id:'layer.real',left:0,top:0,width:10,height:10}],
  analysis:{subject:{kind:'object',confidence:.9},model:'vision-v1',
   parts:[{id:'part.1',kind:'hand',confidence:.8,layerIds:['layer.ghost'],chains:[]}]}}),/unknown source layer/);
 assert.throws(()=>VisionAdapter.fromVision({source:{format:'psd',width:20,height:20},
  layers:[{id:'layer.real',left:0,top:0,width:10,height:10,parentId:'layer.ghost'}]}),/unknown source layer/);
});

test('pixel analysis cache reuses immutable layer identity and supports targeted invalidation',()=>{
 const Vision=require('../engine/vision.js');
 const cache=Vision.createAnalysisCache();
 const key={layer:'immutable-source-layer'};
 const image={width:8,height:8,data:new Uint8ClampedArray(8*8*4)};
 image.data[(3*8+3)*4+3]=255;
 const options={maxPixels:64,maxGraphPoints:100};
 const first=cache.analyze(key,image,options);
 const second=cache.analyze(key,()=>{throw new Error('cache hit must not reread pixels');},options);
 assert.equal(first,second);
 assert.ok(Object.isFrozen(first)&&Object.isFrozen(first.components));
 assert.deepEqual(cache.stats(),{hits:1,misses:1});
 assert.equal(cache.invalidate(key),true);
 const third=cache.analyze(key,image,options);
 assert.notEqual(first,third);
 assert.deepEqual(cache.stats(),{hits:1,misses:2});
});

test('deterministic pixel components become explicit geometry and evidence in the shared Scene IR',()=>{
 const image={width:12,height:10,data:new Uint8ClampedArray(12*10*4)};
 for(let y=2;y<6;y++)for(let x=3;x<8;x++)image.data[(y*12+x)*4+3]=255;
 const pixels=require('../engine/vision.js').analyzePixels(image,{maxPixels:120,maxGraphPoints:1000});
 pixels.components.forEach(component=>{component.layerId='layer.source';component.sampleScale=pixels.sample.scale;});
 const sourceScene=VisionAdapter.fromVision({source:{format:'image',width:12,height:10},
  layers:[{id:'layer.source',left:0,top:0,width:12,height:10,order:0}]});
 const enriched=VisionAdapter.withPixelTopology(sourceScene,pixels);
 const component=enriched.entities.find(entity=>entity.kind==='pixel-component');
 assert.ok(component);
 assert.deepEqual(component.bounds,{x:3,y:2,width:5,height:4});
 assert.equal(component.geometry.pixelCount,20);
 assert.ok(enriched.evidence.some(item=>item.id==='pixel.component.bounds.0'&&item.entityId===component.id));
 assert.equal(component.parentId,'layer.source');
 assert.ok(enriched.relations.some(item=>item.type==='contains'&&item.from==='layer.source'&&item.to===component.id));
 assert.equal(enriched.metadata.pixelTopology.semanticStatus,'unclassified');
 const plan=Planner.compilePlan({scene:enriched,intent:{goal:'Use measured pixel component geometry'},
  registry:[{id:'tool.geometry',capabilities:['geometry.inspect']}],
  proposal:{operations:[{id:'inspect.component',capability:'geometry.inspect',
   inputs:{entityId:component.id,evidenceRefs:['pixel.component.bounds.0']}}]}});
 assert.equal(plan.status,'ready');
});

test('pixel topology cannot be attached to a different-sized or malformed Scene IR source',()=>{
 const scene=VisionAdapter.fromVision({source:{format:'image',width:12,height:10},
  layers:[{id:'layer.source',left:0,top:0,width:12,height:10,order:0}]});
 const pixels={source:{width:11,height:10},components:[],graph:{nodes:[],chains:[]}};
 assert.throws(()=>VisionAdapter.withPixelTopology(scene,pixels),/dimensions do not match/);
 assert.throws(()=>VisionAdapter.withPixelTopology(scene,{source:{width:12,height:10},components:[],graph:{}}),/complete deterministic pixel-topology/);
});

test('planner rejects operation targets absent from source-backed Scene IR',()=>{
 assert.throws(()=>Planner.compilePlan({scene,intent:{goal:'Animate a missing object'},registry:[],
  proposal:{operations:[{id:'animate.missing',capability:'spine.animate',inputs:{entityId:'layer.not-in-scene'}}]}}),
  /references unknown source object/);
});
test('planner validates evidence references against the shared Scene IR',()=>{
 assert.throws(()=>Planner.compilePlan({scene,intent:{goal:'Animate the body'},registry:[],
  proposal:{operations:[{id:'animate.body',capability:'spine.animate',inputs:{entityId:'layer.body',evidenceRefs:['evidence.fabricated']}}]}}),
  /references missing Scene IR evidence/);
 const plan=Planner.compilePlan({scene,intent:{goal:'Animate the body'},registry:[{id:'tool.animate',capabilities:['spine.animate']}],
  proposal:{operations:[{id:'animate.body',capability:'spine.animate',inputs:{entityId:'layer.body',evidenceRefs:['evidence.bounds']}}]}});
 assert.equal(plan.status,'ready');
});


const Review=require('../engine/analysis-review-coordinator.js');
test('parallel independent reviews corroborate but never promote model claims to verified facts',async()=>{
 const run=async()=>({claims:[{id:'claim.body-kind',subjectId:'layer.body',predicate:'semantic-kind',
  value:'body',confidence:.91,evidenceRefs:['evidence.bounds']}]});
 const report=await Review.reviewInParallel({scene,intent:{goal:'Identify the body layer'},reviewers:[
  {id:'review.alpha',provider:'chatgpt',independenceGroup:'provider-a',run},
  {id:'review.beta',provider:'chatgpt',independenceGroup:'provider-b',run}
 ]});
 assert.equal(report.claims[0].status,'corroborated');
 assert.deepEqual(report.corroboratedClaimIds,['claim.body-kind']);
 assert.deepEqual(report.verifiedClaimIds,[]);
});
test('conflicting parallel analyses remain disputed and block dependent animation operations',async()=>{
 const report=await Review.reviewInParallel({scene,intent:{goal:'Classify the source layer'},reviewers:[
  {id:'review.one',provider:'model-a',independenceGroup:'model-a',
   run:async()=>({claims:[{id:'claim.kind',subjectId:'layer.body',predicate:'semantic-kind',value:'body',confidence:.9,evidenceRefs:['evidence.bounds']}]})},
  {id:'review.two',provider:'model-b',independenceGroup:'model-b',
   run:async()=>({claims:[{id:'claim.kind',subjectId:'layer.body',predicate:'semantic-kind',value:'background',confidence:.95,evidenceRefs:['evidence.bounds']}]})}
 ]});
 assert.equal(report.claims[0].status,'disputed');
 const plan=Planner.compilePlan({scene,intent:{goal:'Animate the identified body'},registry:[{id:'tool.animate',capabilities:['spine.animate']}],
  review:report,proposal:{operations:[{id:'animate.body',capability:'spine.animate',
   inputs:{entityId:'layer.body',claimRefs:['claim.kind']}}]}});
 assert.equal(plan.status,'blocked');
 assert.equal(plan.unresolvedClaims[0].reason,'conflicting independent analyses');
});
test('corroboration alone is not deterministic verification for safety-critical claims',async()=>{
 const report=await Review.reviewInParallel({scene,intent:{goal:'Verify semantic identity'},reviewers:[
  {id:'review.a',provider:'a',independenceGroup:'a',run:async()=>({claims:[{id:'claim.identity',subjectId:'layer.body',predicate:'identity',value:'body',confidence:.99,evidenceRefs:['evidence.bounds']}]})},
  {id:'review.b',provider:'b',independenceGroup:'b',run:async()=>({claims:[{id:'claim.identity',subjectId:'layer.body',predicate:'identity',value:'body',confidence:.99,evidenceRefs:['evidence.bounds']}]})}
 ]});
 const plan=Planner.compilePlan({scene,intent:{goal:'Run a semantic-dependent operation'},registry:[{id:'tool.animate',capabilities:['spine.animate']}],
  review:report,proposal:{operations:[{id:'animate.identity',capability:'spine.animate',
   inputs:{entityId:'layer.body',requiredVerifiedClaims:['claim.identity']}}]}});
 assert.equal(report.claims[0].status,'corroborated');
 assert.equal(plan.status,'blocked');
 assert.equal(plan.unresolvedClaims[0].reason,'no deterministic verifier has established this claim');
});

test('planner surfaces semantic hypotheses on targeted entities instead of treating them as facts',()=>{
 const plan=Planner.compilePlan({scene,intent:{goal:'Animate the tail'},registry:[{id:'tool.animate',capabilities:['spine.animate']}],
  proposal:{operations:[{id:'animate.tail',capability:'spine.animate',inputs:{entityId:'layer.tail'}}]}});
 assert.equal(plan.status,'ready');
 assert.ok(plan.warnings.some(w=>w.includes('semantic labels remain hypotheses')));
});
test('planner blocks semantic-dependent operations when target identity is only a CV hypothesis',()=>{
 const plan=Planner.compilePlan({scene,intent:{goal:'Build a limb-specific rig'},registry:[{id:'tool.rig',capabilities:['spine.rig.build']}],
  proposal:{operations:[{id:'rig.limb',capability:'spine.rig.build',
   inputs:{entityId:'layer.tail',requiresSemanticConfirmation:true,rigPlan:{rig:{armIK:{enabled:false}}}}}]}});
 assert.equal(plan.status,'blocked');
 assert.equal(plan.unresolvedClaims[0].reason,'semantic identity is only a hypothesis');
});

test('review coordinator launches eight independent reviewer chats concurrently by default',async()=>{
 let started=0,active=0,peak=0,release;
 const gate=new Promise(resolve=>{release=resolve;});
 const reviewers=Array.from({length:8},(_,index)=>({
  id:'review.parallel.'+index,provider:'chatgpt.com',independenceGroup:'chat-session-'+index,model:'latest',reasoning:true,
  run:async()=>{started++;active++;peak=Math.max(peak,active);await gate;active--;
   return {claims:[{id:'claim.parallel.'+index,subjectId:'layer.body',predicate:'review-'+index,
    value:'ok',confidence:.8,evidenceRefs:['evidence.bounds']}]};}
 }));
 const pending=Review.reviewInParallel({scene,intent:{goal:'Review eight independent aspects'},reviewers});
 await Promise.resolve();
 assert.equal(started,8,'all eight reviewer adapters should start before any completes');
 assert.equal(peak,8,'reviewers should overlap rather than run sequentially');
 release();
 const report=await pending;
 assert.equal(report.claims.length,8);
 assert.equal(report.status,'complete');
});

test('planner exposes connectivity evidence and blocks operations requiring an unverified bone hierarchy',()=>{
 const topologyScene=IR.createSceneIR({...scene,metadata:{pixelTopology:{
  graphConnectivityAudit:{valid:true,connectedComponentCount:2,degreeIncidenceVerified:true},
  boneStructure:{status:'not-inferred',candidateCount:0,
   reason:'Pixel connectivity cannot establish anatomical hierarchy.'}
 }}});
 const plan=Planner.compilePlan({scene:topologyScene,intent:{goal:'Build a verified anatomical rig'},
  registry:[{id:'tool.rig',capabilities:['spine.rig.build']}],
  proposal:{operations:[{id:'rig.build',capability:'spine.rig.build',
   inputs:{requiresVerifiedBoneHierarchy:true,rigPlan:{rig:{armIK:{enabled:false}}}}}]}});
 assert.equal(plan.status,'blocked');
 assert.equal(plan.scene.pixelTopology.graphConnectivityAudit.connectedComponentCount,2);
 assert.equal(plan.scene.pixelTopology.boneStructure.status,'not-inferred');
 assert.equal(plan.unresolvedClaims[0].claimId,'scene:verified-bone-hierarchy');
 assert.ok(plan.warnings.some(w=>w.includes('no verified anatomical bone hierarchy')));
});

test('planner accepts only Scene IR bone candidates and still blocks unverified anatomical rigging',()=>{
 const boneScene=IR.createSceneIR({...scene,metadata:{pixelTopology:{
  graphConnectivityAudit:{valid:true,degreeIncidenceVerified:true,connectedComponentCount:1},
  boneStructure:{status:'candidates-only',candidateCount:1,candidates:[
   {id:'bone.candidate.0',status:'unoriented-candidate',semanticRole:null}
  ],hierarchy:{status:'not-established',edges:[]}}
 }}});
 const accepted=Planner.compilePlan({scene:boneScene,intent:{goal:'Inspect a measured skeleton segment'},
  registry:[{id:'tool.inspect',capabilities:['geometry.inspect']}],
  proposal:{operations:[{id:'inspect.segment',capability:'geometry.inspect',
   inputs:{boneCandidateIds:['bone.candidate.0']}}]}});
 assert.equal(accepted.status,'ready');
 assert.equal(accepted.scene.pixelTopology.boneStructure.candidateCount,1);
 assert.throws(()=>Planner.compilePlan({scene:boneScene,intent:{goal:'Inspect a missing segment'},
  registry:[{id:'tool.inspect',capabilities:['geometry.inspect']}],
  proposal:{operations:[{id:'inspect.missing',capability:'geometry.inspect',
   inputs:{boneCandidateIds:['bone.candidate.missing']}}]}}),/unavailable bone topology candidate/);
 const rig=Planner.compilePlan({scene:boneScene,intent:{goal:'Build a verified anatomical rig'},
  registry:[{id:'tool.rig',capabilities:['spine.rig.build']}],
  proposal:{operations:[{id:'rig.build',capability:'spine.rig.build',
   inputs:{requiresVerifiedBoneHierarchy:true,rigPlan:{rig:{armIK:{enabled:false}}}}}]}});
 assert.equal(rig.status,'blocked');
 assert.ok(rig.unresolvedClaims.some(claim=>claim.claimId==='scene:verified-bone-hierarchy'));
 const missingHierarchy=Planner.compilePlan({scene:boneScene,intent:{goal:'Build a source-backed rig'},
  registry:[{id:'tool.rig',capabilities:['spine.rig.build']}],
  proposal:{operations:[{id:'rig.build',capability:'spine.rig.build',
   inputs:{rigPlan:{rig:{armIK:{enabled:false}}}}}]}});
 assert.equal(missingHierarchy.status,'blocked');
 assert.ok(missingHierarchy.unresolvedClaims.some(claim=>claim.claimId==='scene:bone-hierarchy-proposal'));
});

test('planner validates a model-proposed hierarchy as a hypothesis, never as verified anatomy',()=>{
 const graphEntities=[
  {id:'pixel.graph.node.0',kind:'pixel-graph-node',geometry:{x:10,y:10,radius:2,degree:3,nodeKind:'junction'}},
  {id:'pixel.graph.node.1',kind:'pixel-graph-node',geometry:{x:2,y:10,radius:1,degree:1,nodeKind:'endpoint'}},
  {id:'pixel.graph.node.2',kind:'pixel-graph-node',geometry:{x:18,y:10,radius:1,degree:1,nodeKind:'endpoint'}},
  {id:'pixel.graph.node.3',kind:'pixel-graph-node',geometry:{x:10,y:18,radius:1,degree:1,nodeKind:'endpoint'}},
  {id:'pixel.graph.chain.0',kind:'pixel-graph-chain',geometry:{points:[{x:2,y:10,radius:1},{x:10,y:10,radius:2}],sourceLayerId:'layer.body',closed:false,classification:'junction-branch'}},
  {id:'pixel.graph.chain.1',kind:'pixel-graph-chain',geometry:{points:[{x:10,y:10,radius:2},{x:18,y:10,radius:1}],sourceLayerId:'layer.body',closed:false,classification:'junction-branch'}},
  {id:'pixel.graph.chain.2',kind:'pixel-graph-chain',geometry:{points:[{x:10,y:10,radius:2},{x:10,y:18,radius:1}],sourceLayerId:'layer.body',closed:false,classification:'junction-branch'}}
 ];
 const graphRelations=[
  {type:'connected-to',from:'pixel.graph.chain.0',to:'pixel.graph.node.1',metadata:{endpoint:'from'}},
  {type:'connected-to',from:'pixel.graph.chain.0',to:'pixel.graph.node.0',metadata:{endpoint:'to'}},
  {type:'connected-to',from:'pixel.graph.chain.1',to:'pixel.graph.node.0',metadata:{endpoint:'from'}},
  {type:'connected-to',from:'pixel.graph.chain.1',to:'pixel.graph.node.2',metadata:{endpoint:'to'}},
  {type:'connected-to',from:'pixel.graph.chain.2',to:'pixel.graph.node.0',metadata:{endpoint:'from'}},
  {type:'connected-to',from:'pixel.graph.chain.2',to:'pixel.graph.node.3',metadata:{endpoint:'to'}}
 ];
 const graphEvidence=[0,1,2].map(i=>({id:'pixel.graph.chain.evidence.'+i,kind:'skeleton-graph-chain',
  entityId:'pixel.graph.chain.'+i,confidence:1}));
 const graphScene=IR.createSceneIR({...scene,entities:[...scene.entities,...graphEntities],
  relations:graphRelations,evidence:[...scene.evidence,...graphEvidence],
  metadata:{pixelTopology:{graphConnectivityAudit:{valid:true,degreeIncidenceVerified:true,
   connectedComponentCount:1,nodeCount:4,chainCount:3},boneStructure:{status:'candidates-only'}}}});
 const rigPlan={rig:{armIK:{enabled:false},boneHierarchy:{bones:[
  {id:'bone.upper',candidateId:'bone.candidate.0',startNodeId:'pixel.graph.node.1',endNodeId:'pixel.graph.node.0',
   role:'upper-segment',sourceLayerIds:['layer.body'],evidenceRefs:['pixel.graph.chain.evidence.0']},
  {id:'bone.lower',candidateId:'bone.candidate.1',startNodeId:'pixel.graph.node.0',endNodeId:'pixel.graph.node.2',
   role:'lower-segment',evidenceRefs:['pixel.graph.chain.evidence.1']}
 ],parentChild:[{parentId:'bone.upper',childId:'bone.lower',
  evidenceRefs:['pixel.graph.chain.evidence.0','pixel.graph.chain.evidence.1']}]}}};
 const proposal={rigPlan,operations:[{id:'rig.build',capability:'spine.rig.build',inputs:{rigPlan}}]};
 const plan=Planner.compilePlan({scene:graphScene,intent:{goal:'Propose a two-segment hierarchy'},
  registry:[{id:'tool.rig',capabilities:['spine.rig.build']}],proposal});
 assert.equal(plan.status,'ready');
 assert.equal(plan.scene.pixelTopology.boneHierarchyProposal.status,'validated-hypothesis');
 assert.equal(plan.scene.pixelTopology.boneHierarchyProposal.hierarchyVerified,false);
 assert.equal(plan.scene.pixelTopology.boneHierarchyProposal.edges[0].status,'hypothesis');
 const invalidRigPlan=JSON.parse(JSON.stringify(rigPlan));
 invalidRigPlan.rig.boneHierarchy.bones[0].candidateId='bone.candidate.missing';
 const invalid=Planner.compilePlan({scene:graphScene,intent:{goal:'Propose a two-segment hierarchy'},
  registry:[{id:'tool.rig',capabilities:['spine.rig.build']}],
  proposal:{rigPlan:invalidRigPlan,operations:[{id:'rig.build',capability:'spine.rig.build',inputs:{rigPlan:invalidRigPlan}}]}});
 assert.equal(invalid.status,'blocked');
 assert.ok(invalid.unresolvedClaims.some(claim=>claim.claimId==='scene:bone-hierarchy-proposal'&&
  claim.reason.includes('unavailable topology candidate')));
 const unboundRigPlan=JSON.parse(JSON.stringify(rigPlan));
 delete unboundRigPlan.rig.boneHierarchy.bones[0].sourceLayerIds;
 const unbound=Planner.compilePlan({scene:graphScene,intent:{goal:'Propose a two-segment hierarchy'},
  registry:[{id:'tool.rig',capabilities:['spine.rig.build']}],
  proposal:{rigPlan:unboundRigPlan,operations:[{id:'rig.build',capability:'spine.rig.build',inputs:{rigPlan:unboundRigPlan}}]}});
 assert.equal(unbound.status,'blocked');
 assert.ok(unbound.unresolvedClaims.some(claim=>claim.claimId==='scene:rig-layer-binding'));
});
