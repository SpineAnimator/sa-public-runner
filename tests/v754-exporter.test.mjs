import test from "node:test";
import assert from "node:assert/strict";
import { parseV754Name, exportV754Spine } from "../tools/psd-spine/v754-exporter.mjs";

test("parses v7.54 tags without changing attachment name",()=>{
  const p=parseV754Name("Arm [bone:torso] [slot:arm] [trim:false]");
  assert.equal(p.cleanName,"Arm");
  assert.equal(p.values.get("bone"),"torso");
  assert.equal(p.values.get("trim"),"false");
});

test("preserves duplicate PSD layer names using stable internal slots and raster paths",()=>{
  const firstId="a".repeat(24),secondId="b".repeat(24);
  const layer=(id,index,imagePath,left)=>({
    name:"orn",kind:"pixel",visible:true,bounds:{left,top:4,right:left+10,bottom:14},
    imagePath,raster:{width:10,height:10,alpha_bounds:[0,0,10,10]},
    layerId:id,sourceIndexPath:[index],sourcePath:"orn"
  });
  const result=exportV754Spine({width:40,height:30,children:[
    layer(firstId,3,"layer_1.png",2),layer(secondId,4,"layer_2.png",18)
  ]},{padding:0});
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  assert.deepEqual(result.json.slots.map(slot=>slot.name),["orn","orn__src_"+secondId]);
  const attachments=result.json.skins[0].attachments;
  assert.ok(attachments.orn.orn);
  assert.ok(attachments["orn__src_"+secondId].orn);
  assert.deepEqual(result.rasters.map(item=>item.destination),[
    "orn.png","orn__src_"+secondId+".png"
  ]);
  assert.deepEqual(result.rasters.map(item=>item.sourceLayerName),["orn","orn"]);
  assert.ok(result.diagnostics.some(item=>item.code==="V754_DUPLICATE_SOURCE_NAME_DISAMBIGUATED"));
});

test("fails closed instead of renaming duplicate source layers without stable identity",()=>{
  const input={width:40,height:30,children:[
    {name:"orn",kind:"pixel",visible:true,bounds:{left:2,top:4,right:12,bottom:14},
     imagePath:"first.png",raster:{width:10,height:10,alpha_bounds:[0,0,10,10]}},
    {name:"orn",kind:"pixel",visible:true,bounds:{left:18,top:4,right:28,bottom:14},
     imagePath:"second.png",raster:{width:10,height:10,alpha_bounds:[0,0,10,10]}}
  ]};
  const originalNames=input.children.map(node=>node.name);
  const result=exportV754Spine(input,{padding:0});
  assert.equal(result.ok,false,JSON.stringify(result.diagnostics));
  assert.ok(result.diagnostics.some(d=>d.code==="V754_DUPLICATE_LAYER_ID_REQUIRED"), JSON.stringify(result.diagnostics));
  assert.deepEqual(input.children.map(node=>node.name),originalNames);
});

test("keeps explicit shared-slot duplicate attachment conflicts fail-closed",()=>{
  const layer=(id,index,imagePath,left)=>({
    name:"orn [slot:decor]",kind:"pixel",visible:true,bounds:{left,top:4,right:left+10,bottom:14},
    imagePath,raster:{width:10,height:10,alpha_bounds:[0,0,10,10]},
    layerId:id,sourceIndexPath:[index],sourcePath:"orn"
  });
  const result=exportV754Spine({width:40,height:30,children:[
    layer("a".repeat(24),3,"layer_1.png",2),layer("b".repeat(24),4,"layer_2.png",18)
  ]},{padding:0});
  assert.equal(result.ok,false);
  assert.ok(result.diagnostics.some(item=>item.code==="V754_DUPLICATE_ATTACHMENT"));
});

test("exports modern Spine 4.3 skin array and center-relative coordinates",()=>{
  const result=exportV754Spine({width:100,height:80,children:[
    {name:"Torso [bone]",isGroup:true,visible:true,bounds:{left:40,top:20,right:60,bottom:40},children:[
      {name:"Body [slot:body]",visible:true,bounds:{left:30,top:10,right:70,bottom:70},imagePath:"body.png"}
    ]}
  ]},{padding:0});
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  assert.equal(result.json.skeleton.spine,"4.3.0");
  assert.deepEqual(result.json.bones.map(b=>b.name),["root","Torso"]);
  assert.equal(result.json.bones[1].x,0);
  assert.equal(result.json.bones[1].y,0);
  assert.equal(result.json.slots[0].name,"body");
  assert.equal(result.json.slots[0].bone,"Torso");
  assert.equal(result.json.skins[0].name,"default");
  assert.ok(result.json.skins[0].attachments.body.Body);
});

