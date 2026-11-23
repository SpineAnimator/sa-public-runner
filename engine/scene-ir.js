'use strict';
(function(){

/*
 * Compact, format-neutral Scene IR shared by Computer Vision, Animation Planner
 * and the seven SA roles. It stores observations separately from hypotheses.
 */
const VERSION = 1;
const MAX_ENTITIES = 20000;
const MAX_RELATIONS = 100000;
const MAX_EVIDENCE = 50000;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const FORMATS = new Set(['psd','image','spine-json','spine-binary','scene-json','video','unknown']);
const RELATIONS = new Set([
  'parent','contains','overlaps','occludes','attached-to','connected-to',
  'hinge-at','pivot-at','follows','constrains','same-object','temporal'
]);
function fail(message){throw new Error('SceneIR: '+message);}
function isObject(v){return v!==null&&typeof v==='object'&&!Array.isArray(v);}
function id(v,label){if(typeof v!=='string'||!ID.test(v))fail('invalid '+label);return v;}
function confidence(v,label){if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>1)fail(label+' confidence must be 0..1');return v;}
function bounds(v,label){
  if(!isObject(v))fail(label+' bounds are required');
  const out={x:v.x,y:v.y,width:v.width,height:v.height};
  if(Object.values(out).some(n=>typeof n!=='number'||!Number.isFinite(n))||out.width<0||out.height<0)fail(label+' bounds are invalid');
  return out;
}
function normalizeEntity(e,index){
  if(!isObject(e))fail('entity '+index+' must be an object');
  const out={id:id(e.id,'entity ID'),kind:typeof e.kind==='string'&&e.kind.trim()?e.kind.slice(0,120):'unknown'};
  if(e.name!==undefined){
    if(typeof e.name!=='string'||!e.name.trim()||e.name.length>512)fail('entity name must be a bounded non-empty string');
    out.name=e.name;
  }
  if(e.parentId!==undefined&&e.parentId!==null)out.parentId=id(e.parentId,'parent ID');
  if(e.bounds!==undefined)out.bounds=bounds(e.bounds,'entity');
  if(e.transform!==undefined){
    if(!isObject(e.transform))fail('entity transform must be an object');
    const transform={};
    for(const key of ['x','y','rotation','scaleX','scaleY','shearX','shearY']){
      if(e.transform[key]!==undefined){const n=e.transform[key];if(typeof n!=='number'||!Number.isFinite(n))fail('invalid transform '+key);transform[key]=n;}
    }
    out.transform=transform;
  }
  if(e.drawOrder!==undefined){if(!Number.isInteger(e.drawOrder)||e.drawOrder<0)fail('drawOrder must be a non-negative integer');out.drawOrder=e.drawOrder;}
  if(e.visible!==undefined){if(typeof e.visible!=='boolean')fail('visible must be boolean');out.visible=e.visible;}
  if(e.sourceRefs!==undefined){if(!Array.isArray(e.sourceRefs)||e.sourceRefs.length>256)fail('sourceRefs must be a bounded array');out.sourceRefs=e.sourceRefs.map((x)=>id(x,'source reference'));}
  if(e.hypotheses!==undefined){
    if(!Array.isArray(e.hypotheses)||e.hypotheses.length>64)fail('hypotheses must be a bounded array');
    out.hypotheses=e.hypotheses.map(h=>{
      if(!isObject(h)||typeof h.label!=='string'||!h.label.trim())fail('invalid semantic hypothesis');
      return {label:h.label.slice(0,120),confidence:confidence(h.confidence,'hypothesis'),provider:typeof h.provider==='string'?h.provider.slice(0,120):'unknown'};
    });
  }
  if(e.geometry!==undefined){
    if(!isObject(e.geometry))fail('geometry must be an object');
    out.geometry={...e.geometry};
  }
  return out;
}
function normalizeRelation(r,index,entityIds){
  if(!isObject(r))fail('relation '+index+' must be an object');
  const type=id(r.type,'relation type');
  if(!RELATIONS.has(type))fail('unsupported relation '+type);
  const from=id(r.from,'relation from'),to=id(r.to,'relation to');
  if(!entityIds.has(from)||!entityIds.has(to))fail('relation references an unknown entity');
  if(from===to&&type!=='same-object')fail('self relation is not allowed');
  const out={type,from,to};
  if(r.confidence!==undefined)out.confidence=confidence(r.confidence,'relation');
  if(r.evidence!==undefined){if(!Array.isArray(r.evidence)||r.evidence.length>64)fail('relation evidence must be bounded');out.evidence=r.evidence.map(x=>id(x,'evidence ID'));}
  if(r.metadata!==undefined){if(!isObject(r.metadata))fail('relation metadata must be an object');out.metadata={...r.metadata};}
  return out;
}
function createSceneIR(input){
  if(!isObject(input))fail('input must be an object');
  const source=input.source;
  if(!isObject(source))fail('source metadata is required');
  const format=source.format||'unknown';
  if(!FORMATS.has(format))fail('unsupported source format');
  const normalizedSource={format};
  if(source.id!==undefined)normalizedSource.id=id(source.id,'source ID');
  if(source.sha256!==undefined){if(typeof source.sha256!=='string'||!/^[a-f0-9]{64}$/i.test(source.sha256))fail('source SHA-256 is invalid');normalizedSource.sha256=source.sha256.toLowerCase();}
  for(const key of ['width','height','duration','frameRate']){
    if(source[key]!==undefined){const n=source[key];if(typeof n!=='number'||!Number.isFinite(n)||n<=0)fail('source '+key+' must be positive');normalizedSource[key]=n;}
  }
  const rawEntities=input.entities||[];
  const rawRelations=input.relations||[];
  const rawEvidence=input.evidence||[];
  if(!Array.isArray(rawEntities)||rawEntities.length>MAX_ENTITIES)fail('entity budget exceeded');
  if(!Array.isArray(rawRelations)||rawRelations.length>MAX_RELATIONS)fail('relation budget exceeded');
  if(!Array.isArray(rawEvidence)||rawEvidence.length>MAX_EVIDENCE)fail('evidence budget exceeded');
  const entities=rawEntities.map(normalizeEntity);
  const entityIds=new Set(entities.map(e=>e.id));
  if(entityIds.size!==entities.length)fail('duplicate entity IDs');
  for(const e of entities)if(e.parentId&&!entityIds.has(e.parentId))fail('entity parent does not exist');
  const relations=rawRelations.map((r,i)=>normalizeRelation(r,i,entityIds));
  const evidence=rawEvidence.map((e,i)=>{
    if(!isObject(e))fail('evidence '+i+' must be an object');
    const item={id:id(e.id,'evidence ID'),kind:typeof e.kind==='string'?e.kind.slice(0,80):'observation'};
    if(e.entityId!==undefined){item.entityId=id(e.entityId,'evidence entity');if(!entityIds.has(item.entityId))fail('evidence references unknown entity');}
    if(e.confidence!==undefined)item.confidence=confidence(e.confidence,'evidence');
    if(e.sourceRef!==undefined)item.sourceRef=id(e.sourceRef,'evidence source ref');
    if(e.note!==undefined){if(typeof e.note!=='string')fail('evidence note must be text');item.note=e.note.slice(0,1000);}
    return item;
  });
  const evidenceIds=new Set(evidence.map(e=>e.id));
  if(evidenceIds.size!==evidence.length)fail('duplicate evidence IDs');
  for(const r of relations)if(r.evidence)for(const ref of r.evidence)if(!evidenceIds.has(ref))fail('relation references unknown evidence');
  return Object.freeze({
    schema:'sa.scene-ir',version:VERSION,source:normalizedSource,
    entities,relations,evidence,
    metadata:isObject(input.metadata)?{...input.metadata}:{}
  });
}
function summarizeScene(scene){
  const ir=createSceneIR(scene);
  const kinds=Object.create(null);
  for(const e of ir.entities)kinds[e.kind]=(kinds[e.kind]||0)+1;
  return {version:ir.version,format:ir.source.format,entityCount:ir.entities.length,
    relationCount:ir.relations.length,evidenceCount:ir.evidence.length,kinds};
}
const api={VERSION,createSceneIR,summarizeScene,RELATIONS};
if(typeof module==='object'&&module.exports)module.exports=api;
else if(typeof globalThis!=='undefined')globalThis.SASceneIR=api;
})();
