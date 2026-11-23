/* Smoke-test the REAL source PNG / multi-page atlas / IK JSON bundle,
 * not the synthetic atlas used to check the original PSD layer geometry.
 * Native Spine Editor import and visual rendering are not claimed here.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as R from '@esotericsoftware/spine-core';

const dir=process.argv[2];
if(!dir||process.argv.length!==3)throw Error('Usage: node tools/verify_clgb71_ik_package.mjs rig-package-directory');
const sk=JSON.parse(fs.readFileSync(path.join(dir,'skeleton.json'),'utf8'));
const atlasText=fs.readFileSync(path.join(dir,'skeleton.atlas'),'utf8');
const atlas=new R.TextureAtlas(atlasText);
assert.equal(atlas.pages.length,38,'expected 38 separate source texture atlas pages');
assert.equal(sk.slots.length,38,'expected all 38 original slots');
assert.equal(sk.constraints.filter(x=>x.type==='ik').length,2);
const pngSig=Buffer.from([137,80,78,71,13,10,26,10]);
const textures=new Set();
for(const page of atlas.pages){
  const pngPath=path.join(dir,page.name);
  const bytes=fs.readFileSync(pngPath);
  assert.ok(bytes.subarray(0,8).equals(pngSig),'actual PNG required: '+page.name);
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  assert.equal(width,page.width,'actual page width must match atlas: '+page.name);
  assert.equal(height,page.height,'actual page height must match atlas: '+page.name);
  textures.add(page.name);
  page.setTexture({setFilters(){},setWraps(){},getImage(){return {width,height}},dispose(){}});
}
assert.equal(textures.size,38,'no duplicate source texture pages');
const data=new R.SkeletonJson(new R.AtlasAttachmentLoader(atlas)).readSkeletonData(sk);
assert.equal(data.animations.length,2);
const setup=new R.Skeleton(data);
setup.updateWorldTransform(R.Physics.update);
assert.equal(setup.constraints.filter(c=>c instanceof R.IkConstraint).length,2);
assert.deepEqual(setup.drawOrder.appliedPose.map(s=>s.data.name),sk.slots.map(s=>s.name));
let samples=0,meshCount=0;
for(const slot of setup.slots)if(slot.appliedPose.attachment instanceof R.MeshAttachment)meshCount++;
assert.ok(meshCount>=1,'rig package must contain source-preserving weighted arm mesh');
for(const anim of data.animations){
  for(let frame=0;frame<=60;frame++){
    const skeleton=new R.Skeleton(data);
    const state=new R.AnimationState(new R.AnimationStateData(data));
    state.setAnimation(0,anim.name,false);
    state.update(anim.duration*frame/60);
    state.apply(skeleton);
    skeleton.updateWorldTransform(R.Physics.update);
    assert.equal(skeleton.constraints.filter(c=>c instanceof R.IkConstraint).length,2);
    for(const bone of skeleton.bones)for(const k of ['a','b','c','d','worldX','worldY']){
      assert.ok(Number.isFinite(bone.appliedPose[k]),'nonfinite actual atlas bone '+bone.data.name+'.'+k);
    }
    samples++;
  }
}
console.log('REAL_PNG_ATLAS_IK_RUNTIME',JSON.stringify({
  atlas_pages:atlas.pages.length,real_pngs:textures.size,
  slots:setup.slots.length,weighted_meshes:meshCount,
  ik_constraints:setup.constraints.filter(c=>c instanceof R.IkConstraint).length,
  animations:data.animations.map(a=>a.name),runtime_samples:samples,
  original_spine_editor_import_verified:false,visual_quality_verified:false
}));