test("rejects missing raster outputs instead of silently flattening",()=>{
  const result=exportV754Spine({width:10,height:10,children:[
    {name:"Layer",visible:true,bounds:{left:0,top:0,right:5,bottom:5}}
  ]});
  assert.equal(result.ok,false);
  assert.ok(result.diagnostics.some(d=>d.code==="V754_IMAGE_MISSING"));
});

test("exports v7.54 rectangular mesh with quad UVs and triangles",()=>{
  const result=exportV754Spine({width:10,height:10,children:[
    {name:"Part [mesh]",visible:true,bounds:{left:0,top:0,right:5,bottom:5},imagePath:"part.png"}
  ]},{padding:0});
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  const mesh=result.json.skins[0].attachments.Part.Part;
  assert.equal(mesh.type,"mesh");
  assert.deepEqual(mesh.vertices,[0,0,-5,0,-5,5,0,5]);
  assert.deepEqual(mesh.uvs,[1,1,0,1,0,0,1,0]);
  assert.deepEqual(mesh.triangles,[1,2,3,1,3,0]);
  assert.equal(mesh.hull,4);
  assert.deepEqual(mesh.edges,[0,2,2,4,4,6,0,6]);
  assert.equal(mesh.scaleX,undefined);
});

test("keeps linked mesh blocked until its source mesh is resolved",()=>{
  const result=exportV754Spine({width:10,height:10,children:[
    {name:"Variant [mesh:Base]",visible:true,bounds:{left:0,top:0,right:5,bottom:5},imagePath:"variant.png"}
  ]},{padding:0});
  assert.equal(result.ok,false);
  assert.ok(result.diagnostics.some(d=>d.code==="V754_LINKED_MESH_SOURCE_REQUIRED"));
});

test("inherits folder paths and keeps attachment name separate from [path:]",()=>{
  const result=exportV754Spine({width:20,height:20,children:[
    {name:"Characters [folder:actors]",isGroup:true,visible:true,children:[
      {name:"Hero [path:/atlas/hero]",visible:true,bounds:{left:2,top:2,right:8,bottom:8},imagePath:"hero.png"}
    ]}
  ]},{padding:0});
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  const skin=result.json.skins.find(x=>x.name==="default");
  assert.ok(skin.attachments.Hero["actors/Hero"]);
  assert.equal(skin.attachments.Hero["actors/Hero"].path,"atlas/hero");
  assert.equal(result.rasters[0].source,"hero.png");
  assert.equal(result.rasters[0].destination,"atlas/hero.png");
});

test("applies inherited name patterns and strips skin prefix from placeholder",()=>{
  const result=exportV754Spine({width:20,height:20,children:[
    {name:"Variant [skin:summer] [name:pre_*_v2]",isGroup:true,visible:true,children:[
      {name:"Hat",visible:true,bounds:{left:1,top:1,right:5,bottom:5},imagePath:"hat.png"}
    ]}
  ]},{padding:0});
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  const skin=result.json.skins.find(x=>x.name==="summer");
  assert.ok(skin.attachments["pre_Hat_v2"]);
  assert.equal(skin.attachments["pre_Hat_v2"]["pre_Hat_v2"].name,"summer/pre_Hat_v2");
  assert.equal(result.rasters[0].source,"hat.png");
  assert.equal(result.rasters[0].destination,"summer/pre_Hat_v2.png");
});

test("absolute folder resets inherited folder path",()=>{
  const result=exportV754Spine({width:20,height:20,children:[
    {name:"Outer [folder:outer]",isGroup:true,visible:true,children:[
      {name:"Inner [folder:/absolute]",isGroup:true,visible:true,children:[
        {name:"Part",visible:true,bounds:{left:1,top:1,right:5,bottom:5},imagePath:"part.png"}
      ]}
    ]}
  ]},{padding:0});
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  assert.ok(result.json.skins[0].attachments.Part["/absolute/Part"]);
});

