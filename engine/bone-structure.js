'use strict';
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.SABoneStructure=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const fail=m=>{throw new Error('BoneStructure: '+m);};
  function isSourceLayerEntity(entity){
    return Boolean(entity&&['source-layer','raster-layer','layer'].includes(entity.kind));
  }
  function collectSourceLayerIds(entities){
    return new Set(entities.filter(isSourceLayerEntity).flatMap(entity=>[
      entity.id,...(Array.isArray(entity.sourceRefs)?entity.sourceRefs:[])
    ]));
  }
  const finite=(v,label)=>{if(typeof v!=='number'||!Number.isFinite(v))fail(label+' must be finite');return v;};
  function derive(scene){
    if(!scene||scene.schema!=='sa.scene-ir'||!Array.isArray(scene.entities)||!Array.isArray(scene.relations)||!Array.isArray(scene.evidence))
      fail('normalized Scene IR is required');
    const topology=scene.metadata&&scene.metadata.pixelTopology;
    const audit=topology&&topology.graphConnectivityAudit;
    if(!audit||audit.valid!==true||audit.degreeIncidenceVerified!==true)
      return {status:'unavailable',candidateCount:0,candidates:[],junctions:[],hierarchy:{status:'not-established',edges:[]},
        limitations:['A valid deterministic skeleton connectivity audit is required.']};
    const nodes=new Map(scene.entities.filter(e=>e.kind==='pixel-graph-node').map(e=>[e.id,e]));
    const chains=scene.entities.filter(e=>e.kind==='pixel-graph-chain');
    if(nodes.size>20000||chains.length>50000)fail('Scene IR skeleton graph exceeds the structural analysis budget');
    const chainById=new Map(chains.map(chain=>[chain.id,chain]));
    const evidenceIds=new Set(scene.evidence.map(e=>e.id));
    const sourceLayerIds=collectSourceLayerIds(scene.entities);
    const defaultSourceLayerId=typeof topology.sourceLayerId==='string'?topology.sourceLayerId:null;
    if(defaultSourceLayerId&&!sourceLayerIds.has(defaultSourceLayerId))
      fail('topology sourceLayerId does not resolve to a Scene IR source layer');
    if(audit.nodeCount!==nodes.size||audit.chainCount!==chains.length)
      fail('connectivity audit counts do not match Scene IR graph entities');
    const endpoints=new Map(),incidence=new Map([...nodes.keys()].map(id=>[id,0]));
    const componentParent=new Map([...nodes.keys()].map(id=>[id,id]));
    const root=id=>{let p=componentParent.get(id);while(p!==componentParent.get(p))p=componentParent.get(p);let q=id;while(componentParent.get(q)!==p){const n=componentParent.get(q);componentParent.set(q,p);q=n;}return p;};
    for(const relation of scene.relations){
      if(relation.type!=='connected-to')continue;
      const fromIsChain=chainById.has(relation.from),toIsChain=chainById.has(relation.to);
      if(!fromIsChain&&!toIsChain)continue;
      if(!fromIsChain||toIsChain||!nodes.has(relation.to))
        fail('connected-to relation must point from a graph chain to a graph node');
      if(relation.metadata?.chainId!==undefined&&relation.metadata.chainId!==relation.from)
        fail('connected-to relation chainId does not match its source chain');
      const endpoint=relation.metadata&&relation.metadata.endpoint;
      if(!['from','to','both'].includes(endpoint))
        fail('connected-to relation requires an explicit from, to or both endpoint');
      if(!endpoints.has(relation.from))endpoints.set(relation.from,{});
      const record=endpoints.get(relation.from);
      if(endpoint==='both'){
        if(record.from!==undefined||record.to!==undefined||record.both)
          fail('chain '+relation.from+' has duplicate endpoint relations');
        record.from=relation.to;record.to=relation.to;record.both=true;
      }else{
        if(record.both||record[endpoint]!==undefined)
          fail('chain '+relation.from+' has duplicate '+endpoint+' endpoint relations');
        record[endpoint]=relation.to;
      }
    }
    const candidates=[];let totalPoints=0;
    for(const chain of chains){
      const geometry=chain.geometry||{},points=geometry.points;
      if(!Array.isArray(points)||points.length<1)fail('chain '+chain.id+' has no retained geometry');
      let length=0,radiusTotal=0;
      for(let i=0;i<points.length;i++){
        const p=points[i];finite(p.x,'chain point x');finite(p.y,'chain point y');
        if(p.radius!==undefined){finite(p.radius,'chain point radius');if(p.radius<0)fail('negative chain radius');radiusTotal+=p.radius;}
        if(i)length+=Math.hypot(p.x-points[i-1].x,p.y-points[i-1].y);
      }
      const ends=endpoints.get(chain.id)||{};
      if(!ends.from||!ends.to)fail('chain '+chain.id+' has incomplete endpoint relations');
      if(ends.from===ends.to&&!ends.both)
        fail('self-loop chain '+chain.id+' requires one explicit both-endpoints relation');
      if(ends.from!==ends.to&&ends.both)
        fail('non-loop chain '+chain.id+' cannot use a both-endpoints relation');
      const start=nodes.get(ends.from),end=nodes.get(ends.to);
      if(!start||!end)fail('chain '+chain.id+' references a missing graph node');
      if(typeof geometry.closed!=='boolean')fail('chain '+chain.id+' has no closed/open topology flag');
      const closed=geometry.closed===true;
      if(closed&&ends.from!==ends.to)fail('closed chain '+chain.id+' must return to its anchor node');
      if(ends.from===ends.to){
        if(!closed&&(start.geometry.degree!==0||points.length!==1))
          fail('non-cycle self-chain '+chain.id+' must represent an isolated node');
        if(closed){
          const first=points[0],last=points[points.length-1];
          if(Math.hypot(first.x-start.geometry.x,first.y-start.geometry.y)>1e-3||
            Math.hypot(last.x-start.geometry.x,last.y-start.geometry.y)>1e-3)
            fail('closed chain '+chain.id+' geometry does not return to its anchor');
          incidence.set(ends.from,incidence.get(ends.from)+2);
        }
      }else{
        if(closed)fail('open chain '+chain.id+' cannot have distinct endpoints and be marked closed');
        incidence.set(ends.from,incidence.get(ends.from)+1);
        incidence.set(ends.to,incidence.get(ends.to)+1);
        const a=points[0],b=points[points.length-1];
        if(Math.hypot(a.x-start.geometry.x,a.y-start.geometry.y)>1e-3||
          Math.hypot(b.x-end.geometry.x,b.y-end.geometry.y)>1e-3)
          fail('chain '+chain.id+' geometry does not meet its endpoint nodes');
        const ra=root(ends.from),rb=root(ends.to);if(ra!==rb)componentParent.set(ra,rb);
      }
      const loop=closed||ends.from===ends.to;
      const sourceLayerId=geometry.sourceLayerId||defaultSourceLayerId;
      if(sourceLayerId&&!sourceLayerIds.has(sourceLayerId))
        fail('candidate sourceLayerId does not resolve to a Scene IR source layer');
      const evidenceId='pixel.graph.chain.evidence.'+chain.id.split('.').at(-1);
      const evidenceRef=evidenceIds.has(evidenceId)?evidenceId:null;
      const eligible=!loop&&ends.from!==ends.to&&length>0&&geometry.classification!=='unclassified';
      candidates.push({
        id:'bone.candidate.'+chain.id.split('.').at(-1),
        sourceChainId:chain.id,sourceNodeIds:[ends.from,ends.to],sourceLayerId,
        start:{x:points[0].x,y:points[0].y,nodeId:ends.from},
        end:{x:points.at(-1).x,y:points.at(-1).y,nodeId:ends.to},
        polylineLength:length,meanRadius:radiusTotal/points.length,
        endpointKinds:[start.geometry.nodeKind,end.geometry.nodeKind],
        endpointDegrees:[start.geometry.degree,end.geometry.degree],
        topologyClass:geometry.classification||'unknown',
        closed:loop,status:eligible?'unoriented-candidate':'excluded-topology',
        semanticRole:null,parentCandidateId:null,
        evidenceRefs:evidenceRef?[evidenceRef]:[],
        confidence:{geometry:1,anatomicalIdentity:0,direction:0}
      });
    }
    for(const [id,node] of nodes){
      const geometry=node.geometry||{},degree=geometry.degree,nodeKind=geometry.nodeKind;
      finite(geometry.x,'graph node x');finite(geometry.y,'graph node y');
      finite(geometry.radius,'graph node radius');
      if(geometry.radius<0)fail('negative graph node radius for '+id);
      if(!Number.isInteger(degree)||degree!==incidence.get(id))
        fail('Scene IR node degree disagrees with chain incidence for '+id);
      const expected=degree===0?'isolated':degree===1?'endpoint':degree===2?'cycle-anchor':'junction';
      if(nodeKind!==expected)fail('Scene IR node kind disagrees with its degree for '+id);
    }
    const componentCount=new Set([...nodes.keys()].map(root)).size;
    if(audit.connectedComponentCount!==componentCount)
      fail('connectivity audit component count does not match graph topology');
    const incidentByNode=new Map([...nodes.keys()].map(id=>[id,[]]));
    for(const candidate of candidates)for(const nodeId of candidate.sourceNodeIds)
      incidentByNode.get(nodeId)?.push(candidate.id);
    const junctions=[...nodes.values()].filter(n=>n.geometry&&n.geometry.nodeKind==='junction').map(n=>{
      const incident=incidentByNode.get(n.id)||[];
      return {nodeId:n.id,x:n.geometry.x,y:n.geometry.y,degree:n.geometry.degree,
        incidentCandidateIds:incident,branchingCandidate:incident.length>=3};
    });
    const adjacency=[];
    for(const junction of junctions)for(let i=0;i<junction.incidentCandidateIds.length;i++)
      for(let j=i+1;j<junction.incidentCandidateIds.length;j++)
        adjacency.push({atNodeId:junction.nodeId,candidateIds:[junction.incidentCandidateIds[i],junction.incidentCandidateIds[j]],
          relation:'shares-topological-junction',parentChild:false});
    return {
      status:'candidates-only',candidateCount:candidates.filter(c=>c.status==='unoriented-candidate').length,
      candidates,junctions,adjacency,
      hierarchy:{status:'not-established',edges:[],reason:'Undirected pixel connectivity cannot determine anatomical parent, child or bone identity.'},
      audit:{connectedComponentCount:audit.connectedComponentCount,nodeCount:audit.nodeCount,chainCount:audit.chainCount,
        degreeIncidenceVerified:true},
      limitations:[
        'Candidates describe measured skeleton paths, not confirmed anatomical bones.',
        'Junction adjacency is undirected; no parent-child direction is inferred.',
        'Closed loops and degenerate paths are retained as topology but excluded from bone candidates.',
        'Overlapping or occluded anatomy cannot be recovered from alpha topology alone.'
      ]
    };
  }
  function validateHierarchy(scene,proposal){
    const structure=derive(scene);
    if(!proposal||!Array.isArray(proposal.bones)||!proposal.bones.length||proposal.bones.length>1000||
      !Array.isArray(proposal.parentChild)||proposal.parentChild.length>2000)
      fail('hierarchy proposal must contain 1..1000 bones and at most 2000 parentChild edges');
    if(proposal.bones.length>2000||proposal.parentChild.length>4000)fail('hierarchy proposal exceeds budget');
    const candidateById=new Map(structure.candidates.filter(c=>c.status==='unoriented-candidate').map(c=>[c.id,c]));
    const boneById=new Map(),usedCandidates=new Set(),usedSourceLayers=new Set(),evidenceById=new Set(scene.evidence.map(e=>e.id));
    const sourceLayerIdSet=collectSourceLayerIds(scene.entities);
    for(const bone of proposal.bones){
      if(!bone||typeof bone.id!=='string'||!/^bone\.[a-zA-Z0-9._-]{1,100}$/.test(bone.id)||boneById.has(bone.id))
        fail('bone IDs must be unique and valid');
      const candidate=candidateById.get(bone.candidateId);
      if(!candidate)fail('bone '+bone.id+' references an unavailable topology candidate');
      if(usedCandidates.has(bone.candidateId))fail('a topology candidate cannot be assigned to multiple bones');
      usedCandidates.add(bone.candidateId);
      if(!candidate.sourceNodeIds.includes(bone.startNodeId)||!candidate.sourceNodeIds.includes(bone.endNodeId)||
        bone.startNodeId===bone.endNodeId)
        fail('bone '+bone.id+' requires an explicit orientation along its candidate endpoints');
      if(typeof bone.role!=='string'||!bone.role.trim()||bone.role.length>128)
        fail('bone '+bone.id+' requires a bounded explicit semantic role hypothesis');
      if(bone.confidence!==undefined&&(typeof bone.confidence!=='number'||!Number.isFinite(bone.confidence)||bone.confidence<0||bone.confidence>1))
        fail('bone '+bone.id+' confidence must be 0..1');
      if(!Array.isArray(bone.evidenceRefs)||!bone.evidenceRefs.length||bone.evidenceRefs.length>32||
        bone.evidenceRefs.some(id=>!evidenceById.has(id))||
        !bone.evidenceRefs.some(id=>candidate.evidenceRefs.includes(id)))
        fail('bone '+bone.id+' requires its candidate chain evidence in the Scene IR references');
      const sourceLayerIds=bone.sourceLayerIds===undefined?[]:bone.sourceLayerIds;
      if(!Array.isArray(sourceLayerIds)||sourceLayerIds.length>1||
        sourceLayerIds.some(id=>typeof id!=='string'||!sourceLayerIdSet.has(id)))
        fail('bone '+bone.id+' contains an unknown or invalid source layer reference');
      if(sourceLayerIds.length&&(!candidate.sourceLayerId||sourceLayerIds.some(id=>id!==candidate.sourceLayerId)))
        fail('bone '+bone.id+' cannot bind artwork without matching source-layer topology evidence');
      for(const layerId of sourceLayerIds){
        if(usedSourceLayers.has(layerId))fail('a source layer cannot be rigidly assigned to multiple candidate bones');
        usedSourceLayers.add(layerId);
      }
      const orientedStart=candidate.sourceNodeIds[0]===bone.startNodeId?candidate.start:candidate.end;
      const orientedEnd=candidate.sourceNodeIds[0]===bone.endNodeId?candidate.start:candidate.end;
      boneById.set(bone.id,{...bone,sourceLayerIds:[...sourceLayerIds],
        start:{x:orientedStart.x,y:orientedStart.y,nodeId:bone.startNodeId},
        end:{x:orientedEnd.x,y:orientedEnd.y,nodeId:bone.endNodeId},
        candidateId:bone.candidateId,status:'hypothesis'});
    }
    const edges=[],parents=new Map(),adjacent=new Set(structure.adjacency.map(a=>a.candidateIds.slice().sort().join('|')));
    for(const edge of proposal.parentChild){
      if(!edge||!boneById.has(edge.parentId)||!boneById.has(edge.childId)||edge.parentId===edge.childId)
        fail('parent-child edge references invalid bones');
      if(parents.has(edge.childId))fail('a bone cannot have multiple parents in a single hierarchy');
      const parent=boneById.get(edge.parentId),child=boneById.get(edge.childId);
      const pair=[candidateById.get(parent.candidateId),candidateById.get(child.candidateId)];
      if(!adjacent.has(pair.map(c=>c.id).sort().join('|')))
        fail('parent-child candidates must share a measured skeleton junction');
      if(parent.endNodeId!==child.startNodeId)
        fail('parent-child orientation must join parent end to child start at the measured junction');
      const parentCandidate=candidateById.get(parent.candidateId),childCandidate=candidateById.get(child.candidateId);
      if(!Array.isArray(edge.evidenceRefs)||!edge.evidenceRefs.length||edge.evidenceRefs.length>64||
        edge.evidenceRefs.some(id=>!evidenceById.has(id))||
        !edge.evidenceRefs.some(id=>parentCandidate.evidenceRefs.includes(id))||
        !edge.evidenceRefs.some(id=>childCandidate.evidenceRefs.includes(id)))
        fail('parent-child edge requires evidence from both connected candidate chains');
      parents.set(edge.childId,edge.parentId);edges.push({parentId:edge.parentId,childId:edge.childId,
        status:'hypothesis',evidenceRefs:[...edge.evidenceRefs]});
    }
    for(const id of boneById.keys()){
      const seen=new Set();let current=id;
      while(parents.has(current)){if(seen.has(current))fail('parent-child hierarchy contains a cycle');seen.add(current);current=parents.get(current);}
    }
    return {status:'validated-hypothesis',bones:[...boneById.values()],
      edges,hierarchyVerified:false,verificationReason:'Structural consistency is verified, but anatomical semantics and direction remain hypotheses.'};
  }
  return {derive,validateHierarchy};
});
