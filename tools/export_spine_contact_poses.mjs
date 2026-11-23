#!/usr/bin/env node
/**
 * Independently sample Spine 4.3 constraint-resolved contact poses from an
 * immutable export ZIP. This is a validator, NEVER a motion/animation generator.
 *
 * Usage: node tools/export_spine_contact_poses.mjs --bundle in.zip --out poses.json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import * as Spine from '@esotericsoftware/spine-core';

const FRAME_RATE=60;
const MAX_TIMES=3601;
const sha256=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const ensure=(ok,msg)=>{if(!ok)throw Error(msg);};
const nearly=(n)=>Number.isFinite(n) && Math.abs(n)<1e8;

export function collectTimes(animation) {
  let end=0;
  const keyed=new Set([0]);
  const visit=value=>{
    if(Array.isArray(value)){for(const v of value)visit(v);return;}
    if(!value||typeof value!=='object')return;
    if(Object.prototype.hasOwnProperty.call(value,'time')){
      const t=value.time;
      ensure(typeof t==='number' && Number.isFinite(t) && t>=0,
        'Invalid animation key time');
      keyed.add(t);end=Math.max(end,t);
    }
    for(const v of Object.values(value))visit(v);
  };
  for(const group of ['bones','slots','ik','transform','path','deform','physics'])
    visit(animation[group]||{});
  ensure(end<=90, 'Contact clip longer than 90 seconds');
  for(let i=0;i<=Math.floor(end*FRAME_RATE)+1;i++)
    keyed.add(Math.min(end,i/FRAME_RATE));
  const times=[...keyed].sort((a,b)=>a-b);
  ensure(times.length<=MAX_TIMES,'Too many contact samples');
  ensure(new Set(times.map(t=>t.toFixed(6))).size===times.length,
    'Unrepresentable closely-spaced sample keys');
  return times;
}

function parseZipInto(bundle,dir) {
  const list=spawnSync('unzip',['-Z1',bundle],{encoding:'utf8',maxBuffer:8*1024*1024});
  ensure(list.status===0, 'Unable to read ZIP central directory');
  const names=list.stdout.trim().split(/\r?\n/);
  ensure(names.length>=2 && names.length<=10000,'Invalid Spine ZIP inventory');
  ensure(new Set(names).size===names.length,'Duplicate ZIP file paths');
  for(const name of names){
    ensure(/^(skeleton\.json|skeleton\.atlas|images\/[A-Za-z0-9_.\/-]+\.png)$/.test(name) &&
      !name.split('/').some(p=>p==='.'||p==='..') && !name.includes('//'),
      'Unsafe or unexpected ZIP member '+name);
  }
  ensure(names.includes('skeleton.json')&&names.includes('skeleton.atlas'),
    'Missing Spine skeleton/atlas');
  const test=spawnSync('unzip',['-tqq',bundle],{encoding:'utf8'});
  ensure(test.status===0,'ZIP CRC verification failed');
  const extracted=spawnSync('unzip',['-qq',bundle,'-d',dir],{encoding:'utf8'});
  ensure(extracted.status===0,'ZIP extraction failed');
}
function atlasFor(p) {
  const atlas=new Spine.TextureAtlas(fs.readFileSync(p,'utf8'));
  // The geometry-only Spine runtime never draws: no GPU, raster alteration,
  // fake render, or replacement of the actual atlas page definitions.
  for(const page of atlas.pages)page.setTexture({
    setFilters(){},setWraps(){},getImage(){
      return {width:page.width,height:page.height};
    },dispose(){}
  });
  return atlas;
}
function transformPose(bone){
  const p=bone.appliedPose;
  ensure(p && [p.a,p.b,p.c,p.d,p.worldX,p.worldY].every(nearly),
    'Nonfinite Spine world matrix for '+bone.data.name);
  const m=[p.a,p.b,p.c,p.d,p.worldX,p.worldY];
  ensure(Math.abs(m[0]*m[3]-m[1]*m[2])>1e-9,
    'Singular Spine world matrix for '+bone.data.name);
  return m;
}
function toBoneLocal(m,x,y) {
  const det=m[0]*m[3]-m[1]*m[2];
  return [(m[3]*(x-m[4])-m[1]*(y-m[5]))/det,
    (-m[2]*(x-m[4])+m[0]*(y-m[5]))/det];
}
function readPose(data,clip,time) {
  const skeleton=new Spine.Skeleton(data);
  if(clip){
    const state=new Spine.AnimationState(new Spine.AnimationStateData(data));
    state.setAnimation(0,clip,false);
    state.update(time);
    state.apply(skeleton);
  }
  // The official 4.3 runtime applies IK, path and transform constraints here.
  skeleton.updateWorldTransform(Spine.Physics.update);
  const bones={};
  for(const bone of skeleton.bones)bones[bone.data.name]=transformPose(bone);
  const meshVertices={};
  const slotStates={};
  for(const slot of skeleton.slots){
    const name=slot.data.name;
    const attachment=slot.appliedPose.attachment;
    const alpha=(slot.appliedPose.color?.a??slot.color?.a??1)*
      (skeleton.color?.a??1);
    ensure(nearly(alpha)&&alpha>=0&&alpha<=1.001,
      'Invalid sampled slot alpha '+name);
    slotStates[name]={
      alpha:Math.min(1,alpha),
      visible:attachment!==null&&attachment!==undefined,
      attachment:attachment?.name??null
    };
    if(!(attachment instanceof Spine.MeshAttachment))continue;
    const count=attachment.worldVerticesLength;
    ensure(Number.isInteger(count)&&count>=6&&count%2===0&&count<250000,
      'Invalid weighted mesh vertex count for '+name);
    const world=new Float32Array(count);
    attachment.computeWorldVertices(skeleton,slot,0,count,world,0,2);
    const bone=slot.bone||skeleton.findBone(slot.data.boneData.name);
    ensure(bone,'Mesh slot bone unavailable: '+name);
    const m=bones[bone.data.name];
    ensure(m,'Mesh world-space bone unavailable: '+name);
    const local=[];
    for(let i=0;i<count;i+=2){
      ensure(nearly(world[i])&&nearly(world[i+1]),
        'Nonfinite computed mesh world vertex: '+name);
      local.push(...toBoneLocal(m,world[i],world[i+1]));
    }
    meshVertices[name]=local;
  }
  return {bones,meshVertices,slotStates};
}
export function sampleRuntimeEvidence({bundle,skeleton,atlas,output}) {
  ensure(fs.existsSync(bundle),'Input ZIP is missing');
  const zipHash=sha256(bundle);
  const source=JSON.parse(fs.readFileSync(skeleton,'utf8'));
  ensure(/^4\.3\./.test(source.skeleton?.spine||''),
    'Spine 4.3 JSON required; do not silently reinterpret versions');
  ensure(source.animations&&Object.keys(source.animations).length,
    'Spine bundle has no animation clips');
  ensure(!source.physics?.length &&
    !(source.constraints||[]).some(c=>c.type==='physics'),
    'Stateful physics must be sampled with sequential native playback');
  const data=new Spine.SkeletonJson(new Spine.AtlasAttachmentLoader(atlasFor(atlas)))
    .readSkeletonData(source);
  const setup=readPose(data,null,0);
  const report={
    schema:'spine-runtime-poses-v1',fps:FRAME_RATE,
    bundle_sha256:zipHash,
    runtime:'@esotericsoftware/spine-core',
    evaluated_after_constraints:true,
    source_skeleton_version:source.skeleton.spine,
    setup:setup.bones,clips:{},
    mesh_vertices:{setup:setup.meshVertices,clips:{}},
    slot_states:{setup:setup.slotStates,clips:{}}
  };
  for(const [name,animation] of Object.entries(source.animations)){
    const times=collectTimes(animation);
    report.clips[name]={};
    report.mesh_vertices.clips[name]={};
    report.slot_states.clips[name]={};
    for(const t of times){
      const key=t.toFixed(6);
      const pose=readPose(data,name,t);
      report.clips[name][key]=pose.bones;
      report.mesh_vertices.clips[name][key]=pose.meshVertices;
      report.slot_states.clips[name][key]=pose.slotStates;
    }
  }
  if(output){
    fs.mkdirSync(path.dirname(output),{recursive:true});
    fs.writeFileSync(output,JSON.stringify(report)+'\n',{flag:'wx'});
  }
  return report;
}
function cli(){
  const args=process.argv.slice(2);
  const read=(flag)=>{
    const n=args.indexOf(flag);
    ensure(n>=0&&args[n+1], 'Missing '+flag);
    return path.resolve(args[n+1]);
  };
  const bundle=read('--bundle'),output=read('--out');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'spine-contact-pose-'));
  try{
    parseZipInto(bundle,temp);
    const result=sampleRuntimeEvidence({
      bundle,skeleton:path.join(temp,'skeleton.json'),
      atlas:path.join(temp,'skeleton.atlas'),output
    });
    console.log('SPINE_CONTACT_POSES_SAMPLED',JSON.stringify({
      bundle_sha256:result.bundle_sha256,
      clips:Object.fromEntries(Object.entries(result.clips).map(([k,v])=>[k,Object.keys(v).length])),
      weighted_mesh_slots:Object.keys(result.mesh_vertices.setup),
      complete:true
    }));
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===
   path.resolve(new URL(import.meta.url).pathname))cli();
