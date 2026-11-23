'use strict';
(function(){

/*
 * Seven executable role contracts. Roles are logical capabilities coordinated
 * by one runtime; this manifest does not claim seven separate LLM processes.
 */
const ROLE_GRAPH=Object.freeze([
 {id:'sa.core',name:'SA Core',dependsOn:[],consumes:['user.intent','project.context'],produces:['job.context','decisions']},
 {id:'computer.vision',name:'Computer Vision',dependsOn:['sa.core'],consumes:['source.asset','job.context'],produces:['scene.ir','visual.evidence']},
 {id:'animation.planner',name:'Animation Planner',dependsOn:['sa.core','computer.vision','tool.registry'],consumes:['user.intent','scene.ir','tool.capabilities'],produces:['animation.plan','operation.dag']},
 {id:'tool.registry',name:'Tool Registry',dependsOn:['sa.core'],consumes:['tool.manifests'],produces:['tool.capabilities','tool.resolvers']},
 {id:'tool.orchestrator',name:'Tool Orchestrator',dependsOn:['sa.core','animation.planner','tool.registry'],consumes:['operation.dag','tool.resolvers'],produces:['execution.trace','operation.results']},
 {id:'spine.controller',name:'Spine Controller',dependsOn:['tool.orchestrator','tool.registry'],consumes:['spine.operations','native.runtime'],produces:['spine.project','native.evidence']},
 {id:'project.builder',name:'Project Builder',dependsOn:['tool.orchestrator','spine.controller'],consumes:['operation.results','spine.project','native.evidence'],produces:['deliverable','artifact.manifest']}
]);
function validateRoleGraph(graph=ROLE_GRAPH){
 if(!Array.isArray(graph)||graph.length!==7)throw new Error('SA Roles: exactly seven role contracts are required');
 const ids=new Set(graph.map(r=>r&&r.id));
 if(ids.size!==7)throw new Error('SA Roles: role IDs must be unique');
 for(const role of graph){
  if(!role||typeof role.id!=='string'||!Array.isArray(role.dependsOn)||!Array.isArray(role.consumes)||!Array.isArray(role.produces))
   throw new Error('SA Roles: malformed role contract');
  for(const dep of role.dependsOn)if(!ids.has(dep))throw new Error('SA Roles: unknown dependency '+dep);
 }
 const pending=new Set(graph.map(r=>r.id)),done=new Set(),order=[];
 while(pending.size){
  const ready=graph.filter(r=>pending.has(r.id)&&r.dependsOn.every(dep=>done.has(dep)));
  if(!ready.length)throw new Error('SA Roles: dependency cycle');
  for(const role of ready){pending.delete(role.id);done.add(role.id);order.push(role.id);}
 }
 return order;
}
function getRole(id){return ROLE_GRAPH.find(role=>role.id===id)||null;}
const api={ROLE_GRAPH,validateRoleGraph,getRole};
if(typeof module==='object'&&module.exports)module.exports=api;
else if(typeof globalThis!=='undefined')globalThis.SARoles=api;
})();