test("every ordinary PSD group becomes a nested Spine bone",()=>{
  const result=exportV754Spine({width:100,height:80,children:[
    {name:"Character",isGroup:true,visible:true,children:[
      {name:"Arm",isGroup:true,visible:true,children:[
        {name:"Hand",visible:true,bounds:{left:60,top:20,right:80,bottom:40},imagePath:"hand.png"}
      ]}
    ]}
  ]},{padding:0});
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  assert.deepEqual(result.json.bones.map(b=>b.name),["root","Character","Arm"]);
  assert.equal(result.json.bones[2].parent,"Character");
  assert.equal(result.json.slots[0].bone,"Arm");
});

test("layer-level [bone] tag creates a bone below its nearest group",()=>{
  const result=exportV754Spine({width:100,height:80,children:[
    {name:"Character",isGroup:true,visible:true,children:[
      {name:"Arm [bone:arm-control]",visible:true,bounds:{left:60,top:20,right:80,bottom:40},imagePath:"arm.png"}
    ]}
  ]},{padding:0});
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  assert.deepEqual(result.json.bones.map(b=>b.name),["root","Character","arm-control"]);
  assert.equal(result.json.slots[0].bone,"arm-control");
});

test("skin name inherits parent folder and placeholder is relative to full skin path",()=>{
  const result=exportV754Spine({width:20,height:20,children:[
    {name:"Characters [folder:actors]",isGroup:true,visible:true,children:[
      {name:"Summer [skin]",isGroup:true,visible:true,children:[
        {name:"Hat",visible:true,bounds:{left:1,top:1,right:5,bottom:5},imagePath:"hat.png"}
      ]}
    ]}
  ]},{padding:0});
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  const skin=result.json.skins.find(x=>x.name==="actors/Summer");
  assert.ok(skin);
  assert.ok(skin.attachments.Hat.Hat);
  assert.equal(skin.attachments.Hat.Hat.name,"actors/Summer/Hat");
  assert.equal(result.rasters[0].source,"hat.png");
  assert.equal(result.rasters[0].destination,"actors/Summer/Hat.png");
});

test("applies layer scale to PNG dimensions and inverse Spine attachment scale",()=>{
  const result=exportV754Spine({width:100,height:80,children:[
    {name:"Scaled [scale:2]",visible:true,bounds:{left:10,top:10,right:30,bottom:20},
     imagePath:"scaled.png",raster:{width:20,height:10,alpha_bounds:[0,0,20,10]}}
  ]},{padding:0});
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  const attachment=result.json.skins[0].attachments.Scaled.Scaled;
  assert.equal(attachment.width,40);
  assert.equal(attachment.height,20);
  assert.equal(attachment.scaleX,0.5);
  assert.equal(attachment.scaleY,0.5);
  assert.equal(result.rasters[0].scale,2);
});

test("trims transparent borders and moves region center to alpha bounds",()=>{
  const result=exportV754Spine({width:100,height:80,children:[
    {name:"Trimmed",visible:true,bounds:{left:10,top:20,right:20,bottom:30},
     imagePath:"trimmed.png",raster:{width:10,height:10,alpha_bounds:[2,3,8,9]}}
  ]},{padding:0});
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  const attachment=result.json.skins[0].attachments.Trimmed.Trimmed;
  assert.equal(attachment.width,6);
  assert.equal(attachment.height,6);
  assert.equal(attachment.x,-35);
  assert.equal(attachment.y,14);
  assert.deepEqual(result.rasters[0].crop,[12,23,18,29]);
});

test("absolute attachment name bypasses inherited folder path",()=>{
  const result=exportV754Spine({width:20,height:20,children:[
    {name:"Actors [folder:actors]",isGroup:true,visible:true,children:[
      {name:"/Standalone",visible:true,bounds:{left:1,top:1,right:5,bottom:5},imagePath:"part.png"}
    ]}
  ]},{padding:0});
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  assert.ok(result.json.skins[0].attachments.Standalone.Standalone);
  assert.equal(result.rasters[0].destination,"Standalone.png");
});

test("rejects text and other non-pixel layers without a native raster payload",()=>{
  const result=exportV754Spine({width:10,height:10,children:[
    {name:"Text",kind:"type",visible:true,bounds:{left:0,top:0,right:5,bottom:5},imagePath:"text.png"}
  ]});
  assert.equal(result.ok,false);
  assert.ok(result.diagnostics.some(d=>d.code==="V754_LAYER_KIND_UNSUPPORTED"));
});

