/* Pixel topology, not a humanoid pose preset. Semantic labels require a model. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.SpineVision=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const fail=m=>{throw Error('Vision: '+m);};
 const finite=(n,label)=>{if(typeof n!=='number'||!Number.isFinite(n))fail(label+' must be finite');return n;};
 const integer=(n,min,max,label)=>{if(!Number.isInteger(n)||n<min||n>max)fail(label+' outside integer budget');return n;};
 const DX=[0,1,1,1,0,-1,-1,-1],DY=[-1,-1,0,1,1,1,0,-1];
 function thin(mask,w,h,maxIterations){
  const out=mask.slice(),remove=[];let iterations=0,changed=true;
  const at=(x,y)=>x>=0&&y>=0&&x<w&&y<h?out[y*w+x]:0;
  while(changed&&iterations<maxIterations){changed=false;
   for(let pass=0;pass<2;pass++){
    remove.length=0;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
     const i=y*w+x;if(!out[i])continue;
     const p=DX.map((dx,k)=>at(x+dx,y+DY[k])),b=p.reduce((a,v)=>a+v,0);
     if(b<2||b>6)continue;let a=0;for(let k=0;k<8;k++)if(!p[k]&&p[(k+1)%8])a++;
     if(a!==1)continue;
     if(pass===0?(p[0]*p[2]*p[4]||p[2]*p[4]*p[6]):(p[0]*p[2]*p[6]||p[0]*p[4]*p[6]))continue;
     remove.push(i);
    }
    if(remove.length)changed=true;for(const i of remove)out[i]=0;
   }
   iterations++;
  }
  return {mask:out,iterations,converged:!changed};
 }
 function connected(mask,w,h,foreground=true,eight=true){
  const seen=new Uint8Array(mask.length),queue=new Int32Array(mask.length),groups=[];
  for(let start=0;start<mask.length;start++){
   if(seen[start]||Boolean(mask[start])!==foreground)continue;
   let head=0,tail=1,minX=start%w,maxX=minX,minY=Math.floor(start/w),maxY=minY,border=false;queue[0]=start;seen[start]=1;
   while(head<tail){const i=queue[head++],x=i%w,y=Math.floor(i/w);minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);if(x===0||y===0||x===w-1||y===h-1)border=true;
    for(let k=0;k<8;k++){if(!eight&&k%2)continue;const nx=x+DX[k],ny=y+DY[k];if(nx<0||ny<0||nx>=w||ny>=h)continue;const j=ny*w+nx;if(!seen[j]&&Boolean(mask[j])===foreground){seen[j]=1;queue[tail++]=j;}}
   }
   groups.push({pixels:tail,bounds:{left:minX,top:minY,right:maxX+1,bottom:maxY+1},touchesBorder:border});
  }
  return groups;
 }
 function distances(mask,w,h){
  const d=new Float32Array(mask.length),diag=Math.SQRT2,inf=Number.POSITIVE_INFINITY;
  const foreground=(x,y)=>x>=0&&y>=0&&x<w&&y<h&&mask[y*w+x]!==0;
  // Seed the transform at the actual silhouette boundary, not at the canvas
  // edge. Components may be centered anywhere inside a larger transparent PSD.
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
   const i=y*w+x;if(!mask[i])continue;
   let boundary=false;
   for(let k=0;k<8;k++)if(!foreground(x+DX[k],y+DY[k])){boundary=true;break;}
   d[i]=boundary?1:inf;
  }
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=y*w+x;if(!mask[i])continue;let value=d[i];if(x)value=Math.min(value,d[i-1]+1);if(y)value=Math.min(value,d[i-w]+1);if(x&&y)value=Math.min(value,d[i-w-1]+diag);if(x+1<w&&y)value=Math.min(value,d[i-w+1]+diag);d[i]=value;}
  for(let y=h-1;y>=0;y--)for(let x=w-1;x>=0;x--){const i=y*w+x;if(!mask[i])continue;let value=d[i];if(x+1<w)value=Math.min(value,d[i+1]+1);if(y+1<h)value=Math.min(value,d[i+w]+1);if(x+1<w&&y+1<h)value=Math.min(value,d[i+w+1]+diag);if(x&&y+1<h)value=Math.min(value,d[i+w-1]+diag);d[i]=value;}
  return d;
 }
 function simplify(points,tolerance){
  if(points.length<3||tolerance===0)return points;
  const keep=new Uint8Array(points.length);keep[0]=keep[points.length-1]=1;const stack=[[0,points.length-1]],limit=tolerance*tolerance;
  while(stack.length){const [a,b]=stack.pop(),p=points[a],q=points[b],dx=q.x-p.x,dy=q.y-p.y,den=dx*dx+dy*dy;let best=-1,max=limit;
   for(let i=a+1;i<b;i++){const r=points[i],u=den?Math.max(0,Math.min(1,((r.x-p.x)*dx+(r.y-p.y)*dy)/den)):0,d=(r.x-p.x-u*dx)**2+(r.y-p.y-u*dy)**2;if(d>max){max=d;best=i;}}
   if(best>=0){keep[best]=1;stack.push([a,best],[best,b]);}
  }
  return points.filter((_,i)=>keep[i]);
 }
 function pruneTerminalBranches(mask,w,h,minLength,budget){
  const out=mask.slice();let removedBranches=0,removedPixels=0,iterations=0;
  if(minLength<=0)return {mask:out,removedBranches,removedPixels,iterations};
  const neighbors=i=>{const x=i%w,y=Math.floor(i/w),items=[];
   for(let k=0;k<8;k++){const nx=x+DX[k],ny=y+DY[k];if(nx<0||ny<0||nx>=w||ny>=h)continue;const j=ny*w+nx;if(!out[j])continue;
    if(k%2&&(out[y*w+nx]||out[ny*w+x]))continue;items.push(j);
   }return items;
  };
  let changed=true;
  while(changed){
   changed=false;const endpoints=[];
   for(let i=0;i<out.length;i++)if(out[i]&&neighbors(i).length===1)endpoints.push(i);
   for(const start of endpoints){
    if(!out[start])continue;const path=[start];let previous=-1,current=start,terminal=null;
    while(path.length<=minLength+1){
     const next=neighbors(current).filter(j=>j!==previous);
     if(next.length!==1){if(next.length>=3)terminal=current;break;}
     const candidate=next[0];previous=current;current=candidate;path.push(current);
     const degree=neighbors(current).length;
     if(degree>=3){terminal=current;break;}
     if(degree!==2)break;
    }
    if(terminal!==null&&path.length-1<=minLength){
     for(const pixel of path)if(pixel!==terminal&&out[pixel]){out[pixel]=0;removedPixels++;}
     removedBranches++;changed=true;
    }
   }
   if(++iterations>budget)fail('skeleton branch pruning iteration budget exceeded');
  }
  return {mask:out,removedBranches,removedPixels,iterations};
 }
 function graph(mask,w,h,scale,distance,tolerance,budget,pruning){
  const nodes=[],chains=[],nodeAt=new Int32Array(mask.length);nodeAt.fill(-1);const used=new Uint8Array(mask.length),degrees=new Uint8Array(mask.length);let points=0;
  const point=i=>({x:(i%w+.5)*scale-.5,y:(Math.floor(i/w)+.5)*scale-.5,radius:distance[i]*scale});
  function neighbors(i){const x=i%w,y=Math.floor(i/w),out=[];
   for(let k=0;k<8;k++){const nx=x+DX[k],ny=y+DY[k];if(nx<0||ny<0||nx>=w||ny>=h)continue;const j=ny*w+nx;if(!mask[j])continue;
    // Ignore diagonal shortcuts when a cardinal connection already exists.
    if(k%2&&((mask[y*w+nx]||0)||(mask[ny*w+x]||0)))continue;
    out.push({index:j,direction:k});
   }return out;
  }
  function addNode(i){if(nodeAt[i]>=0)return nodeAt[i];if(nodes.length>=budget)fail('pixel graph node budget exceeded');const index=nodes.length,degree=degrees[i],kind=degree===0?'isolated':degree===1?'endpoint':degree===2?'cycle-anchor':'junction';nodes.push({id:'graph_node_'+index,pixel:i,degree,kind,...point(i)});nodeAt[i]=index;return index;}
  for(let i=0;i<mask.length;i++)if(mask[i]){degrees[i]=neighbors(i).length;if(degrees[i]!==2)addNode(i);}
  function trace(start,next,direction){let prev=start,current=next;used[start]|=1<<direction;used[current]|=1<<((direction+4)%8);const list=[point(start)];let closed=false;
   while(true){if(++points>budget)fail('pixel graph chain budget exceeded');list.push(point(current));if(current===start){closed=true;break;}if(nodeAt[current]>=0)break;const options=neighbors(current).filter(v=>v.index!==prev);if(!options.length){addNode(current);break;}const n=options[0];used[current]|=1<<n.direction;used[n.index]|=1<<((n.direction+4)%8);prev=current;current=n.index;}
   const from=addNode(start),to=addNode(current),fromKind=nodes[from].kind,toKind=nodes[to].kind;const classification=closed?'cycle':fromKind==='endpoint'&&toKind==='endpoint'?'endpoint-to-endpoint':fromKind==='junction'||toKind==='junction'?'junction-branch':'topology-segment';chains.push({id:'graph_chain_'+chains.length,from:nodes[from].id,to:nodes[to].id,closed,points:simplify(list,tolerance),pixelLength:list.length,confidence:1,classification});
  }
  for(let n=0;n<nodes.length;n++){const start=nodes[n].pixel,ns=neighbors(start);if(!ns.length)chains.push({id:'chain_'+chains.length,from:nodes[n].id,to:nodes[n].id,closed:false,points:[point(start)],pixelLength:1,confidence:1,classification:'unclassified'});for(const p of ns)if(!(used[start]&(1<<p.direction)))trace(start,p.index,p.direction);}
  // Closed contours contain no endpoint; retain one anchor rather than lose them.
  for(let i=0;i<mask.length;i++)if(mask[i])for(const p of neighbors(i))if(!(used[i]&(1<<p.direction))){addNode(i);trace(i,p.index,p.direction);}
  const publicNodes=nodes.map(({pixel,...node})=>node),topology={endpointCount:publicNodes.filter(n=>n.kind==='endpoint').length,junctionCount:publicNodes.filter(n=>n.kind==='junction').length,isolatedCount:publicNodes.filter(n=>n.kind==='isolated').length,cycleAnchorCount:publicNodes.filter(n=>n.kind==='cycle-anchor').length,cycleCount:chains.filter(c=>c.closed).length,branchCount:chains.filter(c=>c.classification==='junction-branch').length,prunedBranchCount:pruning.removedBranches,prunedPixelCount:pruning.removedPixels};return {nodes:publicNodes,chains,topology,pruning:{minBranchLength:pruning.minBranchLength,removedBranches:pruning.removedBranches,removedPixels:pruning.removedPixels,iterations:pruning.iterations}};
 }
 function analyzePixels(image,options={}){
  if(!image||!Number.isInteger(image.width)||!Number.isInteger(image.height)||image.width<1||image.height<1||image.width*image.height>64000000||!image.data||image.data.length!==image.width*image.height*4)fail('expected an RGBA image up to 64 megapixels');
  const maxPixels=integer(options.maxPixels===undefined?2000000:options.maxPixels,1,8000000,'maxPixels'),threshold=integer(options.alphaThreshold===undefined?32:options.alphaThreshold,1,255,'alphaThreshold');
  let scale=Math.max(1,Math.ceil(Math.sqrt(image.width*image.height/maxPixels)));let width=Math.ceil(image.width/scale),height=Math.ceil(image.height/scale);while(width*height>maxPixels){scale++;width=Math.ceil(image.width/scale);height=Math.ceil(image.height/scale);}const mask=new Uint8Array(width*height);
  for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++){const i=(y*image.width+x)*4,a=image.data[i+3];if(typeof a!=='number'||!Number.isFinite(a)||a<0||a>255)fail('invalid alpha pixel');if(a>=threshold)mask[Math.floor(y/scale)*width+Math.floor(x/scale)]=1;}
  const maxIterations=integer(options.maxIterations===undefined?256:options.maxIterations,1,2048,'maxIterations');
  const tolerance=finite(options.simplifyTolerance===undefined?1.5:options.simplifyTolerance,'simplifyTolerance');if(tolerance<0||tolerance>1000)fail('invalid simplification tolerance');
  const topology=thin(mask,width,height,maxIterations),groups=connected(mask,width,height),holes=connected(mask,width,height,false,false).filter(c=>!c.touchesBorder),distance=distances(mask,width,height);
  const minBranchLength=integer(options.minBranchLength===undefined?0:options.minBranchLength,0,1000,'minBranchLength'),pruned=pruneTerminalBranches(topology.mask,width,height,minBranchLength,integer(options.maxPruneIterations===undefined?32:options.maxPruneIterations,1,256,'maxPruneIterations'));pruned.minBranchLength=minBranchLength;const result=graph(pruned.mask,width,height,scale,distance,tolerance,integer(options.maxGraphPoints===undefined?500000:options.maxGraphPoints,1,2000000,'maxGraphPoints'),pruned);
  for(const p of [...result.nodes,...result.chains.flatMap(c=>c.points)]){p.x=Math.min(image.width-1,p.x);p.y=Math.min(image.height-1,p.y);}
  const sourceLayerId=options.sourceLayerId;
  if(sourceLayerId!==undefined&&(typeof sourceLayerId!=='string'||!sourceLayerId.trim()||sourceLayerId.length>128))
    fail('sourceLayerId must be a nonempty stable source-layer ID');
  return {version:1,method:'alpha-mask Zhang-Suen thinning and pixel graph',source:{width:image.width,height:image.height},sourceLayerId:sourceLayerId||null,sample:{width,height,scale},subject:{kind:'unclassified',confidence:0},semanticStatus:'unclassified',components:groups.map((c,i)=>({id:'component_'+i,pixels:c.pixels,samplePixels:c.pixels,estimatedSourcePixels:Math.min(image.width*image.height,c.pixels*scale*scale),bounds:Object.fromEntries(Object.entries(c.bounds).map(([k,v])=>[k,Math.min(k==='left'||k==='right'?image.width:image.height,v*scale)]))})),holes:holes.map((c,i)=>({id:'hole_'+i,pixels:c.pixels,samplePixels:c.pixels,estimatedSourcePixels:Math.min(image.width*image.height,c.pixels*scale*scale),bounds:Object.fromEntries(Object.entries(c.bounds).map(([k,v])=>[k,Math.min(k==='left'||k==='right'?image.width:image.height,v*scale)]))})),holeCount:holes.length,graph:result,chains:result.chains,thinning:{iterations:topology.iterations,converged:topology.converged},limitations:['Pixel topology does not identify a character, hand, leg, hair, rope or other semantic object.','Alpha silhouettes cannot separate overlapping limbs or infer hidden structure.','Downsampling may join narrow gaps; recovered points are candidates, not anatomical certainty.','Skeleton graph describes image topology, not an automatically approved animation rig.']};
 }
 function validateVisualAnalysis(value,source){
  if(!value||typeof value!=='object'||!value.subject||typeof value.subject.kind!=='string'||!Array.isArray(value.parts)||value.parts.length>10000)fail('invalid visual model analysis');
  const confidence=(n,label)=>{finite(n,label);if(n<0||n>1)fail(label+' must be 0..1');return n;};
  const text=(s,label)=>{if(typeof s!=='string'||!s.trim()||s.length>200)fail('invalid '+label);return s;};
  const width=source&&source.width,height=source&&source.height,ids=new Set();let totalPoints=0,totalChains=0;
  const parts=value.parts.map(p=>{const id=text(p.id,'part ID');if(ids.has(id))fail('duplicate visual part ID');ids.add(id);if(!Array.isArray(p.chains)||p.chains.length>10000||!Array.isArray(p.layerIds)||p.layerIds.length>10000)fail('invalid visual part references');
   return {id,kind:text(p.kind,'part kind'),confidence:confidence(p.confidence,'part confidence'),layerIds:p.layerIds.map(s=>text(s,'layer ID')),chains:p.chains.map((c,i)=>{if(!c||!Array.isArray(c.points)||c.points.length<2||c.points.length>10000)fail('a model chain needs 2..10000 points');totalChains++;totalPoints+=c.points.length;if(totalChains>100000||totalPoints>1000000)fail('visual model graph budget exceeded');return {id:typeof c.id==='string'?text(c.id,'chain ID'):id+'_chain_'+i,closed:c.closed===true,points:c.points.map(q=>{const x=finite(q.x,'point.x'),y=finite(q.y,'point.y');if(width!==undefined&&(x<0||x>width)||height!==undefined&&(y<0||y>height))fail('visual point outside source image');return {x,y};})};})};
  });
  return {subject:{kind:text(value.subject.kind,'subject kind'),confidence:confidence(value.subject.confidence,'subject confidence')},parts,model:typeof value.model==='string'?value.model.slice(0,200):null};
 }
 function mergeVisualAnalysis(topology,modelResult){
  if(!topology||!topology.source)fail('pixel topology is required');const visual=validateVisualAnalysis(modelResult,topology.source);
  return {...topology,subject:visual.subject,semanticStatus:'model-proposal',visualModel:visual,limitations:[...topology.limitations,'Model labels and joint paths are proposals with confidence values, not independently verified anatomy.']};
 }
 /*
  * Cache results by an explicit immutable source identity (for example a layer
  * canvas object). Call invalidate(key) whenever that source is mutated.
  * WeakMap keys allow removed layers to be garbage-collected automatically.
  */
 function createAnalysisCache(){
  let entries=new WeakMap(),hits=0,misses=0;
  function analyze(cacheKey,imageOrFactory,options={}){
   if(!cacheKey||(typeof cacheKey!=='object'&&typeof cacheKey!=='function'))
    fail('analysis cache requires an object identity key');
   const signature=JSON.stringify(options);
   const cached=entries.get(cacheKey);
   if(cached&&cached.signature===signature){hits++;return cached.result;}
   const image=typeof imageOrFactory==='function'?imageOrFactory():imageOrFactory;
   const result=analyzePixels(image,options);
   const freezeTree=value=>{
    if(value&&typeof value==='object'&&!Object.isFrozen(value)){
     for(const key of Object.keys(value))freezeTree(value[key]);
     Object.freeze(value);
    }
    return value;
   };
   const immutable=freezeTree(result);
   entries.set(cacheKey,{signature,result:immutable});misses++;return immutable;
  }
  function invalidate(cacheKey){
   if(cacheKey===undefined){entries=new WeakMap();return true;}
   if(!cacheKey||(typeof cacheKey!=='object'&&typeof cacheKey!=='function'))return false;
   return entries.delete(cacheKey);
  }
  function stats(){return {hits,misses};}
  return Object.freeze({analyze,invalidate,stats});
 }
 return {analyzePixels,validateVisualAnalysis,mergeVisualAnalysis,createAnalysisCache};
});
