import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import rigModule from '../engine/rig.js';
import intentModule from '../engine/intent.js';
import motionModule from '../engine/motion.js';
import {createAtlas,makeStoredZip} from '../tools/package_clgb71_ik.mjs';
import {collectTimes,sampleRuntimeEvidence} from '../tools/export_spine_contact_poses.mjs';

// The source-preserving engine deliberately uses CommonJS/UMD exports.
// ESM named-export detection is not reliable for those dynamic wrappers.
const {buildRig}=rigModule;
const {compileIntent}=intentModule;
const {buildMotions}=motionModule;

const art=[
  {name:'GS_torso',left:100,top:100,width:200,height:300,order:2},
  {name:'GS_head_face',left:150,top:20,width:80,height:100,order:5},
  {name:'GS_pistol',left:0,top:80,width:100,height:200,order:3},
  {name:'GS_finger',left:35,top:190,width:35,height:40,order:4},
  {name:'GS_hand-right',left:260,top:160,width:150,height:170,order:1},
  {name:'GS_card-1',left:340,top:180,width:40,height:70,order:6},
  {name:'GS_glow',left:-5,top:-10,width:430,height:450,order:0}
];
function fixture(dir){
  const plan=compileIntent('Создай 2 анимации выстрела вверх с IK на обе руки');
  const rig=buildRig(art,plan,{width:420,height:420});
  rig.skeleton.animations=buildMotions(rig.skeleton,rig.context,plan);
  const atlas=createAtlas(art);
  const skeleton=path.join(dir,'skeleton.json'),atlasPath=path.join(dir,'skeleton.atlas');
  fs.writeFileSync(skeleton,JSON.stringify(rig.skeleton));
  fs.writeFileSync(atlasPath,atlas);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/h9sAAAAASUVORK5CYII=','base64');
  const files=[['skeleton.json',Buffer.from(fs.readFileSync(skeleton))],
    ['skeleton.atlas',Buffer.from(atlas)],
    ...art.map(layer=>['images/'+layer.name+'.png',png])];
  const bundle=path.join(dir,'input.zip');
  fs.writeFileSync(bundle,makeStoredZip(files));
  return {bundle,skeleton,atlas:atlasPath,rig};
}
test('recursive sample schedule covers every key and 60 Hz grid',()=>{
  const times=collectTimes({bones:{root:{translate:[
    {time:0,x:0},{time:.5,x:1},{time:1,x:0}]}},
    deform:{default:{mesh:{mesh:[{time:.75,vertices:[1]}]}}}});
  assert.ok(times.length>=61);
  assert.ok(times.some(t=>Math.abs(t-.75)<1e-8));
  assert.throws(()=>collectTimes({bones:{x:{rotate:[{time:91,value:0}]}}}),/longer than 90/);
});
test('official Spine runtime samples real after-IK matrices and weighted mesh vertices',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'spine-pose-test-'));
  try{
    const v=fixture(dir);
    const out=path.join(dir,'result.json');
    const data=sampleRuntimeEvidence({...v,output:out});
    assert.equal(data.schema,'spine-runtime-poses-v1');
    assert.equal(data.fps,60);
    assert.equal(data.evaluated_after_constraints,true);
    assert.equal(data.source_skeleton_version,'4.3.26');
    assert.equal(data.bundle_sha256.length,64);
    const clips=Object.keys(data.clips);
    assert.deepEqual(clips,['shoot_up_01','shoot_up_02']);
    const slot='GS_hand-right';
    assert.equal(data.mesh_vertices.setup[slot].length,18,
      'weighted mesh has nine actual vertices');
    for(const clip of clips){
      assert.ok(Object.keys(data.clips[clip]).length>=120);
      for(const frame of Object.keys(data.clips[clip])){
        const bones=data.clips[clip][frame];
        assert.ok(Array.isArray(bones.arm_right_hand) && bones.arm_right_hand.length===6);
        assert.equal(data.mesh_vertices.clips[clip][frame][slot].length,18);
        assert.equal(data.slot_states.clips[clip][frame].GS_pistol.visible,true);
      }
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(out,'utf8')).bundle_sha256,
      data.bundle_sha256);
    const beginning=data.clips[clips[0]]['0.000000'];
    const midway=data.clips[clips[0]]['0.500000'];
    assert.notDeepEqual(beginning.arm_left_hand,midway.arm_left_hand,
      'world matrix reflects actual constraint-solved hand motion');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
