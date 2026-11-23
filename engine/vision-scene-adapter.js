'use strict';
(function(){
const browser=typeof module!=='object'||!module.exports;
const SceneIR=browser?(typeof globalThis!=='undefined'?globalThis.SASceneIR:null):require('./scene-ir.js');
const Vision=browser?(typeof globalThis!=='undefined'?globalThis.SpineVision:null):require('./vision.js');
const BoneStructure=browser?(typeof globalThis!=='undefined'?globalThis.SABoneStructure:null):require('./bone-structure.js');
if(!SceneIR||!Vision||!BoneStructure)throw new Error('VisionSceneAdapter: required runtime modules are unavailable');

function fail(m){throw new Error('VisionSceneAdapter: '+m);}
function auditSkeletonGraph(nodes,chains){
  if(!Array.isArray(nodes)||!Array.isArray(chains)||nodes.length>20000||chains.length>50000)
    fail('invalid skeleton graph collection');
  const byId=new Map(),incidence=new Map(),parent=new Map();
  for(let i=0;i<nodes.length;i++){
    const node=nodes[i];
    if(!node||typeof node.id!=='string'||!node.id.trim()||byId.has(node.id))
      fail('skeleton graph node IDs must be unique');
    if(!Number.isInteger(node.degree)||node.degree<0||node.degree>8)
      fail('invalid skeleton graph node degree');
    const expectedKind=node.degree===0?'isolated':node.degree===1?'endpoint':node.degree===2?'cycle-anchor':'junction';
    if(node.kind!==expectedKind)fail('skeleton graph node kind does not match its degree');
    byId.set(node.id,i);incidence.set(node.id,0);parent.set(node.id,node.id);
  }
  const root=id=>{let p=parent.get(id);while(p!==parent.get(p))p=parent.get(p);let q=id;while(parent.get(q)!==p){const n=parent.get(q);parent.set(q,p);q=n;}return p;};
  const join=(a,b)=>{const ra=root(a),rb=root(b);if(ra!==rb)parent.set(ra,rb);};
  let closedCycles=0,totalChainPoints=0;
  for(let i=0;i<chains.length;i++){
    const chain=chains[i];
    if(!chain||typeof chain.from!=='string'||typeof chain.to!=='string'||
      !byId.has(chain.from)||!byId.has(chain.to))
      fail('skeleton chain '+i+' references a missing graph node');
    if(!Array.isArray(chain.points)||chain.points.length<1||chain.points.length>2000000||
      typeof chain.closed!=='boolean')
      fail('invalid skeleton chain geometry '+i);
    totalChainPoints+=chain.points.length;
    if(totalChainPoints>2000000)fail('skeleton graph point budget exceeded');
    if(chain.pixelLength!==undefined&&
      (typeof chain.pixelLength!=='number'||!Number.isFinite(chain.pixelLength)||chain.pixelLength<1))
      fail('invalid skeleton chain pixel length '+i);
    if(chain.closed&&chain.from!==chain.to)
      fail('closed skeleton chain must return to its anchor node');
    if(chain.from===chain.to&&!chain.closed&&
      (byId.get(chain.from)!==undefined&&nodes[byId.get(chain.from)].degree!==0||chain.points.length!==1))
      fail('non-cycle self-chain must be an isolated single-point node');
    if(chain.from===chain.to){
      if(chain.closed){incidence.set(chain.from,incidence.get(chain.from)+2);closedCycles++;}
    }else{
      incidence.set(chain.from,incidence.get(chain.from)+1);
      incidence.set(chain.to,incidence.get(chain.to)+1);
      join(chain.from,chain.to);
    }
    for(const point of chain.points){
      if(!point||typeof point.x!=='number'||!Number.isFinite(point.x)||
        typeof point.y!=='number'||!Number.isFinite(point.y)||
        typeof point.radius!=='number'||!Number.isFinite(point.radius)||point.radius<0)
        fail('invalid skeleton chain point '+i);
    }
    const first=chain.points[0],last=chain.points[chain.points.length-1];
    const start=nodes[byId.get(chain.from)],end=nodes[byId.get(chain.to)];
    if(Math.hypot(first.x-start.x,first.y-start.y)>1e-3||
      Math.hypot(last.x-end.x,last.y-end.y)>1e-3)
      fail('skeleton chain endpoints do not match their referenced graph nodes '+i);
  }
  for(const node of nodes){
    if(incidence.get(node.id)!==node.degree)
      fail('skeleton graph degree does not match chain incidence for '+node.id);
  }
  const components=new Set([...byId.keys()].map(root));
  const endpointCount=nodes.filter(n=>n.kind==='endpoint').length;
  const junctionCount=nodes.filter(n=>n.kind==='junction').length;
  const isolatedCount=nodes.filter(n=>n.kind==='isolated').length;
  const cycleAnchorCount=nodes.filter(n=>n.kind==='cycle-anchor').length;
  return {valid:true,nodeCount:nodes.length,chainCount:chains.length,
    connectedComponentCount:components.size,endpointCount,junctionCount,
    isolatedCount,cycleAnchorCount,closedCycleCount:closedCycles,
    degreeIncidenceVerified:true,semanticHierarchy:'not-inferred'};
}
function isSourceLayerEntity(entity){
  return Boolean(entity&&['source-layer','raster-layer','layer'].includes(entity.kind));
}
function finite(value,label){
  if(typeof value!=='number'||!Number.isFinite(value))fail(label+' must be present and finite in source metadata');
  return value;
}
function fromVision({source,layers,analysis}={}){
  if(!source||typeof source!=='object')fail('source metadata is required');
  if(!Array.isArray(layers)||layers.length>20000)fail('layers must be a bounded array');
  const semantic=analysis&&analysis.subject&&Array.isArray(analysis.parts)
    ?Vision.validateVisualAnalysis(analysis,{width:source.width,height:source.height})
    :null;
  const ids=new Set();
  for(const layer of layers){
    if(!layer||typeof layer.id!=='string'||!layer.id.trim())fail('every layer needs a stable source ID');
    if(ids.has(layer.id))fail('duplicate source layer ID '+layer.id);
    ids.add(layer.id);
  }
  const byLayer=new Map();
  if(semantic)for(const part of semantic.parts)for(const layerId of part.layerIds){
    if(!ids.has(layerId))fail('semantic proposal references unknown source layer '+layerId);
    if(!byLayer.has(layerId))byLayer.set(layerId,[]);
    byLayer.get(layerId).push({label:part.kind,confidence:part.confidence,provider:semantic.model||'vision-model'});
  }
  const entities=[],evidence=[],relations=[];
  layers.forEach((layer,index)=>{
    const bounds={
      x:finite(layer.left,'layer.left'),
      y:finite(layer.top,'layer.top'),
      width:finite(layer.width,'layer.width'),
      height:finite(layer.height,'layer.height')
    };
    if(bounds.width<0||bounds.height<0)fail('layer dimensions cannot be negative');
    const entity={id:layer.id,kind:typeof layer.kind==='string'&&layer.kind.trim()?layer.kind:'source-layer',
      ...(typeof layer.name==='string'&&layer.name.trim()?{name:layer.name.slice(0,512)}:{}),
      bounds,drawOrder:Number.isInteger(layer.order)?layer.order:index,sourceRefs:[layer.id]};
    if(typeof layer.visible==='boolean')entity.visible=layer.visible;
    if(layer.parentId!==undefined){
      if(typeof layer.parentId!=='string'||!ids.has(layer.parentId))fail('parentId references an unknown source layer');
      entity.parentId=layer.parentId;
    }
    const hypotheses=byLayer.get(layer.id);
    if(hypotheses&&hypotheses.length)entity.hypotheses=hypotheses;
    entities.push(entity);
    evidence.push({id:'bounds.'+index,kind:'source-layer-bounds',entityId:layer.id,confidence:1,
      note:'Bounds copied from explicit source-layer metadata; semantic labels are not facts'});
    if(typeof layer.parentId==='string')relations.push({type:'parent',from:layer.id,to:layer.parentId,confidence:1,evidence:['bounds.'+index]});
  });
  return SceneIR.createSceneIR({source,entities,relations,evidence,
    metadata:{producer:'computer-vision',semanticStatus:semantic?'model-proposal':'unclassified'}});
}
function withPixelTopology(scene,pixelTopology){
  const ir=SceneIR.createSceneIR(scene);
  if(!pixelTopology||!pixelTopology.source||!Array.isArray(pixelTopology.components)||
    !pixelTopology.graph||!Array.isArray(pixelTopology.graph.nodes)||!Array.isArray(pixelTopology.graph.chains))
    fail('a complete deterministic pixel-topology result is required');
  if(pixelTopology.source.width!==ir.source.width||pixelTopology.source.height!==ir.source.height)
    fail('pixel topology dimensions do not match the Scene IR source');
  if(pixelTopology.sourceLayerId!==undefined&&pixelTopology.sourceLayerId!==null&&
    (typeof pixelTopology.sourceLayerId!=='string'||!ir.entities.some(entity=>isSourceLayerEntity(entity)&&
      (entity.id===pixelTopology.sourceLayerId||(entity.sourceRefs||[]).includes(pixelTopology.sourceLayerId)))))
    fail('pixel topology references an unknown source layer');
  if(pixelTopology.components.length>10000)fail('pixel component budget exceeded');
  const entities=[...ir.entities],evidence=[...ir.evidence],relations=[...ir.relations];
  for(let index=0;index<pixelTopology.components.length;index++){
    const component=pixelTopology.components[index];
    if(!component||!component.bounds||!Number.isInteger(component.pixels)||component.pixels<1)
      fail('invalid pixel component '+index);
    const left=finite(component.bounds.left,'component.left');
    const top=finite(component.bounds.top,'component.top');
    const right=finite(component.bounds.right,'component.right');
    const bottom=finite(component.bounds.bottom,'component.bottom');
    if(right<=left||bottom<=top)
      fail('pixel component bounds must have positive area');
    const id='pixel.component.'+index;
    const evidenceId='pixel.component.bounds.'+index;
    const entity={id,kind:'pixel-component',bounds:{x:left,y:top,width:right-left,height:bottom-top},
      geometry:{pixelCount:component.pixels,touchesBorder:component.touchesBorder===true,
        sampleScale:component.sampleScale||(pixelTopology.sample&&pixelTopology.sample.scale)||1,coordinateSpace:'source-pixels'}};
    if(component.layerId!==undefined){
      if(typeof component.layerId!=='string'||!ir.entities.some(entity=>entity.id===component.layerId))
        fail('pixel component references an unknown source layer');
      entity.parentId=component.layerId;
      relations.push({type:'contains',from:component.layerId,to:id,confidence:1,evidence:[evidenceId]});
    }
    entities.push(entity);
    evidence.push({id:evidenceId,kind:'alpha-component-bounds',entityId:id,confidence:1,
      note:'Deterministic connected-component bounds from source alpha pixels; this is topology, not semantic object identity. Coordinates may extend beyond the PSD canvas when the source layer does. Pixel count: '+component.pixels+'. Touches image border: '+(component.touchesBorder===true)+
        (component.layerId?'. Source layer: '+component.layerId+'.':'.')});
  }
  const holes=Array.isArray(pixelTopology.holes)?pixelTopology.holes:[];
  if(holes.length>10000)fail('pixel hole budget exceeded');
  for(let index=0;index<holes.length;index++){
    const hole=holes[index];
    if(!hole||!hole.bounds||!Number.isInteger(hole.pixels)||hole.pixels<1)
      fail('invalid pixel hole '+index);
    const left=finite(hole.bounds.left,'hole.left');
    const top=finite(hole.bounds.top,'hole.top');
    const right=finite(hole.bounds.right,'hole.right');
    const bottom=finite(hole.bounds.bottom,'hole.bottom');
    if(right<=left||bottom<=top)fail('pixel hole bounds must have positive area');
    const id='pixel.hole.'+index,evidenceId='pixel.hole.bounds.'+index;
    const entity={id,kind:'pixel-hole',bounds:{x:left,y:top,width:right-left,height:bottom-top},
      geometry:{samplePixels:hole.samplePixels||hole.pixels,
        estimatedSourcePixels:hole.estimatedSourcePixels||hole.pixels,
        sampleScale:hole.sampleScale||(pixelTopology.sample&&pixelTopology.sample.scale)||1,
        coordinateSpace:'source-pixels',topology:'enclosed-four-connected-background'}};
    if(hole.layerId!==undefined){
      if(typeof hole.layerId!=='string'||!ir.entities.some(entity=>entity.id===hole.layerId))
        fail('pixel hole references an unknown source layer');
      entity.parentId=hole.layerId;
      relations.push({type:'contains',from:hole.layerId,to:id,confidence:1,evidence:[evidenceId]});
    }
    entities.push(entity);
    evidence.push({id:evidenceId,kind:'enclosed-alpha-hole-bounds',entityId:id,confidence:1,
      note:'Deterministic enclosed four-connected background region; a geometric hole candidate, not a semantic opening. Sample pixels: '+(hole.samplePixels||hole.pixels)+'.'});
  }
  const graph=pixelTopology.graph,graphNodes=graph.nodes,graphChains=graph.chains;
  if(graphNodes.length>20000||graphChains.length>50000)fail('pixel graph entity budget exceeded');
  const connectivityAudit=auditSkeletonGraph(graphNodes,graphChains);
  const graphNodeIds=new Map(),graphNodesById=new Map();
  for(let index=0;index<graphNodes.length;index++){
    const node=graphNodes[index];
    if(!node||!Number.isInteger(node.degree)||node.degree<0||node.degree>8)fail('invalid graph node '+index);
    const x=finite(node.x,'graph node x'),y=finite(node.y,'graph node y'),radius=finite(node.radius,'graph node radius');
    if(radius<0||typeof node.kind!=='string')fail('invalid graph node geometry or kind');
    if(node.sourceLayerId!==undefined&&node.sourceLayerId!==null&&
      !ir.entities.some(entity=>isSourceLayerEntity(entity)&&
        (entity.id===node.sourceLayerId||(entity.sourceRefs||[]).includes(node.sourceLayerId))))
      fail('graph node references an unknown source layer');
    const id='pixel.graph.node.'+index,evidenceId='pixel.graph.node.evidence.'+index;
    if(typeof node.id!=='string'||!node.id.trim()||graphNodeIds.has(node.id))fail('invalid or duplicate source graph node ID');
    graphNodeIds.set(node.id,id);graphNodesById.set(node.id,node);
    entities.push({id,kind:'pixel-graph-node',geometry:{x,y,radius,degree:node.degree,nodeKind:node.kind,
      sourceLayerId:node.sourceLayerId||null,coordinateSpace:'source-pixels'}});
    evidence.push({id:evidenceId,kind:'skeleton-graph-node',entityId:id,confidence:1,
      note:'Deterministic skeleton graph node; degree '+node.degree+', topological class '+node.kind+'.'});
  }
  let graphPointCount=0;
  for(let index=0;index<graphChains.length;index++){
    const chain=graphChains[index];
    if(!chain||!Array.isArray(chain.points)||chain.points.length<1||chain.points.length>10000||
      typeof chain.closed!=='boolean'||typeof chain.classification!=='string')fail('invalid graph chain '+index);
    graphPointCount+=chain.points.length;
    if(graphPointCount>1000000)fail('pixel graph point budget exceeded');
    const id='pixel.graph.chain.'+index,evidenceId='pixel.graph.chain.evidence.'+index;
    if(!graphNodeIds.has(chain.from)||!graphNodeIds.has(chain.to))
      fail('graph chain references an unknown endpoint node');
    const fromId=graphNodeIds.get(chain.from),toId=graphNodeIds.get(chain.to);
    const fromNode=graphNodesById.get(chain.from),toNode=graphNodesById.get(chain.to);
    const fromLayerId=fromNode.sourceLayerId||null,toLayerId=toNode.sourceLayerId||null;
    if(fromLayerId!==toLayerId)fail('graph chain cannot connect nodes from different PSD source layers');
    const chainLayerId=chain.sourceLayerId||fromLayerId;
    if(chainLayerId!==null&&(!ir.entities.some(entity=>isSourceLayerEntity(entity)&&
      (entity.id===chainLayerId||(entity.sourceRefs||[]).includes(chainLayerId)))||
      fromLayerId!==chainLayerId||toLayerId!==chainLayerId))
      fail('graph chain source-layer provenance does not match both endpoint nodes');
    const points=chain.points.map(point=>({x:finite(point.x,'chain point x'),y:finite(point.y,'chain point y'),radius:finite(point.radius,'chain point radius')}));
    entities.push({id,kind:'pixel-graph-chain',geometry:{points,pixelLength:Number(chain.pixelLength||points.length),
      sourceLayerId:chainLayerId,closed:chain.closed,classification:chain.classification,coordinateSpace:'source-pixels'}});
    relations.push({type:'connected-to',from:id,to:fromId,confidence:1,
      metadata:{endpoint:chain.from===chain.to?'both':'from',chainId:id}});
    if(chain.to!==chain.from)relations.push({type:'connected-to',from:id,to:toId,confidence:1,
      metadata:{endpoint:'to',chainId:id}});
    evidence.push({id:evidenceId,kind:'skeleton-graph-chain',entityId:id,confidence:1,
      note:'Deterministic skeleton path; '+chain.classification+', '+(chain.closed?'closed':'open')+
        ', '+points.length+' retained points.'});
  }
  evidence.push({id:'pixel.topology.summary',kind:'alpha-topology-summary',confidence:1,
    note:'Method: '+String(pixelTopology.method||'unknown')+'. Components: '+pixelTopology.components.length+
      '. Holes: '+holes.length+'. Graph nodes: '+pixelTopology.graph.nodes.length+
      '. Graph chains: '+pixelTopology.graph.chains.length+'. Cycles: '+Number(pixelTopology.graph.topology&&pixelTopology.graph.topology.cycleCount||0)+'. Sample scale: '+Number(pixelTopology.sample&&pixelTopology.sample.scale||1)+
      '. Semantic classification: unclassified.'});
  const enriched=SceneIR.createSceneIR({source:ir.source,entities,relations,evidence,
    metadata:{...ir.metadata,pixelTopology:{method:String(pixelTopology.method||'unknown'),
      sourceLayerId:pixelTopology.sourceLayerId||null,
      componentCount:pixelTopology.components.length,holeCount:holes.length,
      nodeCount:pixelTopology.graph.nodes.length,chainCount:pixelTopology.graph.chains.length,
      graphTopology:pixelTopology.graph.topology?{...pixelTopology.graph.topology}:null,
      graphConnectivityAudit:connectivityAudit,
      graphPruning:pixelTopology.graph.pruning?{...pixelTopology.graph.pruning}:null,
      sourceLayerCount:Number(pixelTopology.sourceLayerCount||0),
      cache:pixelTopology.cache?{hits:Number(pixelTopology.cache.hits||0),misses:Number(pixelTopology.cache.misses||0)}:null,
      semanticStatus:'unclassified'}}});
  const boneStructure=BoneStructure.derive(enriched);
  return SceneIR.createSceneIR({...enriched,metadata:{...enriched.metadata,
    pixelTopology:{...enriched.metadata.pixelTopology,boneStructure}}});
}
const api={fromVision,withPixelTopology};
if(typeof module==='object'&&module.exports)module.exports=api;
else if(typeof globalThis!=='undefined')globalThis.SAVisionSceneAdapter=api;
})();
