'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Vision=require('../engine/vision.js');
const Adapter=require('../engine/vision-scene-adapter.js');

function imageWithRegions(width,height,paint){
 const data=new Uint8ClampedArray(width*height*4);
 const set=(x,y)=>{data[(y*width+x)*4+3]=255;};
 paint(set);
 return {width,height,data};
}

test('enclosed transparent regions expose deterministic hole bounds and sample area',()=>{
 const image=imageWithRegions(20,18,set=>{
  for(let y=2;y<16;y++)for(let x=3;x<17;x++)
   if(!(x>=6&&x<14&&y>=5&&y<13))set(x,y);
 });
 const result=Vision.analyzePixels(image,{maxPixels:360,maxGraphPoints:10000});
 assert.equal(result.holeCount,1);
 assert.equal(result.holes.length,1);
 assert.deepEqual(result.holes[0].bounds,{left:6,top:5,right:14,bottom:13});
 assert.equal(result.holes[0].samplePixels,64);
 assert.equal(result.holes[0].estimatedSourcePixels,64);
});

test('open transparent notches touching the canvas are not reported as holes',()=>{
 const image=imageWithRegions(12,12,set=>{
  for(let y=2;y<10;y++)for(let x=2;x<10;x++)
   if(!(x<5&&y<6))set(x,y);
 });
 const result=Vision.analyzePixels(image,{maxPixels:144,maxGraphPoints:10000});
 assert.equal(result.holeCount,0);
 assert.deepEqual(result.holes,[]);
});

test('hole geometry and evidence are preserved as explicit Scene IR entities',()=>{
 const image=imageWithRegions(20,18,set=>{
  for(let y=2;y<16;y++)for(let x=3;x<17;x++)
   if(!(x>=6&&x<14&&y>=5&&y<13))set(x,y);
 });
 const pixels=Vision.analyzePixels(image,{maxPixels:360,maxGraphPoints:10000});
 const scene=Adapter.fromVision({source:{format:'image',width:20,height:18},
  layers:[{id:'layer.shape',left:0,top:0,width:20,height:18,order:0}]});
 const enriched=Adapter.withPixelTopology(scene,pixels);
 const hole=enriched.entities.find(entity=>entity.kind==='pixel-hole');
 assert.ok(hole);
 assert.deepEqual(hole.bounds,{x:6,y:5,width:8,height:8});
 assert.equal(hole.geometry.samplePixels,64);
 assert.ok(enriched.evidence.some(item=>item.kind==='enclosed-alpha-hole-bounds'&&item.entityId===hole.id));
 assert.equal(enriched.metadata.pixelTopology.holeCount,1);
});