test("skips verified transparent layers without losing source-layer inventory",()=>{
  const result=exportV754Spine({width:10,height:10,children:[
    {name:"EmptyReference",kind:"pixel",visible:true,bounds:{left:0,top:0,right:10,bottom:10},
     layerId:"empty-layer-01",imagePath:"empty.png",raster:{width:10,height:10,alpha_bounds:null}}
  ]});
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  assert.equal(result.rasters.length,0);
  assert.equal(result.json.slots.length,0);
  assert.ok(result.diagnostics.some(d=>d.code==="V754_EMPTY_LAYER_SKIPPED"&&d.severity==="warning"));
});

test("exports Smart Object layers through their extracted embedded composite raster",()=>{
  const result=exportV754Spine({width:10,height:10,children:[
    {name:"SmartPart",kind:"smartobject",visible:true,bounds:{left:1,top:1,right:6,bottom:6},
     imagePath:"smart-part.png",raster:{width:5,height:5,alpha_bounds:[0,0,5,5]}}
  ]});
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  assert.ok(result.json.skins[0].attachments.SmartPart.SmartPart);
  assert.equal(result.rasters[0].source,"smart-part.png");
});

test("rejects Photoshop blend modes without a Spine-equivalent compositor",()=>{
  const result=exportV754Spine({width:10,height:10,children:[
    {name:"Part",kind:"pixel",blendMode:"colorDodge",visible:true,
     bounds:{left:0,top:0,right:5,bottom:5},imagePath:"part.png"}
  ]});
  assert.equal(result.ok,false);
  assert.ok(result.diagnostics.some(d=>d.code==="V754_BLEND_MODE_UNSUPPORTED"));
});

test("rejects a skin placeholder that collides with default skin attachment",()=>{
  const result=exportV754Spine({width:20,height:20,children:[
    {name:"Character [bone]",isGroup:true,visible:true,children:[
      {name:"DefaultPart",kind:"pixel",visible:true,bounds:{left:1,top:1,right:5,bottom:5},
       imagePath:"default.png",layerId:"a".repeat(24),sourceIndexPath:[0],sourcePath:"Character/DefaultPart"},
      {name:"DefaultPart [skin:summer]",kind:"pixel",visible:true,bounds:{left:1,top:1,right:5,bottom:5},
       imagePath:"variant.png",layerId:"b".repeat(24),sourceIndexPath:[1],sourcePath:"Character/DefaultPart"}
    ]}
  ]},{padding:0});
  assert.equal(result.ok,false,JSON.stringify(result.diagnostics));
  assert.ok(result.diagnostics.some(d=>d.code==="V754_SKIN_DEFAULT_PLACEHOLDER_COLLISION"), JSON.stringify(result.diagnostics));
});

test("hidden group visibility propagates to descendants and slot defaults",()=>{
  const result=exportV754Spine({width:20,height:20,children:[
    {name:"Hidden",isGroup:true,visible:false,effectiveVisible:false,children:[
      {name:"Part",visible:true,effectiveVisible:false,bounds:{left:1,top:1,right:5,bottom:5},imagePath:"part.png"}
    ]}
  ]},{padding:0});
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  assert.equal(result.json.slots[0].attachment,null);
  assert.equal(result.json.bones[1].x,0);
  assert.equal(result.json.bones[1].y,0);
});

test("ignoreHiddenLayers removes an effectively hidden group subtree",()=>{
  const result=exportV754Spine({width:20,height:20,children:[
    {name:"Hidden",isGroup:true,visible:false,effectiveVisible:false,children:[
      {name:"Part",visible:true,effectiveVisible:false,bounds:{left:1,top:1,right:5,bottom:5},imagePath:"part.png"}
    ]}
  ]},{padding:0,ignoreHiddenLayers:true});
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  assert.deepEqual(result.json.bones.map(b=>b.name),["root"]);
  assert.equal(result.json.slots.length,0);
});

