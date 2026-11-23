'use strict';
(function(){

const SceneIR=typeof module==='object'&&module.exports?require('./scene-ir.js'):(typeof globalThis!=='undefined'?globalThis.SASceneIR:null);
const BoneStructure=typeof module==='object'&&module.exports?require('./bone-structure.js'):(typeof globalThis!=='undefined'?globalThis.SABoneStructure:null);
if(!SceneIR||typeof SceneIR.createSceneIR!=='function'||!BoneStructure)throw new Error('AnimationPlanner: required Scene IR or bone-structure runtime is unavailable');
const {createSceneIR}=SceneIR;
const ID=/^[a-z][a-z0-9._-]{1,79}$/;
const MAX_OPERATIONS=128;
function fail(m){throw new Error('AnimationPlanner: '+m);}
function obj(v){return v!==null&&typeof v==='object'&&!Array.isArray(v);}
function checked(v,label){if(typeof v!=='string'||!ID.test(v))fail('invalid '+label);return v;}
function topologicalOrder(operations){
  if(!Array.isArray(operations)||operations.length>MAX_OPERATIONS)fail('operation budget exceeded');
  const byId=new Map();
  for(const op of operations){checked(op.id,'operation ID');if(byId.has(op.id))fail('duplicate operation '+op.id);byId.set(op.id,op);}
  for(const op of operations){
    if(!Array.isArray(op.dependsOn))fail('dependsOn must be an array for '+op.id);
    for(const dep of op.dependsOn){if(!byId.has(dep))fail('unknown dependency '+dep);if(dep===op.id)fail('self dependency '+dep);}
  }
  const pending=new Map(operations.map(op=>[op.id,new Set(op.dependsOn)])),ordered=[];
  while(pending.size){
    const ready=operations.filter(op=>pending.has(op.id)&&pending.get(op.id).size===0);
    if(!ready.length)fail('dependency cycle');
    for(const op of ready){ordered.push(op);pending.delete(op.id);for(const deps of pending.values())deps.delete(op.id);}
  }
  return ordered;
}
function normalizeIntent(intent){
  if(!obj(intent))fail('intent is required');
  const goal=typeof intent.goal==='string'?intent.goal.trim():'';
  if(!goal||goal.length>20000)fail('intent.goal must contain 1..20000 characters');
  return {goal,language:typeof intent.language==='string'?intent.language.slice(0,16):'auto',
    target:typeof intent.target==='string'?intent.target.slice(0,120):'auto',
    constraints:obj(intent.constraints)?{...intent.constraints}:{},
    output:obj(intent.output)?{...intent.output}:{}};
}
function normalizeOperation(op,index){
  if(!obj(op))fail('operation '+index+' must be an object');
  const id=checked(op.id,'operation ID'),capability=checked(op.capability,'capability');
  const dependsOn=op.dependsOn===undefined?[]:op.dependsOn;
  if(!Array.isArray(dependsOn)||dependsOn.length>MAX_OPERATIONS)fail('invalid dependencies for '+id);
  const normalized={id,capability,dependsOn:[...new Set(dependsOn.map(x=>checked(x,'dependency')))]};
  if(op.optional!==undefined){if(typeof op.optional!=='boolean')fail('optional must be boolean');normalized.optional=op.optional;}
  if(op.reason!==undefined){if(typeof op.reason!=='string')fail('reason must be text');normalized.reason=op.reason.slice(0,500);}
  if(op.inputs!==undefined){if(!obj(op.inputs))fail('inputs must be an object');normalized.inputs={...op.inputs};}
  if(op.timeoutMs!==undefined){if(!Number.isInteger(op.timeoutMs)||op.timeoutMs<1||op.timeoutMs>3600000)fail('timeoutMs outside budget');normalized.timeoutMs=op.timeoutMs;}
  if(op.resources!==undefined){if(!obj(op.resources))fail('resources must be an object');normalized.resources={...op.resources};}
  return normalized;
}
/*
 * The LLM proposes a task-specific graph; this module validates and optimizes
 * the graph without imposing a fixed animation taxonomy or tool sequence.
 * Registry entries are metadata only here: execution remains in SA Orchestrator.
 */
function compilePlan({scene,intent,proposal,registry=[],policy={},review=null}={}){
  const ir=createSceneIR(scene);
  const normalizedIntent=normalizeIntent(intent);
  if(!obj(proposal)||!Array.isArray(proposal.operations))fail('planner proposal with operations is required');
  const maxOperations=Number.isInteger(policy.maxOperations)?Math.max(1,Math.min(MAX_OPERATIONS,policy.maxOperations)):MAX_OPERATIONS;
  if(proposal.operations.length>maxOperations)fail('proposal exceeds operation budget');
  const operations=proposal.operations.map(normalizeOperation);
  const ordered=topologicalOrder(operations);
  const entityIds=new Set(ir.entities.map(entity=>entity.id));
  const entityById=new Map(ir.entities.map(entity=>[entity.id,entity]));
  const sourceRefs=new Set(ir.entities.flatMap(entity=>entity.sourceRefs||[]));
  const evidenceIds=new Set(ir.evidence.map(item=>item.id));
  const unresolvedClaims=[],reviewWarnings=[],reviewClaims=new Map();
  const pixelTopology=ir.metadata&&ir.metadata.pixelTopology;
  const boneStructure=pixelTopology&&pixelTopology.boneStructure;
  const operationRigPlan=Array.isArray(proposal.operations)
    ?proposal.operations.map(operation=>operation&&operation.inputs&&operation.inputs.rigPlan).find(value=>obj(value)):null;
  const rigPlan=proposal.rigPlan||operationRigPlan||null;
  const proposedBoneHierarchy=proposal.boneHierarchy||rigPlan?.rig?.boneHierarchy||null;
  let boneHierarchyProposal=null,boneHierarchyError=null;
  if(proposedBoneHierarchy){
    try{boneHierarchyProposal=BoneStructure.validateHierarchy(ir,proposedBoneHierarchy);}
    catch(error){boneHierarchyError=String(error&&error.message||error).slice(0,500);}
  }
  if(boneHierarchyError){
    const rigOperation=proposal.operations.find(operation=>operation&&operation.capability==='spine.rig.build');
    unresolvedClaims.push({operationId:rigOperation?.id||null,claimId:'scene:bone-hierarchy-proposal',
      reason:'Model-proposed hierarchy failed structural validation: '+boneHierarchyError});
  }
  const boneCandidateIds=new Set((boneStructure&&Array.isArray(boneStructure.candidates)?boneStructure.candidates:[])
    .filter(candidate=>candidate.status==='unoriented-candidate').map(candidate=>candidate.id));
  if(review!==null){
    if(!obj(review)||review.schema!=='sa.analysis-review'||review.version!==1||!Array.isArray(review.claims))
      fail('review must be a normalized SA independent-analysis report');
    for(const claim of review.claims){
      if(!obj(claim)||typeof claim.id!=='string'||!['hypothesis','corroborated','disputed'].includes(claim.status))
        fail('review contains an invalid claim');
      if(reviewClaims.has(claim.id))fail('review contains duplicate claim IDs');
      reviewClaims.set(claim.id,claim);
    }
    if(Array.isArray(review.warnings))reviewWarnings.push(...review.warnings.filter(x=>typeof x==='string').slice(0,64));
  }
  for(const op of ordered){
    const inputs=op.inputs||{};
    for(const key of ['entityId','targetEntityId','layerId','parentId']){
      if(inputs[key]!==undefined&&(!entityIds.has(inputs[key])&&!sourceRefs.has(inputs[key])))
        fail('operation '+op.id+' references unknown source object '+key+': '+inputs[key]);
    }
    const targetIds=['entityId','targetEntityId','layerId'].flatMap(key=>inputs[key]===undefined?[]:[inputs[key]]);
    for(const targetId of targetIds){
      const entity=entityById.get(targetId)||ir.entities.find(item=>(item.sourceRefs||[]).includes(targetId));
      if(entity&&entity.hypotheses&&entity.hypotheses.length)
        reviewWarnings.push('Operation '+op.id+' targets '+entity.id+' whose semantic labels remain hypotheses, not verified object identities.');
      if(entity&&entity.kind==='unknown')
        reviewWarnings.push('Operation '+op.id+' targets '+entity.id+' with unknown source-layer kind.');
    }
    if(inputs.requiresSemanticConfirmation!==undefined&&typeof inputs.requiresSemanticConfirmation!=='boolean')
      fail('requiresSemanticConfirmation must be boolean');
    if(inputs.requiresVerifiedBoneHierarchy!==undefined&&typeof inputs.requiresVerifiedBoneHierarchy!=='boolean')
      fail('requiresVerifiedBoneHierarchy must be boolean');
    const activeRigPlan=obj(inputs.rigPlan)?inputs.rigPlan:rigPlan;
    if(op.capability==='spine.rig.build'&&(!obj(activeRigPlan)||!obj(activeRigPlan.rig))){
      unresolvedClaims.push({operationId:op.id,claimId:'scene:structured-rig-plan',
        reason:'A model-proposed structured rigPlan is required; automatic anatomical presets are not substituted.'});
    }
    if(op.capability==='spine.rig.build'&&Number(boneStructure&&boneStructure.candidateCount||0)>0&&
      !activeRigPlan?.rig?.boneHierarchy){
      unresolvedClaims.push({operationId:op.id,claimId:'scene:bone-hierarchy-proposal',
        reason:'Measured CV bone candidates exist, but the model did not provide a validated candidate-based hierarchy proposal.'});
    }
    if(op.capability==='spine.rig.build'&&activeRigPlan?.rig?.boneHierarchy&&
      (!Array.isArray(activeRigPlan.rig.boneHierarchy.bones)||
       !activeRigPlan.rig.boneHierarchy.bones.some(bone=>Array.isArray(bone.sourceLayerIds)&&bone.sourceLayerIds.length))){
      unresolvedClaims.push({operationId:op.id,claimId:'scene:rig-layer-binding',
        reason:'At least one measured source-layer binding is required to build a usable anatomical rig.'});
    }
    if(inputs.requiresVerifiedBoneHierarchy===true&&(!boneStructure||boneStructure.status!=='verified')){
      unresolvedClaims.push({operationId:op.id,claimId:'scene:verified-bone-hierarchy',
        reason:'Computer Vision has not established a verified anatomical parent-child bone hierarchy'});
    }
    if(/(?:^|[-_.])(bone|rig|rig-builder)(?:$|[-_.])/i.test(op.capability)&&boneStructure&&boneStructure.status!=='verified')
      reviewWarnings.push('Operation '+op.id+' is a rig/bone operation, but Scene IR contains no verified anatomical bone hierarchy.');
    if(inputs.requiresSemanticConfirmation===true){
      for(const targetId of targetIds){
        const entity=entityById.get(targetId)||ir.entities.find(item=>(item.sourceRefs||[]).includes(targetId));
        if(entity&&entity.hypotheses&&entity.hypotheses.length)
          unresolvedClaims.push({operationId:op.id,claimId:'entity:'+entity.id,reason:'semantic identity is only a hypothesis'});
      }
    }
    if(inputs.boneCandidateIds!==undefined&&(!Array.isArray(inputs.boneCandidateIds)||
      inputs.boneCandidateIds.some(id=>typeof id!=='string'||!boneCandidateIds.has(id))))
      fail('operation '+op.id+' references an unavailable bone topology candidate');
    for(const key of ['entityIds','layerIds']){
      if(inputs[key]!==undefined&&(!Array.isArray(inputs[key])||
        inputs[key].some(value=>!entityIds.has(value)&&!sourceRefs.has(value))))
        fail('operation '+op.id+' contains unknown source object references in '+key);
    }
    if(inputs.evidenceRefs!==undefined&&(!Array.isArray(inputs.evidenceRefs)||
      inputs.evidenceRefs.some(value=>!evidenceIds.has(value))))
      fail('operation '+op.id+' references missing Scene IR evidence');
    if(inputs.claimRefs!==undefined){
      if(!Array.isArray(inputs.claimRefs)||inputs.claimRefs.some(value=>typeof value!=='string'||!reviewClaims.has(value)))
        fail('operation '+op.id+' references missing independent-analysis claims');
      for(const claimId of inputs.claimRefs){
        const claim=reviewClaims.get(claimId);
        if(claim.status==='disputed')unresolvedClaims.push({operationId:op.id,claimId,reason:'conflicting independent analyses'});
        else if(claim.status==='hypothesis')reviewWarnings.push('Operation '+op.id+' depends on an uncorroborated semantic hypothesis '+claimId+'.');
      }
    }
    if(inputs.requiredVerifiedClaims!==undefined){
      if(!Array.isArray(inputs.requiredVerifiedClaims))fail('requiredVerifiedClaims must be an array');
      for(const claimId of inputs.requiredVerifiedClaims){
        if(typeof claimId!=='string'||!claimId.trim())fail('operation '+op.id+' has an invalid required verified claim');
        unresolvedClaims.push({operationId:op.id,claimId,reason:reviewClaims.has(claimId)?'no deterministic verifier has established this claim':'claim has not been independently reviewed'});
      }
    }
  }
  const tools=Array.isArray(registry)?registry:[];
  const available=new Set();
  for(const tool of tools){
    if(!obj(tool)||!Array.isArray(tool.capabilities))continue;
    for(const cap of tool.capabilities)if(typeof cap==='string')available.add(cap);
  }
  const missing=[],selected=[];
  for(const op of ordered){
    if(!available.has(op.capability)){
      if(op.optional===true)continue;
      missing.push(op.capability);selected.push(op);
    }else selected.push(op);
  }
  const selectedIds=new Set(selected.map(x=>x.id));
  for(const op of selected){
    const lost=op.dependsOn.filter(dep=>!selectedIds.has(dep));
    if(lost.length)fail('operation '+op.id+' depends on omitted operation '+lost.join(','));
  }
  const confidence=proposal.confidence===undefined?null:proposal.confidence;
  if(confidence!==null&&(typeof confidence!=='number'||!Number.isFinite(confidence)||confidence<0||confidence>1))
    fail('proposal confidence must be 0..1');
  const warnings=Array.isArray(proposal.warnings)?proposal.warnings.filter(x=>typeof x==='string').slice(0,64).map(x=>x.slice(0,500)):[];
  warnings.push(...reviewWarnings.slice(0,64));
  if(unresolvedClaims.length)warnings.push('Plan blocked: one or more required semantic claims are disputed or lack deterministic verification.');
  if(confidence!==null&&confidence<(policy.minimumConfidence===undefined?0.35:policy.minimumConfidence))
    warnings.push('Planner confidence is below the configured threshold.');
  return {
    schema:'sa.animation-plan',version:1,status:missing.length||unresolvedClaims.length?'blocked':'ready',
    scene:{schema:ir.schema,version:ir.version,source:ir.source,entityCount:ir.entities.length,relationCount:ir.relations.length,
      pixelTopology:pixelTopology?{graphConnectivityAudit:pixelTopology.graphConnectivityAudit||null,
        boneStructure:boneStructure?{
          status:boneStructure.status||'unknown',
          candidateCount:Number(boneStructure.candidateCount||0),
          candidateIds:Array.isArray(boneStructure.candidates)?boneStructure.candidates
            .filter(candidate=>candidate.status==='unoriented-candidate').slice(0,5000).map(candidate=>candidate.id):[],
          candidateIdsTruncated:Array.isArray(boneStructure.candidates)&&
            boneStructure.candidates.filter(candidate=>candidate.status==='unoriented-candidate').length>5000,
          junctionCount:Array.isArray(boneStructure.junctions)?boneStructure.junctions.length:0,
          hierarchy:boneStructure.hierarchy||{status:'not-established',edges:[]},
          limitations:Array.isArray(boneStructure.limitations)?boneStructure.limitations.slice(0,16):[]
        }:{status:'unknown',candidateCount:0,candidateIds:[],hierarchy:{status:'not-established',edges:[]}},
        boneHierarchyProposal}:null},
    intent:normalizedIntent,confidence,operations:selected,operationOrder:selected.map(x=>x.id),
    missingCapabilities:[...new Set(missing)],unresolvedClaims,warnings,
    review:review?{status:review.status,claimCount:review.claims.length,
      corroboratedClaimIds:[...(review.corroboratedClaimIds||[])],
      disputedClaimIds:[...(review.disputedClaimIds||[])],verifiedClaimIds:[]}:null,
    rationale:typeof proposal.rationale==='string'?proposal.rationale.slice(0,2000):'',
    estimates:obj(proposal.estimates)?{...proposal.estimates}:{},
    policy:{maxOperations,minimumConfidence:policy.minimumConfidence===undefined?0.35:policy.minimumConfidence}
  };
}
const api={compilePlan,topologicalOrder,normalizeIntent};
if(typeof module==='object'&&module.exports)module.exports=api;
else if(typeof globalThis!=='undefined')globalThis.SAAnimationPlanner=api;
})();
