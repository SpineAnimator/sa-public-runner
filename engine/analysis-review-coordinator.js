'use strict';
(function(){
const SceneIR=typeof module==='object'&&module.exports?require('./scene-ir.js'):(typeof globalThis!=='undefined'?globalThis.SASceneIR:null);
const QuestionGenerator=typeof module==='object'&&module.exports?require('./review-question-generator.js'):(typeof globalThis!=='undefined'?globalThis.SAReviewQuestionGenerator:null);
if(!SceneIR||typeof SceneIR.createSceneIR!=='function'||!QuestionGenerator)throw new Error('AnalysisReviewCoordinator: Scene IR or review-question generator is unavailable');
function fail(message){throw new Error('AnalysisReviewCoordinator: '+message);}
function object(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function stable(value){
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
 return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}';
}
function runParallelReviews({scene,intent,reviewers,context={},maxReviewers=8,minimumIndependentGroups=2}={}){
 const ir=SceneIR.createSceneIR(scene);
 if(!Number.isInteger(maxReviewers)||maxReviewers<1||maxReviewers>8)
  fail('maxReviewers must be an integer from 1 to 8');
 if(!Array.isArray(reviewers)||reviewers.length<1||reviewers.length>maxReviewers)
  fail('reviewers must contain 1..'+maxReviewers+' independent reviewers');
 if(!Number.isInteger(minimumIndependentGroups)||minimumIndependentGroups<2||minimumIndependentGroups>8)
  fail('minimumIndependentGroups must be 2..8');
 const ids=new Set(),chatGroups=new Set();
 const selected=reviewers.map(reviewer=>{
  if(!object(reviewer)||typeof reviewer.id!=='string'||!reviewer.id.trim()||
    typeof reviewer.provider!=='string'||!reviewer.provider.trim()||
    typeof reviewer.independenceGroup!=='string'||!reviewer.independenceGroup.trim()||
    typeof reviewer.run!=='function')fail('each reviewer needs id, provider, independenceGroup and run()');
  if(ids.has(reviewer.id))fail('reviewer IDs must be unique');
  ids.add(reviewer.id);
  if(reviewer.provider.startsWith('chatgpt.com')){
   if(reviewer.model!=='latest'||reviewer.reasoning!==true)
    fail('ChatGPT.com reviewers must explicitly require Latest with reasoning enabled');
   if(chatGroups.has(reviewer.independenceGroup))fail('ChatGPT.com reviewers must use distinct independent chat groups');
   chatGroups.add(reviewer.independenceGroup);
  }
  return reviewer;
 });
 return Promise.allSettled(selected.map(async reviewer=>{
  const result=await reviewer.run({scene:ir,intent,context});
  if(!object(result)||!Array.isArray(result.claims)||result.claims.length>256)
   fail('reviewer '+reviewer.id+' returned malformed claims');
  const claims=result.claims.map((claim,index)=>{
   if(!object(claim)||typeof claim.id!=='string'||!claim.id.trim()||
    typeof claim.subjectId!=='string'||!claim.subjectId.trim()||
    typeof claim.predicate!=='string'||!claim.predicate.trim()||
    !Object.prototype.hasOwnProperty.call(claim,'value')||
    typeof claim.confidence!=='number'||!Number.isFinite(claim.confidence)||claim.confidence<0||claim.confidence>1||
    !Array.isArray(claim.evidenceRefs))fail('reviewer '+reviewer.id+' returned an invalid claim at '+index);
   const evidenceRefs=[...new Set(claim.evidenceRefs)];
   const evidenceIds=new Set(ir.evidence.map(item=>item.id));
   if(evidenceRefs.some(ref=>typeof ref!=='string'||!evidenceIds.has(ref)))
    fail('reviewer '+reviewer.id+' referenced evidence absent from Scene IR');
   if(!ir.entities.some(entity=>entity.id===claim.subjectId|| (entity.sourceRefs||[]).includes(claim.subjectId)))
    fail('reviewer '+reviewer.id+' referenced an unknown source object');
   return {id:claim.id,subjectId:claim.subjectId,predicate:claim.predicate,value:claim.value,
    confidence:claim.confidence,evidenceRefs};
  });
  let session = null;
  if (result.session !== undefined) {
   if (!object(result.session) || typeof result.session.conversationId !== 'string' ||
       !result.session.conversationId.trim()) fail('reviewer '+reviewer.id+' returned invalid session provenance');
   session = {
    conversationId: result.session.conversationId,
    mode: typeof result.session.mode === 'string' ? result.session.mode : 'unknown',
    model: typeof result.session.model === 'string' ? result.session.model : 'unknown',
    reasoning: result.session.reasoning === true
   };
  }
  return {reviewerId:reviewer.id,provider:reviewer.provider,independenceGroup:reviewer.independenceGroup,session,claims};
 }));
}
function reconcileReviews({scene,reports,minimumIndependentGroups=2}={}){
 const ir=SceneIR.createSceneIR(scene);
 if(!Array.isArray(reports))fail('review reports are required');
 const entityIds=new Set(ir.entities.flatMap(entity=>[entity.id,...(entity.sourceRefs||[])]));
 const evidenceIds=new Set(ir.evidence.map(item=>item.id));
 const byKey=new Map(),failed=[],reviewerSessions=[],sessionIds=new Set();
 for(const report of reports){
  if(report.status==='rejected'){failed.push({reviewerId:report.reviewerId||'unknown',reason:String(report.reason||'review failed').slice(0,300)});continue;}
  if(!object(report)||typeof report.reviewerId!=='string'||typeof report.provider!=='string'||
   typeof report.independenceGroup!=='string'||!Array.isArray(report.claims))fail('invalid reviewer report');
  if (object(report.session)) {
   if (report.session.mode === 'chatgpt.com') {
    if (report.session.model !== 'latest' || report.session.reasoning !== true)
     fail('ChatGPT.com session provenance must confirm Latest and reasoning enabled');
    if (sessionIds.has(report.session.conversationId)) fail('ChatGPT.com review sessions must be distinct');
    sessionIds.add(report.session.conversationId);
   }
   reviewerSessions.push({reviewerId:report.reviewerId,...report.session});
  }
  for(const claim of report.claims){
   if(!object(claim)||typeof claim.id!=='string'||typeof claim.subjectId!=='string'||
    typeof claim.predicate!=='string'||!Object.prototype.hasOwnProperty.call(claim,'value')||
    typeof claim.confidence!=='number'||claim.confidence<0||claim.confidence>1||
    !Array.isArray(claim.evidenceRefs))fail('invalid normalized claim');
   if(!entityIds.has(claim.subjectId))fail('claim references unknown source object');
   if(claim.evidenceRefs.some(ref=>!evidenceIds.has(ref)))fail('claim references unknown Scene IR evidence');
   const key=claim.subjectId+'\u0000'+claim.predicate;
   if(!byKey.has(key))byKey.set(key,[]);
   byKey.get(key).push({...claim,reviewerId:report.reviewerId,provider:report.provider,independenceGroup:report.independenceGroup});
  }
 }
 const claims=[],disputedClaimIds=[],corroboratedClaimIds=[];
 for(const items of byKey.values()){
  const values=new Map();
  for(const item of items){const key=stable(item.value);if(!values.has(key))values.set(key,[]);values.get(key).push(item);}
  const isDisputed=values.size>1;
  const groups=new Set(items.map(item=>item.independenceGroup));
  const status=isDisputed?'disputed':groups.size>=minimumIndependentGroups?'corroborated':'hypothesis';
  const id=items[0].id;
  if(isDisputed)disputedClaimIds.push(id);
  if(status==='corroborated')corroboratedClaimIds.push(id);
  claims.push({id,subjectId:items[0].subjectId,predicate:items[0].predicate,
   values:[...values.entries()].map(([valueKey,entries])=>({value:entries[0].value,
    reviewers:entries.map(item=>item.reviewerId),independenceGroups:[...new Set(entries.map(item=>item.independenceGroup))],
    evidenceRefs:[...new Set(entries.flatMap(item=>item.evidenceRefs))]})),
   status,reviewerCount:new Set(items.map(item=>item.reviewerId)).size,independenceGroupCount:groups.size,
   maxConfidence:Math.max(...items.map(item=>item.confidence))});
 }
 return {schema:'sa.analysis-review',version:1,status:failed.length?'partial':'complete',
  claims,corroboratedClaimIds,disputedClaimIds,verifiedClaimIds:[],reviewerSessions,
  failedReviews:failed,warnings:[
   'Independent model agreement is corroboration, not proof or deterministic verification.',
   'Model-generated semantic claims remain hypotheses until checked against source-backed evidence by a deterministic validator.',
   ...disputedClaimIds.map(id=>'Conflicting independent analyses for claim '+id+'.')
  ]};
}
async function reviewInParallel(options){
 const settled=await runParallelReviews(options);
 const reports=settled.map((result,index)=>result.status==='fulfilled'?result.value:{
  status:'rejected',reviewerId:options.reviewers[index].id,reason:String(result.reason&&result.reason.message||result.reason||'review failed')});
 return reconcileReviews({scene:options.scene,reports,minimumIndependentGroups:options.minimumIndependentGroups||2});
}

async function reviewCVAndPlannerInParallel({
 scene,intent,proposal,review,driver,computerVisionQuestions,animationPlannerQuestions,
 context={},maxQuestionsPerSubsystem=8,minimumIndependentGroups=2
}={}){
 if(!Number.isInteger(maxQuestionsPerSubsystem)||maxQuestionsPerSubsystem<1||maxQuestionsPerSubsystem>8)
  fail('maxQuestionsPerSubsystem must be an integer from 1 to 8');
 const ir=SceneIR.createSceneIR(scene);
 computerVisionQuestions=computerVisionQuestions||QuestionGenerator.generateComputerVisionQuestions({scene:ir,maxQuestions:maxQuestionsPerSubsystem});
 animationPlannerQuestions=animationPlannerQuestions||QuestionGenerator.generateAnimationPlannerQuestions({scene:ir,intent,proposal,review,maxQuestions:maxQuestionsPerSubsystem});
 if(!Array.isArray(computerVisionQuestions)||computerVisionQuestions.length<1||computerVisionQuestions.length>maxQuestionsPerSubsystem)
  fail('Computer Vision must supply 1..'+maxQuestionsPerSubsystem+' independent questions');
 if(!Array.isArray(animationPlannerQuestions)||animationPlannerQuestions.length<1||animationPlannerQuestions.length>maxQuestionsPerSubsystem)
  fail('Animation Planner must supply 1..'+maxQuestionsPerSubsystem+' independent questions');
 const Adapter=typeof module==='object'&&module.exports
  ?require('./chatgpt-review-adapter.js')
  :(typeof globalThis!=='undefined'?globalThis.SAChatGPTReviewAdapter:null);
 if(!Adapter||typeof Adapter.createChatGPTReviewers!=='function')
  fail('ChatGPT Latest reasoning adapter is unavailable');
 const cvReviewers=Adapter.createChatGPTReviewers({
  driver,questions:computerVisionQuestions.map(item=>({...item,id:'cv.'+item.id})),
  maxReviewers:maxQuestionsPerSubsystem
 });
 const plannerReviewers=Adapter.createChatGPTReviewers({
  driver,questions:animationPlannerQuestions.map(item=>({...item,id:'planner.'+item.id})),
  maxReviewers:maxQuestionsPerSubsystem
 });
 const [computerVision,animationPlanner]=await Promise.all([
  reviewInParallel({scene:ir,intent:{...intent,subsystem:'computer-vision'},reviewers:cvReviewers,
   context:{...context,reviewSubsystem:'computer-vision'},maxReviewers:maxQuestionsPerSubsystem,minimumIndependentGroups}),
  reviewInParallel({scene:ir,intent:{...intent,subsystem:'animation-planner'},reviewers:plannerReviewers,
   context:{...context,reviewSubsystem:'animation-planner'},maxReviewers:maxQuestionsPerSubsystem,minimumIndependentGroups})
 ]);
 const allSessions=[...(computerVision.reviewerSessions||[]),...(animationPlanner.reviewerSessions||[])];
 const conversationIds=allSessions.map(item=>item.conversationId);
 if(new Set(conversationIds).size!==conversationIds.length)fail('CV and Planner must use globally distinct ChatGPT conversations');
 const combinedClaims=[
  ...computerVision.claims.map(claim=>({...claim,id:'cv.'+claim.id,subsystem:'computer-vision'})),
  ...animationPlanner.claims.map(claim=>({...claim,id:'planner.'+claim.id,subsystem:'animation-planner'}))
 ];
 const combinedReview={
  schema:'sa.analysis-review',version:1,
  status:computerVision.status==='partial'||animationPlanner.status==='partial'?'partial':'complete',
  claims:combinedClaims,
  corroboratedClaimIds:[
   ...computerVision.corroboratedClaimIds.map(id=>'cv.'+id),
   ...animationPlanner.corroboratedClaimIds.map(id=>'planner.'+id)
  ],
  disputedClaimIds:[
   ...computerVision.disputedClaimIds.map(id=>'cv.'+id),
   ...animationPlanner.disputedClaimIds.map(id=>'planner.'+id)
  ],
  verifiedClaimIds:[],
  reviewerSessions:allSessions,
  failedReviews:[...computerVision.failedReviews,...animationPlanner.failedReviews],
  warnings:[...computerVision.warnings,...animationPlanner.warnings]
 };
 return {schema:'sa.dual-subsystem-review',version:1,combinedReview,
  questions:{computerVision:computerVisionQuestions,animationPlanner:animationPlannerQuestions},
  limits:{computerVision:maxQuestionsPerSubsystem,animationPlanner:maxQuestionsPerSubsystem,total:2*maxQuestionsPerSubsystem},
  computerVision,animationPlanner};
}
const api={runParallelReviews,reconcileReviews,reviewInParallel,reviewCVAndPlannerInParallel};
if(typeof module==='object'&&module.exports)module.exports=api;
else if(typeof globalThis!=='undefined')globalThis.SAAnalysisReview=api;
})();