test("rejects group opacity or blend changes without native group compositor",()=>{
  const result=exportV754Spine({width:20,height:20,children:[
    {name:"Faded",isGroup:true,visible:true,opacity:0.5,blendMode:"normal",children:[
      {name:"Part",visible:true,bounds:{left:1,top:1,right:5,bottom:5},imagePath:"part.png"}
    ]}
  ]},{padding:0});
  assert.equal(result.ok,false);
  assert.ok(result.diagnostics.some(d=>d.code==="V754_GROUP_COMPOSITING_UNSUPPORTED"));
});

test("does not emit bones for empty PSD groups",()=>{
  const result=exportV754Spine({width:20,height:20,children:[
    {name:"Empty",isGroup:true,visible:true,children:[]},
    {name:"Character",isGroup:true,visible:true,children:[
      {name:"Part",visible:true,bounds:{left:1,top:1,right:5,bottom:5},imagePath:"part.png"}
    ]}
  ]},{padding:0});
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  assert.deepEqual(result.json.bones.map(b=>b.name),["root","Character"]);
});

test("reused same-parent bone aggregates all visible group bounds",()=>{
  const result=exportV754Spine({width:100,height:80,children:[
    {name:"Body",isGroup:true,visible:true,children:[
      {name:"Left",visible:true,bounds:{left:0,top:10,right:10,bottom:20},imagePath:"left.png"}
    ]},
    {name:"Body",isGroup:true,visible:true,children:[
      {name:"Right",visible:true,bounds:{left:20,top:10,right:30,bottom:20},imagePath:"right.png"}
    ]}
  ]},{padding:0});
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  assert.equal(result.json.bones.length,2);
  assert.equal(result.json.bones[1].x,-35);
});

test("inherits [path:] from a parent PSD group",()=>{
  const result=exportV754Spine({width:20,height:20,children:[
    {name:"Folder [path:custom/hero]",isGroup:true,visible:true,children:[
      {name:"Hero",visible:true,bounds:{left:1,top:1,right:5,bottom:5},imagePath:"hero.png"}
    ]}
  ]},{padding:0});
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  const attachment=result.json.skins[0].attachments.Hero.Hero;
  assert.equal(attachment.path,"custom/hero");
  assert.equal(result.rasters[0].destination,"custom/hero.png");
});

test("rejects group path inheritance collisions instead of overwriting rasters",()=>{
  const result=exportV754Spine({width:20,height:20,children:[
    {name:"Folder [path:custom/shared]",isGroup:true,visible:true,children:[
      {name:"A",visible:true,bounds:{left:1,top:1,right:5,bottom:5},imagePath:"a.png"},
      {name:"B",visible:true,bounds:{left:6,top:1,right:10,bottom:5},imagePath:"b.png"}
    ]}
  ]},{padding:0});
  assert.equal(result.ok,false);
  assert.ok(result.diagnostics.some(d=>d.code==="V754_RASTER_PATH_COLLISION"));
});

test("rejects [name:] on a leaf layer because v7.54 permits it only on groups",()=>{
  const result=exportV754Spine({width:10,height:10,children:[
    {name:"Part [name:pre_*]",visible:true,bounds:{left:0,top:0,right:5,bottom:5},imagePath:"part.png"}
  ]});
  assert.equal(result.ok,false);
  assert.ok(result.diagnostics.some(d=>d.code==="V754_TAG_INVALID_CONTEXT"));
});

test("ignoreBackground removes the identified PSD background layer",()=>{
  const result=exportV754Spine({width:20,height:20,children:[
    {name:"Background",kind:"pixel",background:true,visible:true,bounds:{left:0,top:0,right:20,bottom:20},imagePath:"background.png"},
    {name:"Part",kind:"pixel",visible:true,bounds:{left:1,top:1,right:5,bottom:5},imagePath:"part.png"}
  ]},{padding:0,ignoreBackground:true});
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  assert.equal(result.json.slots.length,1);
  assert.equal(result.json.slots[0].name,"Part");
});

test("rejects enabled layer effects omitted by native raster compositor",()=>{
  const result=exportV754Spine({width:20,height:20,children:[
    {name:"Shadowed",kind:"pixel",hasEffects:true,visible:true,
     bounds:{left:1,top:1,right:5,bottom:5},imagePath:"shadowed.png"}
  ]},{padding:0});
  assert.equal(result.ok,false);
  assert.ok(result.diagnostics.some(d=>d.code==="V754_LAYER_EFFECTS_UNSUPPORTED"));
});

