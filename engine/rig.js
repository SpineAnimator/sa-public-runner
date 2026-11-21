/* New source-preserving Spine 4.3 rig. No source pixels are changed. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SpineRig = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const RAD = Math.PI / 180;
  const deg = (a, b) => Math.atan2(b.y - a.y, b.x - a.x) / RAD;
  const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const finite = (v, label) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(label + ' must be a finite number');
    return v;
  };
  function multiply(a, b) {
    return [a[0]*b[0]+a[1]*b[2], a[0]*b[1]+a[1]*b[3],
      a[2]*b[0]+a[3]*b[2], a[2]*b[1]+a[3]*b[3],
      a[0]*b[4]+a[1]*b[5]+a[4], a[2]*b[4]+a[3]*b[5]+a[5]];
  }
  function transform(m, p) { return {x:m[0]*p.x+m[1]*p.y+m[4],y:m[2]*p.x+m[3]*p.y+m[5]}; }
  function inverse(m, p) {
    const det=m[0]*m[3]-m[1]*m[2];
    if (Math.abs(det)<1e-12) throw new Error('Singular bind matrix');
    return {x:(m[3]*(p.x-m[4])-m[1]*(p.y-m[5]))/det,
      y:(-m[2]*(p.x-m[4])+m[0]*(p.y-m[5]))/det};
  }
  // Independent Editor-bind-plane preflight. Spine 4.3 requires the FIRST
  // `hull` mesh vertices to describe an ordered, clockwise outer boundary.
  // Internal vertices on/outside that polygon can import in the runtime yet
  // fail the licensed Editor's Nonessential JSON roundtrip.
  // This checks XY bind geometry, not texture UVs or animated world poses.
  function validateSpineMeshHull(xy,hull,triangles) {
    if(!Array.isArray(xy)||xy.length<6||xy.length%2!==0||
      xy.length>30000||xy.some(v=>typeof v!=='number'||!Number.isFinite(v)))
      throw new Error('Spine mesh hull: finite XY vertex pairs required');
    const count=xy.length/2;
    if(!Number.isInteger(hull)||hull<3||hull>count)
      throw new Error('Spine mesh hull: invalid perimeter vertex count');
    if(!Array.isArray(triangles)||!triangles.length||triangles.length%3!==0)
      throw new Error('Spine mesh hull: complete triangle index triples required');
    const point=i=>({x:xy[i*2],y:xy[i*2+1]});
    const poly=Array.from({length:hull},(_,i)=>point(i));
    const xs=poly.map(p=>p.x),ys=poly.map(p=>p.y);
    const span=Math.hypot(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys));
    if(!Number.isFinite(span)||span<1e-7)
      throw new Error('Spine mesh hull: degenerate perimeter');
    const cross=(a,b,p)=>(b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x);
    let area2=0;
    for(let i=0;i<hull;i++){
      const a=poly[i],b=poly[(i+1)%hull];
      area2+=a.x*b.y-b.x*a.y;
      if(Math.hypot(a.x-b.x,a.y-b.y)<=span*1e-8)
        throw new Error('Spine mesh hull: duplicate or collapsed perimeter edge');
      const turn=cross(a,b,poly[(i+2)%hull]);
      if(turn>span*span*1e-8)
        throw new Error('Spine mesh hull: perimeter must be convex and clockwise');
    }
    if(area2>=-span*span*1e-8)
      throw new Error('Spine mesh hull: perimeter must be nondegenerate and clockwise');
    // Signed distance to every clockwise edge must be positive for nonhull
    // vertices. Collinear hull edge subdivisions themselves are permitted.
    const margin=Math.max(1e-8,span*1e-5);
    let minInteriorDistance=Infinity;
    for(let k=hull;k<count;k++){
      const p=point(k);
      for(let e=0;e<hull;e++){
        const a=poly[e],b=poly[(e+1)%hull];
        const d=-cross(a,b,p)/Math.hypot(a.x-b.x,a.y-b.y);
        minInteriorDistance=Math.min(minInteriorDistance,d);
        if(d<=margin)
          throw new Error('Spine mesh hull: internal vertex outside/on perimeter at '+k);
      }
    }
    const areaTol=span*span*1e-10;
    for(let i=0;i<triangles.length;i+=3){
      const [a,b,c]=triangles.slice(i,i+3);
      if(![a,b,c].every(n=>Number.isInteger(n)&&n>=0&&n<count)||
        a===b||b===c||a===c)
        throw new Error('Spine mesh hull: invalid triangle indices');
      if(Math.abs(cross(point(a),point(b),point(c)))<=areaTol)
        throw new Error('Spine mesh hull: degenerate triangle');
    }
    return {vertexCount:count,hull,triangleCount:triangles.length/3,
      minInteriorDistance:Number.isFinite(minInteriorDistance)?minInteriorDistance:null};
  }
  function worldMatrices(bones) {
    const result={};
    for (const b of bones) {
      const r=(b.rotation||0)*RAD,c=Math.cos(r),s=Math.sin(r);
      const local=[c*(b.scaleX??1),-s*(b.scaleY??1),s*(b.scaleX??1),c*(b.scaleY??1),b.x||0,b.y||0];
      if (b.parent && !result[b.parent]) throw new Error('Parent must precede child: '+b.name);
      result[b.name]=b.parent?multiply(result[b.parent],local):local;
    }
    return result;
  }
  function classify(name) {
    const n=String(name).toLowerCase().replace(/_/g,'-');
    // Prefixes from PSD [name] groups must not obscure actual component names.
    // Weapon-front overlay follows the weapon/hand, not the head.
    if (/eye|mustash|mustach|sombrero|hat|face|head|mouth|голов|лиц|шляп/.test(n)) return {role:'head'};
    if (/glow.*hand.*right|glow.*right.*hand/.test(n)) return {role:'handEffect',side:'right'};
    if (/glow.*hand/.test(n)) return {role:'handEffect',side:/left|[-]l$/.test(n)?'left':'left'};
    if (/finger|палец/.test(n)) return {role:'finger',side:/right|[-]r$|прав/.test(n)?'right':'left'};
    if (/arm|hand|кисть|рук/.test(n)) return {role:'arm',side:/right|[-]r$|прав/.test(n)?'right':/left|[-]l$|лев/.test(n)?'left':null};
    if (/pistol|gun|weapon|пистолет|руж/.test(n)) return {role:'gun',side:/right|[-]r$|прав/.test(n)?'right':'left'};
    if (/card|карт/.test(n)) return {role:'card'};
    if (/torso|body|jilet|vest|bant|cloak|plash|тело|корпус|жилет|плащ/.test(n)) return {role:'body'};
    if (/glow|fx|свеч/.test(n)) return {role:'effect'};
    return {role:'other'};
  }
  function normalize(layers, canvas) {
    if (!Array.isArray(layers)||!layers.length) throw new Error('No source layers supplied');
    const used=new Set(),usedIds=new Set(),usedSourceIndices=new Set();
    // Draw order is a safe source-index fallback only when every layer has a
    // unique integer order. Synthetic/fractional orders must not alias indices.
    const stableOrder=layers.every(l=>l&&Number.isInteger(l.order)&&l.order>=0)&&
      new Set(layers.map(l=>l.order)).size===layers.length;
    const normalized=layers.map((l,i)=>{
      if (!l||typeof l!=='object'||typeof l.name!=='string'||!l.name.trim()) throw new Error('Every layer needs a name');
      if (used.has(l.name)) throw new Error('Duplicate layer name: '+l.name+'; retain unique PSD attachment names');
      used.add(l.name);
      // Preserve the original PSD layer-array index across raster filtering.
      const sourceIndex=Number.isInteger(l.sourceIndex)&&l.sourceIndex>=0?l.sourceIndex:
        stableOrder?l.order:i;
      if(usedSourceIndices.has(sourceIndex))
        throw new Error('Duplicate original PSD source index: '+sourceIndex);
      usedSourceIndices.add(sourceIndex);
      const id=typeof l.id==='string'&&l.id.trim()?l.id:'layer_'+sourceIndex;
      if(usedIds.has(id))throw new Error('Duplicate source layer ID: '+id);
      usedIds.add(id);
      const o={...l,index:sourceIndex,id};
      for (const k of ['left','top','width','height']) finite(o[k],l.name+'.'+k);
      if (o.width<=0||o.height<=0) throw new Error('Invalid layer dimensions: '+l.name);
      o.order=l.order===undefined?i:finite(l.order,'draw order');
      o.semantic=classify(l.name);
      return o;
    });
    normalized.sort((a,b)=>a.order-b.order||a.index-b.index);
    const bounds={left:Math.min(...normalized.map(l=>l.left)),top:Math.min(...normalized.map(l=>l.top)),
      right:Math.max(...normalized.map(l=>l.left+l.width)),bottom:Math.max(...normalized.map(l=>l.top+l.height))};
    let origin;
    if (canvas) {
      const width=finite(canvas.width,'canvas.width'),height=finite(canvas.height,'canvas.height');
      if (width<=0||height<=0) throw new Error('Invalid source canvas');
      origin={x:width/2,y:height/2};
    } else origin={x:(bounds.left+bounds.right)/2,y:(bounds.top+bounds.bottom)/2};
    for (const l of normalized) l.center={x:l.left+l.width/2-origin.x,y:origin.y-l.top-l.height/2};
    return {layers:normalized,bounds,origin};
  }
  function buildRig(inputLayers, plan, canvas, sceneIR) {
    if (!plan||typeof plan!=='object'||!plan.rig||typeof plan.rig!=='object') throw new Error('A structured rig plan is required');
    const sourceCanvas=canvas||
      (sceneIR&&sceneIR.source&&sceneIR.source.width&&sceneIR.source.height
        ?{width:sceneIR.source.width,height:sceneIR.source.height}
        :(inputLayers[0]?.canvas?{width:inputLayers[0].canvas.width,height:inputLayers[0].canvas.height}:undefined));
    const source=normalize(inputLayers,sourceCanvas);
    const {layers,origin,bounds}=source, rig=plan.rig;
    const rigMode=rig.mode||'rig';
    if(!['rig','layers'].includes(rigMode))throw new Error('Rig mode must be rig or layers');
    const layeredOnly=rigMode==='layers';
    const ikPlan=rig.armIK||{enabled:false,arms:[]};
    if(layeredOnly&&ikPlan.enabled)throw new Error('Layer-only mode cannot use anatomical IK');
    const wantsIK=ikPlan.enabled===true;
    const requested=wantsIK?(ikPlan.bothHands?['left','right']:(ikPlan.arms||[])):[];
    if (requested.some(s=>s!=='left'&&s!=='right')||new Set(requested).size!==requested.length) throw new Error('Invalid requested IK arms');
    if (wantsIK&&!requested.length) throw new Error('IK enabled but no arms were requested');
    if(wantsIK&&rig.boneHierarchy!==undefined)
      throw new Error('Explicit bone hierarchy and heuristic arm IK cannot be mixed in one build; use one validated rig strategy');
    let validatedBoneHierarchy=null;
    if(rig.boneHierarchy!==undefined){
      if(layeredOnly)throw new Error('Layer-only mode cannot use an anatomical bone hierarchy');
      if(!sceneIR)throw new Error('A Scene IR is required to validate the proposed bone hierarchy');
      const structureApi=typeof module==='object'&&module.exports?require('./bone-structure.js'):
        (typeof globalThis!=='undefined'?globalThis.SABoneStructure:null);
      if(!structureApi||typeof structureApi.validateHierarchy!=='function')
        throw new Error('Bone structure validator is unavailable');
      validatedBoneHierarchy=structureApi.validateHierarchy(sceneIR,rig.boneHierarchy);
    }
    const bones=[{name:'root'}], constraints=[], inferred=[], warnings=[];
    const roleLayers=role=>layers.filter(l=>l.semantic.role===role);
    const firstBody=roleLayers('body').find(l=>/torso|body|тело|корпус/i.test(l.name))||roleLayers('body')[0];
    const head=roleLayers('head').find(l=>/face|лиц/i.test(l.name))||roleLayers('head')[0];
    const add=(name,parent,x=0,y=0,extra={})=>{bones.push({name,parent,x,y,...extra});return name;};
    const bodyPoint=firstBody?firstBody.center:{x:0,y:0};
    if(!layeredOnly){
      add('body','root',bodyPoint.x,bodyPoint.y);
      if (head) add('head','body',head.center.x-bodyPoint.x,head.center.y-bodyPoint.y);
      add('cards_root','root'); add('effects_root','root');
    }
    const explicitBoneNames=new Map(),explicitLayerParents=new Map(),explicitBoneBindings=Object.create(null);
    if(validatedBoneHierarchy){
      const parentByChild=new Map(validatedBoneHierarchy.edges.map(edge=>[edge.childId,edge.parentId]));
      const pending=new Map(validatedBoneHierarchy.bones.map(bone=>[bone.id,bone]));
      while(pending.size){
        let progressed=false;
        for(const [boneId,bone] of [...pending]){
          const parentId=parentByChild.get(boneId);
          if(parentId&&!explicitBoneNames.has(parentId))continue;
          const name='bone_'+boneId.replace(/[^a-zA-Z0-9_]/g,'_');
          if(bones.some(existing=>existing.name===name))throw new Error('Duplicate generated anatomical bone name: '+name);
          const start={x:bone.start.x-origin.x,y:origin.y-bone.start.y};
          const end={x:bone.end.x-origin.x,y:origin.y-bone.end.y};
          const parentName=parentId?explicitBoneNames.get(parentId):'root';
          const matrices=worldMatrices(bones),parentMatrix=matrices[parentName];
          if(!parentMatrix)throw new Error('Missing validated anatomical parent bone: '+parentName);
          const localStart=inverse(parentMatrix,start),localEnd=inverse(parentMatrix,end);
          const parentEnd=parentId
            ?transform(parentMatrix,{x:bones.find(existing=>existing.name===parentName).length,y:0})
            :null;
          if(parentEnd&&distance(parentEnd,start)>1e-3)
            throw new Error('Anatomical bone endpoints do not meet at their declared hierarchy junction: '+boneId);
          // Derive the child transform entirely in parent-local coordinates.
          // Subtracting only the parent's first-column angle and retaining a
          // world-space length is wrong under non-uniform scale or affine shear.
          const localDx=localEnd.x-localStart.x,localDy=localEnd.y-localStart.y;
          const localLength=Math.hypot(localDx,localDy);
          if(localLength<1e-5)throw new Error('Degenerate anatomical bone candidate: '+boneId);
          const localRotation=Math.atan2(localDy,localDx)/RAD;
          add(name,parentName,localStart.x,localStart.y,{rotation:localRotation,length:localLength});
          explicitBoneNames.set(boneId,name);
          explicitBoneBindings[boneId]={name,parentName,start:{...start},end:{...end},length:localLength};
          pending.delete(boneId);progressed=true;
          for(const layerId of bone.sourceLayerIds||[]){
            const layer=layers.find(item=>item.id===layerId||item.name===layerId);
            if(!layer)throw new Error('Anatomical bone '+boneId+' references a layer absent from the rig input: '+layerId);
            const key=layer.id||layer.name;
            if(explicitLayerParents.has(key))throw new Error('Source layer is assigned to multiple anatomical bones: '+layerId);
            explicitLayerParents.set(key,name);
          }
        }
        if(!progressed)throw new Error('Anatomical bone hierarchy could not be ordered');
      }
      if(!explicitLayerParents.size)
        throw new Error('A proposed anatomical hierarchy must bind at least one source PSD layer before Rig Builder can emit a usable rig');
      warnings.push('Anatomical bone hierarchy was structurally validated, but semantic roles and parent-child direction remain model hypotheses.');
    }
    const arms={};
    const point=(l,px,py)=>({x:l.left+l.width*px-origin.x,y:origin.y-l.top-l.height*py});
    for (const side of requested) {
      const arm=layers.find(l=>l.semantic.role==='arm'&&l.semantic.side===side);
      const finger=layers.find(l=>l.semantic.role==='finger'&&l.semantic.side===side);
      const gun=layers.find(l=>l.semantic.role==='gun'&&l.semantic.side===side);
      // A gun alone does not prove that a separately animatable limb exists.
      if (!arm && !(finger&&gun)) {
        if (ikPlan.required) throw new Error('Missing '+side+' arm artwork: need a named arm/hand layer or finger plus weapon layers');
        warnings.push('Missing '+side+' arm artwork; that limb stays out of the motion.');
        continue;
      }
      const configured=(ikPlan.joints||rig.joints||{})[side];
      let shoulder,elbow,wrist;
      if (configured) {
        const space=configured.space||ikPlan.coordinateSpace||'psd';
        const read=name=>{
          const p=configured[name];if(!p)throw new Error('Missing '+side+' '+name+' joint');
          const x=finite(p.x,'joint.x'),y=finite(p.y,'joint.y');
          if (space==='world') return {x,y};
          if (space!=='psd') throw new Error('Joint coordinate space must be psd or world');
          return {x:x-origin.x,y:origin.y-y};
        };
        shoulder=read('shoulder');elbow=read('elbow');wrist=read('wrist');
      } else {
        if (!firstBody) throw new Error('Missing body layer for inferred '+side+' shoulder; provide explicit joints');
        shoulder=point(firstBody,side==='left'?.15:.85,.25);
        wrist=arm?point(arm,side==='left'?.38:.65,.62):finger.center;
        const reach=distance(shoulder,wrist);
        elbow={x:(shoulder.x+wrist.x)/2+(side==='left'?-1:1)*reach*.10,
          y:(shoulder.y+wrist.y)/2-reach*.20};
        inferred.push({side,method:'named-artwork bounds, anatomical positions unverified',shoulder,elbow,wrist,
          sourceLayers:[arm?.name,finger?.name,gun?.name].filter(Boolean)});
      }
      const upperLength=distance(shoulder,elbow),lowerLength=distance(elbow,wrist);
      if (upperLength<1e-5||lowerLength<1e-5) throw new Error('Degenerate '+side+' arm joints');
      const cross=(elbow.x-shoulder.x)*(wrist.y-shoulder.y)-(elbow.y-shoulder.y)*(wrist.x-shoulder.x);
      if (Math.abs(cross)<upperLength*lowerLength*1e-5) throw new Error('Collinear '+side+' arm joints; provide a bent setup elbow');
      const upperAngle=deg(shoulder,elbow),lowerAngle=deg(elbow,wrist);
      const upperBone='arm_'+side+'_upper',lowerBone='arm_'+side+'_lower',handBone='arm_'+side+'_hand',targetBone='arm_'+side+'_target';
      add(upperBone,'body',shoulder.x-bodyPoint.x,shoulder.y-bodyPoint.y,{rotation:upperAngle,length:upperLength});
      add(lowerBone,upperBone,upperLength,0,{rotation:lowerAngle-upperAngle,length:lowerLength});
      // Keep the hand's setup world orientation at zero while retaining wrist pivot.
      add(handBone,lowerBone,lowerLength,0,{rotation:-lowerAngle});
      add(targetBone,'root',wrist.x,wrist.y);
      constraints.push({type:'ik',name:'ik_arm_'+side,order:constraints.length,bones:[upperBone,lowerBone],target:targetBone,
        mix:1,softness:0,bendPositive:cross>0,stretch:false});
      let axis=90,muzzle=null;
      if(gun){muzzle=point(gun,.15,.08);axis=deg(wrist,muzzle);}
      const weapon=(rig.weapons||{})[side];
      if(weapon?.axisWorldDegrees!==undefined)axis=finite(weapon.axisWorldDegrees,'weapon axis');
      arms[side]={side,upperBone,lowerBone,handBone,targetBone,upperLength,lowerLength,bendPositive:cross>0,
        shoulderWorld:shoulder,elbowWorld:elbow,restTargetWorld:wrist,targetParentWorldAffine:[1,0,0,1,0,0],
        gunBone:null,gunLayer:gun?.name||null,gunAxisWorldDegrees:axis,gunRestAngleDegrees:axis,
        gunLocalAxisDegrees:axis,gunMuzzleWorld:muzzle,pivotsInferred:!configured};
    }
    // A stacked fan immediately between the right fingers and the right-hand
    // artwork is held, not thrown. Free cards elsewhere remain on cards_root.
    // Deliberate release can be requested with rig.cards.mode = 'free'.
    const heldCardNames=new Set();
    if(!layeredOnly&&arms.right&&rig.cards?.mode!=='free'){
      const handAt=layers.findIndex(l=>l.semantic.role==='arm'&&l.semantic.side==='right');
      const fingerAt=layers.findIndex(l=>l.semantic.role==='finger'&&l.semantic.side==='right');
      if(fingerAt>=0&&handAt>fingerAt+2&&handAt-fingerAt<=16){
        const fan=layers.slice(fingerAt+1,handAt);
        if(fan.length>=3&&fan.every(l=>l.semantic.role==='card')){
          for(const layer of fan)heldCardNames.add(layer.name);
        }
      }
    }
    const slots=[],attachments=Object.create(null),layerBindings=Object.create(null),cardBones=[],glowBones=[],glowSlotNames=[];
    let matrices=worldMatrices(bones);
    for (const layer of layers) {
      const {role,side}=layeredOnly?{role:'other',side:null}:layer.semantic;
      const arm=side&&arms[side];
      // Picture layers stay independent under root. Parenting them under body/head
      // made every layer ride one transform and look merged. Only active arm-IK
      // chains and explicit card/effect roots may group artwork.
      let parent=explicitLayerParents.get(layer.id||layer.name)||'root';
      if(!explicitLayerParents.has(layer.id||layer.name)&&arm&&['arm','finger','gun','handEffect'].includes(role))parent=arm.handBone;
      else if(!explicitLayerParents.has(layer.id||layer.name)&&!layeredOnly&&role==='card')parent=heldCardNames.has(layer.name)?arms.right.handBone:'cards_root';
      else if(!explicitLayerParents.has(layer.id||layer.name)&&!layeredOnly&&(role==='effect'||role==='handEffect'))parent='effects_root';
      if(side&&!arm&&['arm','finger','gun','handEffect'].includes(role))warnings.push('Layer '+layer.name+' is rigid because '+side+' IK was not requested');
      const name='b_'+layer.name;
      // Every picture bone is placed at its own source center in parent space.
      const local=inverse(matrices[parent],layer.center);
      add(name,parent,local.x,local.y);
      matrices=worldMatrices(bones);
      const m=matrices[name],center=inverse(m,layer.center);
      const angle=Math.atan2(m[2],m[0])/RAD;
      let attachment;
      if(role==='arm'&&arm) {
        // Whole arm artwork bends with the actual two-link IK chain. All grid
        // vertices bind through inverse matrices, preserving exact initial art.
        const positions=[[0,0],[0,.5],[0,1],[.5,1],[1,1],[1,.5],[1,0],[.5,0],[.5,.5]];
        const triangles=[0,1,8,0,8,7,1,2,3,1,3,8,7,8,5,7,5,6,8,3,4,8,4,5];
        validateSpineMeshHull(positions.flat(),8,triangles);
        // Spine Editor 4.3 import requires nonessential mesh edges to preserve
        // the exact topology. Edges reference even offsets into the UV array,
        // not 0-based vertex indices. Emit only existing triangle sides.
        const edges=[],edgeKeys=new Set();
        for(let t=0;t<triangles.length;t+=3){
          for(const [a,b] of [[triangles[t],triangles[t+1]],
                              [triangles[t+1],triangles[t+2]],
                              [triangles[t+2],triangles[t]]]){
            const low=Math.min(a,b),high=Math.max(a,b),key=low+':'+high;
            if(!edgeKeys.has(key)){edgeKeys.add(key);edges.push(low*2,high*2);}
          }
        }
        const chain=[arm.upperBone,arm.lowerBone,arm.handBone];
        const vertices=[];
        for(const [u,v]of positions){
          const p=point(layer,u,v);
          const candidates=chain.map(b=>({bone:b,d:distance(p,{x:matrices[b][4],y:matrices[b][5]})}));
          const exact=candidates.find(c=>c.d<1e-7);
          const weights=exact?[{bone:exact.bone,w:1}]:candidates.map(c=>({bone:c.bone,w:1/(c.d*c.d)}));
          const total=weights.reduce((sum,c)=>sum+c.w,0);
          vertices.push(weights.length);
          for(const c of weights){const q=inverse(matrices[c.bone],p);vertices.push(bones.findIndex(b=>b.name===c.bone),q.x,q.y,c.w/total);}
        }
        attachment={type:'mesh',uvs:positions.flat(),triangles,vertices,hull:8,edges,width:layer.width,height:layer.height};
      } else {
        attachment={type:'region',x:center.x,y:center.y,rotation:-angle,width:layer.width,height:layer.height};
      }
      // The slot name is the picture name. A folder prefix or a foreign id
      // makes Spine look for a different file, so the PSD image is not used.
      attachments[layer.name]={[layer.name]:attachment};
      const slot={name:layer.name,bone:name};if(layer.visible!==false)slot.attachment=layer.name;
      slots.push(slot);
      layerBindings[layer.name]={bone:name,parentBone:parent,role,side:side||null,center:{...layer.center},
        originalIndex:layer.index,drawOrder:layer.order,width:layer.width,height:layer.height,
        attachmentType:attachment.type,setupWorldAffine:[...m]};
      if(role==='card')cardBones.push(name);
      if(role==='effect'||role==='handEffect'){glowBones.push(name);glowSlotNames.push(layer.name);}
      if(role==='gun'&&arm&&!arm.gunBone){arm.gunBone=name;arm.gunLocalAxisDegrees=arm.gunAxisWorldDegrees-angle;}
    }
    for(const arm of Object.values(arms))if(!arm.gunBone)arm.gunBone=arm.handBone;
    const skeleton={skeleton:{spine:'4.3.26',x:bounds.left-origin.x,y:origin.y-bounds.bottom,
      width:bounds.right-bounds.left,height:bounds.bottom-bounds.top,images:'./images/',fps:30},
      bones,slots,constraints,skins:[{name:'default',attachments}],animations:{}};
    const context={origin,canvas:sourceCanvas||null,bounds,arms,layerBindings,cardBones,heldCardNames:[...heldCardNames],glowBones,glowSlotNames,
      bodyBone:layeredOnly?'root':'body',headBone:!layeredOnly&&head?'head':null,rigMode,technicalBonesOnly:layeredOnly,inferredPivots:inferred,warnings,
      anatomicalHierarchy:validatedBoneHierarchy?{status:validatedBoneHierarchy.status,hierarchyVerified:false,
        boneCount:validatedBoneHierarchy.bones.length,edgeCount:validatedBoneHierarchy.edges.length,
        boneNames:Object.fromEntries(explicitBoneNames),
        parentByChild:Object.fromEntries(validatedBoneHierarchy.edges.map(edge=>[edge.childId,edge.parentId]))}:null,
      anatomicalBoneBindings:explicitBoneBindings,
      setupWorldMatrices:matrices,sourceLayerOrder:layers.map(l=>l.name)};
    const invariants=checkSetup(skeleton,context);
    if(!invariants.ok)throw new Error('Source setup preservation failed: '+invariants.errors.join('; '));
    return {skeleton,context,invariants};
  }
  function checkSetup(skeleton,context,tolerance=1e-6){
    if(!skeleton||!Array.isArray(skeleton.bones)||!Array.isArray(skeleton.slots)||
      !Array.isArray(skeleton.skins)||!skeleton.skins.length||!Array.isArray(skeleton.constraints))
      throw new Error('Rig setup validation requires complete skeleton collections');
    if(!context||!context.setupWorldMatrices||typeof context.setupWorldMatrices!=='object'||
      Array.isArray(context.setupWorldMatrices)||!context.layerBindings||
      typeof context.layerBindings!=='object'||!Array.isArray(context.sourceLayerOrder))
      throw new Error('Rig setup validation requires bind matrices, layer bindings and source order');
    const errors=[],matrices=worldMatrices(skeleton.bones),boneNames=skeleton.bones.map(b=>b.name);
    let maxPositionError=0,maxRotationError=0;
    const measure=(actual,expected,label='Image setup position drift')=>{const e=distance(actual,expected);maxPositionError=Math.max(maxPositionError,e);if(e>tolerance)errors.push(label+' '+e);};
    const supplied=context.setupWorldMatrices;
    if(Object.keys(supplied).length!==skeleton.bones.length)
      errors.push('Setup matrix count differs from skeleton bone count');
    for(const bone of skeleton.bones){
      const expected=supplied[bone.name],actual=matrices[bone.name];
      if(!Array.isArray(expected)||expected.length!==6||expected.some(v=>!Number.isFinite(v))){
        errors.push('Missing or invalid setup matrix '+bone.name);continue;
      }
      if(expected.some((value,index)=>Math.abs(value-actual[index])>tolerance))
        errors.push('Setup matrix mismatch '+bone.name);
    }
    const skin=skeleton.skins.find(item=>item&&item.name==='default')||skeleton.skins[0];
    const attachmentGroups=skin&&skin.attachments;
    if(!attachmentGroups||typeof attachmentGroups!=='object'||Array.isArray(attachmentGroups))
      throw new Error('Rig setup validation requires a default skin attachment map');
    const slotByName=new Map();
    for(const slot of skeleton.slots){
      if(!slot||typeof slot.name!=='string'||slotByName.has(slot.name)||!matrices[slot.bone])
        errors.push('Invalid or duplicate setup slot '+(slot?.name||'<unnamed>'));
      else slotByName.set(slot.name,slot);
    }
    for(const [id,binding]of Object.entries(context.anatomicalBoneBindings||{})){
      const bone=skeleton.bones.find(item=>item.name===binding.name),matrix=matrices[binding.name];
      if(!bone||!matrix){errors.push('Missing anatomical bone '+id);continue;}
      if(bone.parent!==binding.parentName)errors.push('Anatomical bone parent mismatch '+id);
      if(Math.abs((bone.length||0)-binding.length)>tolerance)errors.push('Anatomical bone length mismatch '+id);
      measure(transform(matrix,{x:0,y:0}),binding.start,'Anatomical bone start drift '+id);
      measure(transform(matrix,{x:bone.length||0,y:0}),binding.end,'Anatomical bone end drift '+id);
    }
    for(const [name,binding]of Object.entries(context.layerBindings)){
      const slot=slotByName.get(name),group=attachmentGroups[name],a=group&&group[name];
      if(!slot||!a){errors.push('Missing source slot or attachment '+name);continue;}
      const m=matrices[slot.bone];
      if(a.type==='region'){
        if(![a.width,a.height].every(value=>typeof value==='number'&&Number.isFinite(value)&&value>0)){
          errors.push('Invalid source region dimensions '+name);continue;
        }
        measure(transform(m,{x:a.x||0,y:a.y||0}),binding.center);
        const rotation=Math.atan2(m[2],m[0])/RAD+(a.rotation||0);
        const e=Math.abs(Math.atan2(Math.sin(rotation*RAD),Math.cos(rotation*RAD))/RAD);maxRotationError=Math.max(maxRotationError,e);
        if(e>tolerance)errors.push('Image setup orientation drift '+name);
      }else{
        let cursor=0;
        for(let i=0;i<a.uvs.length;i+=2){
          const count=a.vertices[cursor++];let x=0,y=0,sum=0;
          for(let j=0;j<count;j++){
            const index=a.vertices[cursor++],lx=a.vertices[cursor++],ly=a.vertices[cursor++],w=a.vertices[cursor++];
            const p=transform(matrices[boneNames[index]],{x:lx,y:ly});x+=p.x*w;y+=p.y*w;sum+=w;
          }
          if(Math.abs(sum-1)>tolerance)errors.push('Invalid mesh weight sum '+name);
          measure({x,y},{x:binding.center.x+(a.uvs[i]-.5)*binding.width,y:binding.center.y+(.5-a.uvs[i+1])*binding.height});
        }
      }
    }
    if(skeleton.slots.map(s=>s.name).join('\0')!==context.sourceLayerOrder.join('\0'))errors.push('Draw order differs from PSD');
    for(const c of skeleton.constraints){
      if(c.type!=='ik'||c.bones.length!==2)continue;
      const upper=skeleton.bones.find(b=>b.name===c.bones[0]),lower=skeleton.bones.find(b=>b.name===c.bones[1]);
      const tip=transform(matrices[lower.name],{x:lower.length,y:0});
      const target=transform(matrices[c.target],{x:0,y:0});measure(tip,target);
      if(lower.parent!==upper.name||upper.length<=0||lower.length<=0)errors.push('Invalid two-bone IK chain');
    }
    return {ok:errors.length===0,errors,maxPositionError,maxRotationError,drawOrderPreserved:true,
      sourceArtworkPreserved:true,armIKCount:skeleton.constraints.filter(c=>c.type==='ik').length,
      anatomicalBoneCount:Object.keys(context.anatomicalBoneBindings||{}).length,
      anatomicalHierarchyPreserved:context.anatomicalHierarchy?errors.every(error=>!error.startsWith('Anatomical bone')):null};
  }
  return {buildRig,checkSetup,worldMatrices,inverse,transform,classify,validateSpineMeshHull};
});
