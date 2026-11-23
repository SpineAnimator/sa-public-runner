/**
 * PhotoshopToSpine v7.54 semantic exporter core.
 * Input is a normalized PSD/PSB layer tree; no Photoshop or ExtendScript runtime.
 */
const TAG_RE = /\[([^\]]+)\]/g;
export function parseV754Name(name = "") {
  const tags = [...String(name).matchAll(TAG_RE)].map(m => m[1].trim());
  const cleanName = String(name).replace(TAG_RE, "").trim();
  const values = new Map();
  for (const tag of tags) {
    const i = tag.indexOf(":");
    values.set((i < 0 ? tag : tag.slice(0, i)).toLowerCase(),
      i < 0 ? true : tag.slice(i + 1).trim());
  }
  return {cleanName,tags,values};
}
const VALID = new Set(["bone","slot","skin","folder","ignore","overlay","trim","mesh","path","scale","merge","name"]);
function parseTagOwner(nodes,key) {
  for(let i=nodes.length-1;i>=0;i--){
    const p=parseV754Name(nodes[i].name);
    if(p.values.has(key)) return {value:p.values.get(key),name:p.cleanName};
  }
  return null;
}
function tag(p,k){return p.values.has(k)?p.values.get(k):null;}
function safeName(v,path,diagnostics){
  const n=String(v??"").trim();
  if(!n||n.length>255||/[\\:"*?<>|\u0000-\u001f]/.test(n)||/^\.+$/.test(n)||/^__drag$/i.test(n)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(n)){
    diagnostics.push({severity:"error",code:"V754_INVALID_NAME",path,message:"Empty, reserved, overlong, or invalid Spine name"});return "unnamed";
  }
  return n;
}
function sourceLayerDisambiguator(node){
  if(typeof node.layerId==="string"&&/^[a-f0-9]{24}$/i.test(node.layerId))return node.layerId.toLowerCase();
  const indexPath=node.sourceIndexPath;
  if(Array.isArray(indexPath)&&indexPath.length&&indexPath.every(n=>Number.isInteger(n)&&n>=0))
    return indexPath.map(n=>n.toString(36)).join("_");
  return null;
}
function tagOwner(chain,key){
  for(let i=chain.length-1;i>=0;i--){const p=parseV754Name(chain[i].name);if(p.values.has(key))return {node:chain[i],value:p.values.get(key),name:p.cleanName};}
  return null;
}
function ownerValue(owner){
  return owner&&(owner.value===true||owner.value==="")?owner.name:owner?.value;
}
function inheritedFolders(chain){
  let out=[];
  for(let i=0;i<chain.length;i++){
    const p=parseV754Name(chain[i].name);
    const key=p.values.has("folder")?"folder":p.values.has("skin")?"skin":null;
    if(!key)continue;
    const value=p.values.get(key);
    if(key==="skin"&&String(value===true?p.cleanName:value).toLowerCase()==="default")continue;
    const folder=String(value===true||value===""?p.cleanName:value);
    if(folder)out.push(folder);
    if(String(value).startsWith("/"))out=folder?[folder]:[];
  }
  return out;
}
function applyNamePatterns(chain,name,path,diagnostics){
  let out=name;
  for(let i=chain.length-1;i>=0;i--){
    const p=parseV754Name(chain[i].name);
    if(!p.values.has("name"))continue;
    const pattern=String(p.values.get("name"));
    const star=pattern.indexOf("*");
    if(star<0){diagnostics.push({severity:"error",code:"V754_INVALID_NAME_PATTERN",path,message:"[name:pattern] must contain *"});continue;}
    out=pattern.slice(0,star)+out+pattern.slice(star+1);
  }
  return out;
}
function isVisible(node){
  return node.effectiveVisible===undefined?node.visible!==false:node.effectiveVisible!==false;
}
function boundsOf(node){
  const b=node.bounds||{},left=Number(b.left??0),top=Number(b.top??0),right=Number(b.right??left),bottom=Number(b.bottom??top);
  return {left,top,right,bottom,width:right-left,height:bottom-top};
}
function visibleSubtreeBounds(node,cfg={}){
  if(!isVisible(node)) return null;
  const parsed=parseV754Name(node.name);
  if(tag(parsed,"ignore")!==null||(cfg.ignoreBackground&&node.background)||node.clipping||node.adjustment||node.hasEffects)return null;
  if(!node.isGroup&&!["pixel","smartobject"].includes(String(node.kind??"pixel").toLowerCase()))return null;
  const own=boundsOf(node);
  if(!node.isGroup) return own;
  if(tag(parsed,"merge")!==null) return own;
  let result=null;
  for(const child of node.children||[]){
    const b=visibleSubtreeBounds(child,cfg);if(!b)continue;
    result=result?{left:Math.min(result.left,b.left),top:Math.min(result.top,b.top),
      right:Math.max(result.right,b.right),bottom:Math.max(result.bottom,b.bottom)}:{left:b.left,top:b.top,right:b.right,bottom:b.bottom};
  }
  return result?{...result,width:result.right-result.left,height:result.bottom-result.top}:null;
}
function validateMergeSubtree(node,path,cfg,diagnostics){
  for(const child of node.children||[]){
    const childPath=path+"/"+child.name;
    const p=parseV754Name(child.name);
    if(tag(p,"ignore")!==null||tag(p,"overlay")!==null||tag(p,"mesh")!==null||tag(p,"merge")!==null)
      diagnostics.push({severity:"error",code:"V754_MERGE_CHILD_TAG_UNSUPPORTED",path:childPath,message:"Ignored, overlay, mesh or nested-merge tags cannot be resolved inside a native group merge"});
    if(child.clipping||child.adjustment||child.hasEffects)
      diagnostics.push({severity:"error",code:"V754_MERGE_CHILD_COMPOSITING_UNSUPPORTED",path:childPath,message:"Clipping, adjustment or layer effects inside [merge] require Photoshop-compatible compositing"});
    if(!child.isGroup&&String(child.kind??"pixel").toLowerCase()!=="pixel")
      diagnostics.push({severity:"error",code:"V754_MERGE_CHILD_KIND_UNSUPPORTED",path:childPath,message:"Non-pixel child inside [merge] cannot be rendered with verified parity"});
    if(child.isGroup){
      const opacity=Number(child.opacity??1);
      if(opacity!==1||(child.blendMode&&child.blendMode!=="normal"))
        diagnostics.push({severity:"error",code:"V754_MERGE_CHILD_GROUP_MODE_UNSUPPORTED",path:childPath,message:"Nested group opacity or blend mode inside [merge] is unsupported"});
      validateMergeSubtree(child,childPath,cfg,diagnostics);
    }
    if(cfg.ignoreBackground&&child.background)
      diagnostics.push({severity:"error",code:"V754_MERGE_BACKGROUND_UNSUPPORTED",path:childPath,message:"Background layers inside [merge] cannot be removed from the isolated group composite"});
  }
}
export function exportV754Spine(document,options={}){
  const cfg={scale:1,padding:1,trimWhitespace:true,ignoreHiddenLayers:false,ignoreBackground:true,...options};
  const diagnostics=[],width=Number(document.width),height=Number(document.height);
  if(!(width>0&&height>0))throw new TypeError("PSD document width/height must be positive");
  if(!(cfg.scale>0&&cfg.scale<=4))throw new RangeError("scale must be > 0 and <= 4");
  if(!Number.isInteger(cfg.padding)||cfg.padding<0||cfg.padding>1024)throw new RangeError("padding must be an integer between 0 and 1024");
  const bones=new Map([["root",{name:"root",parent:null,x:0,y:0,children:[],bounds:null}]]);
  const includeBoneBounds=(bone,bb)=>{
    if(!bb)return;
    const old=bone.bounds;
    bone.bounds=old?{left:Math.min(old.left,bb.left),top:Math.min(old.top,bb.top),
      right:Math.max(old.right,bb.right),bottom:Math.max(old.bottom,bb.bottom)}:
      {left:bb.left,top:bb.top,right:bb.right,bottom:bb.bottom};
    bone.x=((bone.bounds.left+bone.bounds.right)/2-width/2)*cfg.scale;
    bone.y=(height/2-(bone.bounds.top+bone.bounds.bottom)/2)*cfg.scale;
  };
  const slots=new Map(),skins=new Map(),emitted=[];
  const walk=(nodes,ancestors=[],currentBone="root",folders=[],skinName="default")=>{
    for(const node of nodes||[]){
      const path=[...ancestors.map(n=>n.name),node.name].join("/");
      const p=parseV754Name(node.name),chain=[...ancestors,node];
      for(const t of p.tags){
        const k=t.split(":",1)[0].toLowerCase();
        if(!VALID.has(k))diagnostics.push({severity:"error",code:"V754_INVALID_TAG",path,message:"Unknown v7.54 tag ["+t+"]"});
        if(k==="name"&&!node.isGroup)diagnostics.push({severity:"error",code:"V754_TAG_INVALID_CONTEXT",path,message:"[name:pattern] is valid only on PSD groups"});
        if(k==="overlay")diagnostics.push({severity:"error",code:"V754_OVERLAY_NOT_IMPLEMENTED",path,message:"[overlay] requires the native mask compositor; export blocked"});
        
      }
      if(tag(p,"ignore")!==null)continue;
      if(cfg.ignoreHiddenLayers&&!isVisible(node))continue;
      if(cfg.ignoreBackground&&node.background)continue;
      let boneName=currentBone;
      if(node.hasEffects)diagnostics.push({severity:"error",code:"V754_LAYER_EFFECTS_UNSUPPORTED",path,message:"Enabled Photoshop layer effects are not included in native raster output"});
      if(node.clipping||node.adjustment){
        diagnostics.push({severity:"error",code:"V754_RASTER_FEATURE_UNRESOLVED",path,message:"Clipping/adjustment layer requires native raster compositor support"});
        continue;
      }
      if(node.isGroup){
        const groupOpacity=Number(node.opacity??1);
        if(groupOpacity!==1||(node.blendMode&&node.blendMode!=="normal"))
          diagnostics.push({severity:"error",code:"V754_GROUP_COMPOSITING_UNSUPPORTED",path,message:"Group opacity/blend mode requires Photoshop-compatible group compositing"});
        const groupName=parseV754Name(node.name);
        const rawBone=tag(groupName,"bone")??tag(groupName,"folder");
        const candidate=rawBone===null?groupName.cleanName:String(rawBone===true||rawBone===""?groupName.cleanName:rawBone);
        const resolved=safeName(candidate||"bone",path,diagnostics);
        const parent=bones.get(currentBone)||bones.get("root");
        const bb=visibleSubtreeBounds(node,cfg);
        if(bones.has(resolved)){
          const existing=bones.get(resolved);
          if(existing.parent!==parent.name)diagnostics.push({severity:"error",code:"V754_DUPLICATE_BONE_PARENT",path,message:"Bone name is reused under a different parent: "+resolved});
          else includeBoneBounds(existing,bb);
        }else{
          const created={name:resolved,parent:parent.name,x:0,y:0,children:[],bounds:null};
          includeBoneBounds(created,bb);
          bones.set(resolved,created);parent.children.push(resolved);
        }
        boneName=resolved;
      }else{
        const explicitBone=tagOwner(chain,"bone")||tagOwner(chain,"folder");
        if(explicitBone&&explicitBone.node===node){
          const resolved=safeName(ownerValue(explicitBone),path,diagnostics);
          const parent=bones.get(currentBone)||bones.get("root");
          const bb=visibleSubtreeBounds(node);
          if(bones.has(resolved)){
            const existing=bones.get(resolved);
            if(existing.parent!==parent.name)diagnostics.push({severity:"error",code:"V754_DUPLICATE_BONE_PARENT",path,message:"Bone name is reused under a different parent: "+resolved});
            else includeBoneBounds(existing,bb);
          }else{
            const created={name:resolved,parent:parent.name,x:0,y:0,children:[],bounds:null};
            includeBoneBounds(created,bb);
            bones.set(resolved,created);parent.children.push(resolved);
          }
          boneName=resolved;
        }
      }
      const nextFolders=inheritedFolders(chain);
      const skinOwner=tagOwner(chain,"skin");
      let nextSkin="default";
      if(skinOwner){
        const rawSkin=String(ownerValue(skinOwner));
        const skinPrefix=rawSkin.startsWith("/")?"":inheritedFolders(chain.slice(0,chain.indexOf(skinOwner.node))).join("/");
        nextSkin=(skinPrefix?skinPrefix+"/":"")+rawSkin.replace(/^\//,"");
        if(nextSkin.toLowerCase()==="default")diagnostics.push({severity:"error",code:"V754_RESERVED_DEFAULT_SKIN",path,message:'Skin name "default" is reserved'});
      }
      if(node.isGroup){
        if(tag(p,"merge")!==null){
          validateMergeSubtree(node,path,cfg,diagnostics);
          if(!node.imagePath)diagnostics.push({severity:"error",code:"V754_MERGE_RASTER_REQUIRED",path,message:"[merge] group requires a native merged group raster"});
          else emitted.push({node,path,p,chain,boneName,folders:nextFolders,skinName:nextSkin,slotOwner:tagOwner(chain,"slot")});
        }else walk(node.children||[],chain,boneName,nextFolders,nextSkin);
        continue;
      }
      const layerKind=String(node.kind??"pixel").toLowerCase();
      const rasterBackedKind=layerKind==="pixel"||layerKind==="smartobject";
      if(!rasterBackedKind||(layerKind==="smartobject"&&(!node.imagePath||!node.raster))){
        diagnostics.push({severity:"error",code:"V754_LAYER_KIND_UNSUPPORTED",path,
          message:"Layer kind requires a verified native raster payload: "+layerKind});
        continue;
      }
      if(!isVisible(node)&&cfg.ignoreHiddenLayers)continue;
      emitted.push({node,path,p,chain,boneName,folders:nextFolders,skinName:nextSkin,slotOwner:tagOwner(chain,"slot")});
    }
  };
  walk(document.children||[]);
  const skinMap=new Map(),slotOrder=[],rasterMappings=[];
  for(const item of emitted){
    const {node,path,p,boneName,folders,skinName,slotOwner}=item;
    if(!node.imagePath){diagnostics.push({severity:"error",code:"V754_IMAGE_MISSING",path,message:"Raster stage did not provide imagePath"});continue;}
    let raw=p.cleanName||"attachment";
    raw=applyNamePatterns((item.chain||[]).filter(n=>n.isGroup),raw,path,diagnostics);
    const baseName=raw.startsWith("/")?raw.slice(1):raw;
    let slotName=safeName(slotOwner?ownerValue(slotOwner):baseName,path,diagnostics);
    const skin=safeName(skinName,path,diagnostics);
    const attachmentName=raw.startsWith("/")?baseName:[...folders,raw].filter(Boolean).join("/");
    const pathOwner=tagOwner(item.chain||[],"path");
    const usePathTag=Boolean(pathOwner);
    const pathValue=usePathTag?String(ownerValue(pathOwner)):attachmentName;
    let imagePath;
    if(!usePathTag)imagePath=attachmentName.replace(/^\\/+/, "");
    else if(pathValue.startsWith("/"))imagePath=pathValue.slice(1);
    else imagePath=[...folders,pathValue].filter(Boolean).join("/").replace(/^\\/+/, "");
    const placeholderName=skin==="default"?attachmentName:attachmentName.slice(skin.length+1);
    const existingSlot=slots.get(slotName);
    const existingBucket=skinMap.get(skin)?.get(slotName);
    const duplicatePlaceholder=Boolean(existingBucket&&Object.prototype.hasOwnProperty.call(existingBucket,placeholderName));
    const slotBoneCollision=Boolean(existingSlot&&existingSlot.bone!==boneName);
    if((duplicatePlaceholder||slotBoneCollision)&&!slotOwner){
      const suffix=sourceLayerDisambiguator(node);
      if(!suffix){
        diagnostics.push({severity:"error",code:"V754_DUPLICATE_LAYER_ID_REQUIRED",path,
          message:"Cannot preserve duplicate source layer names without a stable layerId or structural sourceIndexPath"});
        continue;
      }
      const stem="__src_"+suffix;
      slotName=safeName(slotName.slice(0,Math.max(1,255-stem.length))+stem,path,diagnostics);
      if(!usePathTag)imagePath+=stem;
      if(slots.has(slotName)||(skinMap.get(skin)?.has(slotName))){
        diagnostics.push({severity:"error",code:"V754_DUPLICATE_LAYER_ID",path,
          message:"Stable source layer identity did not produce a unique internal Spine slot"});
        continue;
      }
      diagnostics.push({severity:"warning",code:"V754_DUPLICATE_SOURCE_NAME_DISAMBIGUATED",path,
        message:"Original PSD layer/attachment name retained; only the internal Spine slot and default raster path use stable source identity "+suffix});
    }
    if(skin!=="default"&&!attachmentName.startsWith(skin+"/")){
      diagnostics.push({severity:"error",code:"V754_SKIN_PATH_MISMATCH",path,message:"Attachment path must be nested under its skin name: "+skin});
      continue;
    }
    const bb=boundsOf(node);
    const trimOwner=tagOwner(item.chain||[],"trim");
    const trimValue=trimOwner?trimOwner.value:null;
    const trim=trimValue===null?cfg.trimWhitespace:trimValue!=="false";
    const scaleOwner=tagOwner(item.chain||[],"scale");
    const layerScale=scaleOwner?Number(scaleOwner.value===true?1:scaleOwner.value):1;
    if(!(layerScale>0&&layerScale<=4&&Number.isFinite(layerScale)))diagnostics.push({severity:"error",code:"V754_INVALID_SCALE",path,message:"[scale] must be finite and between 0 and 4"});
    const safeLayerScale=layerScale>0&&layerScale<=4&&Number.isFinite(layerScale)?layerScale:1;
    const factor=cfg.scale*safeLayerScale;
    if(Math.abs(factor-1)>1e-9)diagnostics.push({severity:"warning",code:"V754_RESAMPLING_NOT_PIXEL_VERIFIED",path,message:"Native Lanczos resampling is not pixel-verified against Photoshop's resize engine"});
    const hasAlphaBounds=node.raster&&Object.prototype.hasOwnProperty.call(node.raster,"alpha_bounds");
    const alpha=Array.isArray(node.raster?.alpha_bounds)?node.raster.alpha_bounds:[0,0,Number(node.raster?.width??bb.width),Number(node.raster?.height??bb.height)];
    if(trim&&node.raster&&hasAlphaBounds&&node.raster.alpha_bounds===null){
      diagnostics.push({severity:"warning",code:"V754_EMPTY_LAYER_SKIPPED",path,
        message:"Layer has a verified fully transparent raster; kept in the source inventory but omitted from Spine attachments"});
      continue;
    }
    if(trim&&node.raster&&(!hasAlphaBounds||alpha[2]<=alpha[0]||alpha[3]<=alpha[1])){
      diagnostics.push({severity:"error",code:"V754_EMPTY_RASTER_UNVERIFIED",path,message:"Raster alpha bounds are missing or invalid; cannot distinguish an empty layer from incomplete extraction"});
      continue;
    }
    const imageWidth=Math.max(1,Math.round(width*factor));
    const imageHeight=Math.max(1,Math.round(height*factor));
    const padTotal=Math.round(cfg.padding*2*safeLayerScale);
    const padLeft=Math.floor(padTotal/2),padTop=padLeft;
    const paddedWidth=imageWidth+padTotal,paddedHeight=imageHeight+padTotal;
    if(imageWidth>32768||imageHeight>32768||imageWidth*imageHeight>100000000||paddedWidth>32768||paddedHeight>32768||paddedWidth*paddedHeight>100000000){
      diagnostics.push({severity:"error",code:"V754_RASTER_LIMIT",path,message:"Full-canvas resampling exceeds safe raster limits"});continue;
    }
    const border=trim&&cfg.padding>0?1:0;
    let crop,left,top,w,h;
    if(trim){
      const sourceLeft=bb.left+alpha[0],sourceTop=bb.top+alpha[1];
      const sourceRight=bb.left+alpha[2],sourceBottom=bb.top+alpha[3];
      left=Math.max(0,Math.floor(sourceLeft*factor)+padLeft-border);
      top=Math.max(0,Math.floor(sourceTop*factor)+padTop-border);
      const right=Math.min(paddedWidth,Math.ceil(sourceRight*factor)+padLeft+border);
      const bottom=Math.min(paddedHeight,Math.ceil(sourceBottom*factor)+padTop+border);
      w=right-left;h=bottom-top;crop=[left,top,right,bottom];
    }else{
      left=0;top=0;w=paddedWidth;h=paddedHeight;crop=null;
    }
    const scaleX=width*cfg.scale/imageWidth,scaleY=height*cfg.scale/imageHeight;
    const bone=bones.get(boneName)||bones.get("root");
    const x=(left+w/2-padLeft)*scaleX-width*cfg.scale/2;
    const y=height*cfg.scale/2-(top+h/2-padTop)*scaleY;
    if(w<1||h<1||w>32768||h>32768||w*h>100000000){
      diagnostics.push({severity:"error",code:"V754_RASTER_LIMIT",path,message:"Scaled attachment exceeds safe raster limits"});continue;
    }
    const meshOwner=tagOwner(item.chain||[],"mesh");
    const meshSpec=meshOwner?(meshOwner.value===true||meshOwner.value===""?true:meshOwner.value):null;
    const attachment={type:"region",x:x-bone.x,y:y-bone.y,width:w,height:h};
    if(meshSpec===true){
      const meshWidth=w*scaleX,meshHeight=h*scaleY;
      const meshX=attachment.x-meshWidth/2,meshY=attachment.y+meshHeight/2;
      attachment.type="mesh";
      attachment.vertices=[meshX+meshWidth,meshY-meshHeight,meshX,meshY-meshHeight,
        meshX,meshY,meshX+meshWidth,meshY];
      attachment.uvs=[1,1,0,1,0,0,1,0];
      attachment.triangles=[1,2,3,1,3,0];
      attachment.hull=4;
      attachment.edges=[0,2,2,4,4,6,0,6];
    }else if(meshSpec!==null){
      diagnostics.push({severity:"error",code:"V754_LINKED_MESH_SOURCE_REQUIRED",path,
        message:"[mesh:name] linked mesh requires a verified source mesh in the same slot; export blocked"});
    }else{
      if(Math.abs(scaleX-1)>1e-9)attachment.scaleX=scaleX;
      if(Math.abs(scaleY-1)>1e-9)attachment.scaleY=scaleY;
    }
    if(attachmentName!==placeholderName)attachment.name=attachmentName;
    if(imagePath!==attachmentName)attachment.path=imagePath;
    const destination=imagePath+".png";
    const mapping={layerId:node.layerId??null,parentId:node.parentId??null,sourceIndexPath:node.sourceIndexPath??null,sourcePath:node.sourcePath??path,sourceLayerName:node.name??p.cleanName,source:node.imagePath,destination,trim,crop,bounds:bb,canvas:{width,height},scale:factor,padding:cfg.padding,safeLayerScale,padLeft,padTop,output:{width:w,height:h}};
    const collision=rasterMappings.find(m=>m.destination===destination);
    if(collision&&JSON.stringify(collision)!==JSON.stringify(mapping))
      diagnostics.push({severity:"error",code:"V754_RASTER_PATH_COLLISION",path,message:"Different raster operations resolve to the same PNG path: "+destination});
    else if(!collision)rasterMappings.push(mapping);

    if(node.blendMode==="linearDodge")item.blend="additive";
    else if(["multiply","screen"].includes(node.blendMode))item.blend=node.blendMode;
    else if(node.blendMode&&node.blendMode!=="normal")diagnostics.push({severity:"error",code:"V754_BLEND_MODE_UNSUPPORTED",path,message:"Unsupported Photoshop blend mode: "+node.blendMode});
    if(!slots.has(slotName)){slots.set(slotName,{name:slotName,bone:boneName,blend:item.blend,attachment:null});slotOrder.push(slotName);}
    else if(slots.get(slotName).bone!==boneName)diagnostics.push({severity:"error",code:"V754_SLOT_MULTIPLE_BONES",path,message:"Slot assigned to multiple bones: "+slotName});
    else if(slots.get(slotName).blend!==item.blend)diagnostics.push({severity:"error",code:"V754_SLOT_BLEND_MISMATCH",path,message:"Slot has inconsistent blend modes: "+slotName});
    if(!slots.get(slotName).attachment&&isVisible(node))slots.get(slotName).attachment=placeholderName;
    if(!skinMap.has(skin))skinMap.set(skin,new Map());
    if(!skinMap.get(skin).has(slotName))skinMap.get(skin).set(slotName,{});
    const bucket=skinMap.get(skin).get(slotName);
    if(bucket[placeholderName])diagnostics.push({severity:"error",code:"V754_DUPLICATE_ATTACHMENT",path,message:"Duplicate attachment placeholder "+placeholderName});
    else bucket[placeholderName]=attachment;
  }
  const defaultSlots=skinMap.get("default");
  if(defaultSlots){
    for(const [skinName,bySlot] of skinMap){
      if(skinName==="default")continue;
      for(const [slotName,attachments] of bySlot){
        const defaults=defaultSlots.get(slotName)||{};
        for(const placeholder of Object.keys(attachments)){
          if(defaults[placeholder])diagnostics.push({severity:"error",code:"V754_SKIN_DEFAULT_PLACEHOLDER_COLLISION",path:skinName+"/"+slotName,message:"Skin placeholder duplicates a default-skin attachment: "+placeholder});
        }
      }
    }
  }
  if(diagnostics.some(d=>d.severity==="error"))return {ok:false,diagnostics};
  const neededBones=new Set(["root"]);
  for(const item of emitted){
    let cursor=item.boneName;
    while(cursor&&!neededBones.has(cursor)){
      neededBones.add(cursor);
      cursor=bones.get(cursor)?.parent||null;
    }
  }
  const boneJson=[];
  const emitBone=name=>{
    if(!neededBones.has(name))return;
    const b=bones.get(name),out={name:b.name};
    if(b.parent){out.parent=b.parent;const parent=bones.get(b.parent);out.x=b.x-parent.x;out.y=b.y-parent.y;}
    else{out.x=b.x;out.y=b.y;}
    boneJson.push(out);for(const child of b.children)if(neededBones.has(child))emitBone(child);
  };
  for(const child of bones.get("root").children)emitBone(child);
  boneJson.unshift({name:"root"});
  const slotJson=slotOrder.map(n=>{const s=slots.get(n),out={name:s.name,bone:s.bone,attachment:s.attachment};if(s.blend)out.blend=s.blend;return out;});
  const skinJson=[...skinMap].map(([name,bySlot])=>({name,attachments:Object.fromEntries([...bySlot].map(([slot,attachments])=>[slot,attachments]))}));
  return {ok:true,diagnostics,rasters:rasterMappings,json:{skeleton:{hash:"",spine:"4.3.0",width,height,images:"images/"},
    bones:boneJson,slots:slotJson,skins:skinJson,animations:{}}};
}