test("[merge] emits one group raster and suppresses child attachments",()=>{
  const result=exportV754Spine({width:100,height:80,children:[
    {name:"Merged [merge]",isGroup:true,visible:true,
     bounds:{left:10,top:10,right:40,bottom:40},imagePath:"merged.png",
     raster:{width:30,height:30,alpha_bounds:[0,0,30,30]},
     children:[{name:"Child",visible:true,bounds:{left:10,top:10,right:20,bottom:20},imagePath:"child.png"}]}
  ]},{padding:0});
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  assert.equal(result.json.slots.length,1);
  assert.equal(result.json.slots[0].name,"Merged");
  assert.equal(result.rasters.length,1);
  assert.equal(result.rasters[0].source,"merged.png");
});

test("matches v7.54 default padding and one-pixel trim border",()=>{
  const result=exportV754Spine({width:4,height:4,children:[
    {name:"Part",visible:true,bounds:{left:1,top:1,right:3,bottom:3},
     imagePath:"layer.png",raster:{width:2,height:2,alpha_bounds:[0,0,2,2]}}
  ]});
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  const attachment=result.json.skins[0].attachments.Part.Part;
  assert.equal(attachment.width,4);
  assert.equal(attachment.height,4);
  assert.deepEqual(result.rasters[0].crop,[1,1,5,5]);
  assert.equal(result.rasters[0].output.width,4);
});

test("preserves explicit PNG suffix in a literal [path:] value",()=>{
  const result=exportV754Spine({width:20,height:20,children:[
    {name:"Hero [path:/atlas/hero.png]",visible:true,
     bounds:{left:1,top:1,right:5,bottom:5},imagePath:"hero-source.png"}
  ]},{padding:0});
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  const attachment=result.json.skins[0].attachments.Hero.Hero;
  assert.equal(attachment.path,"atlas/hero.png");
  assert.equal(result.rasters[0].destination,"atlas/hero.png.png");
});

test("bone pivot ignores tagged ignored descendants",()=>{
  const result=exportV754Spine({width:100,height:80,children:[
    {name:"Character",isGroup:true,visible:true,children:[
      {name:"Ignored [ignore]",visible:true,bounds:{left:0,top:10,right:10,bottom:20},imagePath:"ignored.png"},
      {name:"Visible",visible:true,bounds:{left:20,top:10,right:30,bottom:20},imagePath:"visible.png"}
    ]}
  ]},{padding:0});
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  assert.equal(result.json.bones[1].x,-25);
});

test("bone pivot ignores background descendants when ignoreBackground is enabled",()=>{
  const result=exportV754Spine({width:100,height:80,children:[
    {name:"Character",isGroup:true,visible:true,children:[
      {name:"Background",kind:"pixel",background:true,visible:true,bounds:{left:0,top:0,right:100,bottom:80},imagePath:"background.png"},
      {name:"Visible",kind:"pixel",visible:true,bounds:{left:20,top:10,right:30,bottom:20},imagePath:"visible.png"}
    ]}
  ]},{padding:0,ignoreBackground:true});
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  assert.equal(result.json.bones[1].x,-25);
});

test("rejects clipping groups instead of exporting their children as independent images",()=>{
  const result=exportV754Spine({width:20,height:20,children:[
    {name:"Clipping",isGroup:true,clipping:true,visible:true,children:[
      {name:"Part",visible:true,bounds:{left:1,top:1,right:5,bottom:5},imagePath:"part.png"}
    ]}
  ]},{padding:0});
  assert.equal(result.ok,false);
  assert.ok(result.diagnostics.some(d=>d.code==="V754_RASTER_FEATURE_UNRESOLVED"));
});

test("[merge] rejects descendants whose visibility or effects cannot be represented",()=>{
  const result=exportV754Spine({width:20,height:20,children:[
    {name:"Merged [merge]",isGroup:true,visible:true,
     bounds:{left:0,top:0,right:10,bottom:10},imagePath:"merged.png",
     children:[{name:"Ignored [ignore]",kind:"pixel",visible:true,
       bounds:{left:0,top:0,right:5,bottom:5},imagePath:"ignored.png"}]}
  ]},{padding:0});
  assert.equal(result.ok,false);
  assert.ok(result.diagnostics.some(d=>d.code==="V754_MERGE_CHILD_TAG_UNSUPPORTED"));
});
