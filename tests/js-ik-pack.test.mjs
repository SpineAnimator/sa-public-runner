import test from 'node:test';
import assert from 'node:assert/strict';
import {makeStoredZip,validateInputs,createAtlas,materializeRuntimeFiles} from '../tools/package_clgb71_ik.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';

test('pure JavaScript ZIP writes a valid local member and central directory',()=>{
  const buf=makeStoredZip([['skeleton.json',Buffer.from('{}')],['skeleton.atlas',Buffer.from('atlas')]]);
  assert.equal(buf.readUInt32LE(0),0x04034b50);
  assert.equal(buf.readUInt16LE(8),0,'store method');
  assert.equal(buf.readUInt32LE(buf.length-22),0x06054b50);
  assert.equal(buf.readUInt16LE(buf.length-14),2);
  assert.ok(buf.includes(Buffer.from('skeleton.json')));
  assert.ok(createHash('sha256').update(buf).digest('hex').length===64);
});
test('zip prevents unsafe paths and duplicate attachments',()=>{
  assert.throws(()=>makeStoredZip([['../bad.txt',Buffer.from('x')]]),/unsafe/);
  assert.throws(()=>makeStoredZip([['images/a.png',Buffer.from('x')],['images/a.png',Buffer.from('x')]]),/Repeated/);
});
test('source contract rejects 37 layer or lost IK/motion inventory',()=>{
 const layers=Array.from({length:38},(_,i)=>({name:'l'+i,order:i,width:4,height:4}));
 const base={source_sha256:'7adee866547a3b3cc9838b655cf70865980c5dba00313373cbf903fed776c7b2',
   source_bytes:4485543,canvas:{width:918,height:657},layers};
 const skeleton={skeleton:{spine:'4.3.26'},slots:layers.map(l=>({name:l.name})),
   bones:Array.from({length:40},(_,i)=>({name:'bone'+i})),
   constraints:[{type:'ik'},{type:'ik'}],animations:{shoot_up_01:{},shoot_up_02:{}}};
 const receipt={source_sha256:base.source_sha256,source_bytes:4485543,visible_source_layers:38,canvas:[918,657]};
 assert.equal(validateInputs(base,skeleton,receipt).length,38);
 assert.throws(()=>validateInputs({...base,layers:layers.slice(1)},skeleton,receipt),/38/);
 assert.throws(()=>validateInputs(base,{...skeleton,constraints:[]},receipt),/IK/);
 assert.throws(()=>validateInputs(base,{...skeleton,animations:{}},receipt),/inventory/);
 const atlas=createAtlas(layers);
 assert.match(atlas,/images\/l0\.png/);
 assert.match(atlas,/images\/l37\.png/);
});

test('JavaScript packager materializes exactly the ZIP skeleton and atlas for the official runtime',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'2spine-runtime-companions-'));
 try{
  const sk=Buffer.from('{"skeleton":{"spine":"4.3.26"}}\n');
  const atlas=Buffer.from('images/layer.png\nsize: 2, 2\n');
  materializeRuntimeFiles(dir,sk,atlas);
  assert.deepEqual(fs.readFileSync(path.join(dir,'skeleton.json')),sk);
  assert.deepEqual(fs.readFileSync(path.join(dir,'skeleton.atlas')),atlas);
  assert.throws(()=>materializeRuntimeFiles(dir,sk,atlas),/EEXIST/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
