'use strict';
(function(){
function fail(message){throw new Error('SA ReviewQuestionGenerator: '+message);}
function safeId(value,index){
 const slug=String(value||'item').toLowerCase().replace(/[^a-z0-9._-]+/g,'-').replace(/^[^a-z]+/,'').slice(0,48);
 return (slug||'item')+'-'+index;
}
function boundedLimit(value){if(value===undefined)return 8;if(!Number.isInteger(value)||value<1||value>8)fail('maxQuestions must be 1..8');return value;}
function generateComputerVisionQuestions({scene,maxQuestions=8}={}){
 const limit=boundedLimit(maxQuestions);
 if(!scene||!Array.isArray(scene.entities)||!Array.isArray(scene.evidence))fail('a normalized Scene IR is required');
 const questions=[],seen=new Set();
 const add=(key,question)=>{if(questions.length>=limit||seen.has(key))return;seen.add(key);questions.push({id:safeId(key,questions.length+1),question});};
 const evidenceByEntity=new Map();
 for(const evidence of scene.evidence){if(evidence.entityId){if(!evidenceByEntity.has(evidence.entityId))evidenceByEntity.set(evidence.entityId,[]);evidenceByEntity.get(evidence.entityId).push(evidence);}}
 for(const entity of scene.entities){
  const evidence=evidenceByEntity.get(entity.id)||[];
  if(entity.kind==='unknown')add('kind-'+entity.id,'Can the supplied source links and evidence identify the visual/structural kind of entity '+entity.id+'? If not, state unknown and specify the missing evidence.');
  if(!entity.bounds)add('bounds-'+entity.id,'Can the source assets establish reliable bounds for entity '+entity.id+'? Return measured bounds only when directly supported; otherwise state unknown.');
  for(const hypothesis of entity.hypotheses||[]){
   add('hypothesis-'+entity.id+'-'+hypothesis.label,'Evaluate the semantic hypothesis "'+hypothesis.label+'" for entity '+entity.id+'. Is there direct visual evidence in the linked assets? Distinguish observation from interpretation.');
   if(questions.length>=limit)break;
  }
  if(!evidence.length)add('evidence-'+entity.id,'What direct pixel/topology/source evidence is available for entity '+entity.id+' in the linked assets? Identify evidence gaps without inferring hidden geometry.');
  if(questions.length>=limit)break;
 }
 if(!questions.length){
  const ids=scene.entities.slice(0,12).map(e=>e.id).join(', ');
  add('cross-check',scene.entities.length
   ?'Inspect the linked source assets for independently verifiable geometry, layer relationships and pixel topology for these Scene IR entities: '+ids+'. Report only concrete observations and evidence references.'
   :'Inspect the linked source assets for independently verifiable visual entities, layer structure and pixel topology. If no source asset link or direct evidence is available, report the exact missing input and do not infer objects.');
 }
 return questions;
}
function generateAnimationPlannerQuestions({scene,intent={},proposal,review,maxQuestions=8}={}){
 const limit=boundedLimit(maxQuestions);
 if(!scene||!Array.isArray(scene.entities))fail('a normalized Scene IR is required');
 const questions=[],seen=new Set();
 const add=(key,question)=>{if(questions.length>=limit||seen.has(key))return;seen.add(key);questions.push({id:safeId(key,questions.length+1),question});};
 const unresolved=Array.isArray(proposal&&proposal.unresolvedClaims)?proposal.unresolvedClaims:[];
 const disputed=Array.isArray(review&&review.disputedClaimIds)?review.disputedClaimIds:[];
 for(const claim of unresolved){
  const claimId=typeof claim==='string'?claim:claim.claimId||claim.id;
  if(claimId)add('claim-'+claimId,'Does the animation plan depend on claim '+claimId+' that is disputed or lacks deterministic verification? Identify the exact dependent operations and propose a safe alternative that does not assume the claim.');
 }
 for(const id of disputed)add('disputed-'+id,'How should the animation DAG avoid relying on disputed claim '+id+'? Suggest a deterministic fallback or a clearly blocked dependency.');
 const operations=Array.isArray(proposal&&proposal.operations)?proposal.operations:[];
 for(const op of operations){
  const inputs=op&&op.inputs||{};
  const refs=[...(Array.isArray(inputs.claimRefs)?inputs.claimRefs:[]),...(Array.isArray(inputs.requiredVerifiedClaims)?inputs.requiredVerifiedClaims:[])];
  if(refs.length)add('op-'+(op.id||'operation'),'Review operation '+(op.id||'unnamed')+' and its semantic dependencies '+refs.join(', ')+'. Can it be implemented using verified geometry only, or must it be blocked?');
 }
 if(operations.length>1){
  const summary=operations.slice(0,24).map(op=>(op.id||'?')+':'+(op.capability||'?')+' <- '+((op.dependsOn||[]).join(',')||'none')).join('; ');
  add('dag-alternatives','Review this proposed animation dependency graph for unnecessary serialization, missing prerequisites, unsafe semantic assumptions and opportunities for parallel execution. Propose a safer minimal DAG: '+summary);
 }
 if(!questions.length){
  const goal=typeof intent.goal==='string'?intent.goal:'the requested animation';
  add('plan-risk','For the goal "'+goal+'", identify the highest-impact planning uncertainties and a minimal executable DAG using only capabilities and source facts already verified in the supplied Scene IR. Do not invent rig structure or tools.');
 }
 return questions;
}
const api={generateComputerVisionQuestions,generateAnimationPlannerQuestions};
if(typeof module==='object'&&module.exports)module.exports=api;
else if(typeof globalThis!=='undefined')globalThis.SAReviewQuestionGenerator=api;
})();