/** 2Spine JS packager: verified PSD textures + JS keyed skeleton → Spine ZIP.
 * No Python rig, motion or animation generation is permitted in this path.
 * The official Spine runtime and optional licensed Editor are independent gates.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const SOURCE_HASH='7adee866547a3b3cc9838b655cf70865980c5dba00313373cbf903fed776c7b2';
const SOURCE_BYTES=4485543;
const EXPECTED_CLIPS=['shoot_up_01','shoot_up_02'];
const PNG_SIG=Buffer.from([137,80,78,71,13,10,26,10]);
const sha=b=>createHash('sha256').update(b).digest('hex');
const checked=(cond,msg)=>{if(!cond)throw Error(msg);};

function crc32(buf){
  let crc=0xffffffff;
  for(const byte of buf){
    crc^=byte;
    for(let i=0;i<8;i++)crc=crc&1?(crc>>>1)^0xedb88320:crc>>>1;
  }
  return (crc^0xffffffff)>>>0;
}
export function makeStoredZip(files){
  checked(Array.isArray(files)&&files.length>0&&files.length<65535,'Invalid ZIP file count');
  let offset=0;
  const locals=[],central=[],seen=new Set();
  for(const [name,raw] of files){
    checked(typeof name==='string'&&/^(skeleton\.json|skeleton\.atlas|images\/[A-Za-z0-9_-]+\.png)$/.test(name),
      'Unexpected or unsafe ZIP member');
    checked(!seen.has(name),'Repeated ZIP member');seen.add(name);
    const data=Buffer.from(raw),filename=Buffer.from(name,'utf8');
    checked(data.length<=0xffffffff&&filename.length<=65535,'Oversized ZIP member');
    const checksum=crc32(data);
    const local=Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);
    local.writeUInt16LE(0x800,6);local.writeUInt16LE(0,8);
    local.writeUInt16LE(0,10);local.writeUInt16LE(20513,12); // 2020-01-01
    local.writeUInt32LE(checksum,14);
    local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);
    local.writeUInt16LE(filename.length,26);
    const record=Buffer.concat([local,filename,data]);locals.push(record);
    const cd=Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50,0);cd.writeUInt16LE(20,4);cd.writeUInt16LE(20,6);
    cd.writeUInt16LE(0x800,8);cd.writeUInt16LE(0,10);
    cd.writeUInt16LE(0,12);cd.writeUInt16LE(20513,14);
    cd.writeUInt32LE(checksum,16);
    cd.writeUInt32LE(data.length,20);cd.writeUInt32LE(data.length,24);
    cd.writeUInt16LE(filename.length,28);
    cd.writeUInt32LE((0o100644*65536)>>>0,38);
    cd.writeUInt32LE(offset,42);
    central.push(Buffer.concat([cd,filename]));
    offset+=record.length;
    checked(offset<0xffffffff,'ZIP offsets exceed 32-bit limit');
  }
  const main=Buffer.concat(locals),directory=Buffer.concat(central);
  const tail=Buffer.alloc(22);tail.writeUInt32LE(0x06054b50,0);
  tail.writeUInt16LE(files.length,8);tail.writeUInt16LE(files.length,10);
  tail.writeUInt32LE(directory.length,12);tail.writeUInt32LE(main.length,16);
  return Buffer.concat([main,directory,tail]);
}
export function validateInputs(manifest,skeleton,receipt){
  checked(manifest?.source_sha256===SOURCE_HASH&&manifest?.source_bytes===SOURCE_BYTES,
    'Unapproved original PSD or source manifest');
  checked(manifest?.canvas?.width===918&&manifest?.canvas?.height===657,
    'Unexpected PSD canvas geometry');
  const layers=manifest.layers;
  checked(Array.isArray(layers)&&layers.length===38,'Expected 38 original PSD layers');
  checked(new Set(layers.map(l=>l.name)).size===38,'Duplicate source layer names');
  layers.forEach((l,i)=>{
    checked(l.order===i&&/^[A-Za-z0-9_-]{1,120}$/.test(l.name),'Source order/name changed');
    checked(Number.isInteger(l.width)&&l.width>0&&Number.isInteger(l.height)&&l.height>0,
      'Invalid image bounds');
  });
  checked(receipt?.source_sha256===SOURCE_HASH&&receipt?.source_bytes===SOURCE_BYTES,
    'PSD raster extraction receipt does not match original');
  checked(receipt.visible_source_layers===38 && Array.isArray(receipt.canvas) &&
    receipt.canvas[0]===918&&receipt.canvas[1]===657,'Raster extraction metadata invalid');
  checked(skeleton?.skeleton?.spine==='4.3.26','Wrong Spine JSON version');
  checked(Array.isArray(skeleton.slots)&&skeleton.slots.length===38&&
    skeleton.slots.every((s,i)=>s.name===layers[i].name),'Source layer draw order changed');
  checked(Array.isArray(skeleton.bones)&&skeleton.bones.length>=40,'No JS-generated IK skeleton');
  checked(Array.isArray(skeleton.constraints)&&skeleton.constraints.filter(x=>x.type==='ik').length===2,
    'Expected two real IK chains');
  checked(skeleton.constraints.every(x=>x.type==='ik'),'Unexpected constraint type');
  checked(JSON.stringify(Object.keys(skeleton.animations||{}).sort())===
    JSON.stringify(EXPECTED_CLIPS),'Unexpected JS animation inventory');
  return layers;
}
export function createAtlas(layers){
  return layers.map(l=>{
    const w=l.width,h=l.height;
    return 'images/'+l.name+'.png\nsize: '+w+', '+h+
      '\nformat: RGBA8888\nfilter: Linear, Linear\nrepeat: none\n'+
      l.name+'\n  rotate: false\n  xy: 0, 0\n  size: '+w+', '+h+
      '\n  orig: '+w+', '+h+'\n  offset: 0, 0\n  index: -1\n';
  }).join('\n');
}
/** Expose the exact ZIP skeleton/atlas bytes for official Spine runtime validation.
 * PSD PNGs already reside under sourceFolder/images; never regenerate them here.
 * Exclusive creation prevents silently accepting stale companion files.
 */
export function materializeRuntimeFiles(sourceFolder,skeletonBytes,atlasBytes){
  checked(Buffer.isBuffer(skeletonBytes)&&Buffer.isBuffer(atlasBytes),'Expected validated Spine buffers');
  for(const [name,bytes] of [['skeleton.json',skeletonBytes],['skeleton.atlas',atlasBytes]]){
    const file=path.join(sourceFolder,name);
    fs.writeFileSync(file,bytes,{flag:'wx'});
    checked(fs.readFileSync(file).equals(bytes),'Loose runtime companion differs from ZIP: '+name);
  }
}
export function packageIK(manifestFile,skeletonFile,sourceFolder,zipFile,reportFile){
  const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  const skeleton=JSON.parse(fs.readFileSync(skeletonFile,'utf8'));
  const receipt=JSON.parse(fs.readFileSync(path.join(sourceFolder,'psd-extraction-receipt.json'),'utf8'));
  const layers=validateInputs(manifest,skeleton,receipt);
  const images=path.join(sourceFolder,'images');
  const files=[],hashes={};
  const sk=Buffer.from(JSON.stringify(skeleton)+'\n','utf8');
  const atlas=Buffer.from(createAtlas(layers),'utf8');
  files.push(['skeleton.json',sk],['skeleton.atlas',atlas]);
  for(const l of layers){
    const image=fs.readFileSync(path.join(images,l.name+'.png'));
    checked(image.subarray(0,8).equals(PNG_SIG),'Missing/invalid original PNG: '+l.name);
    checked(image.readUInt32BE(16)===l.width && image.readUInt32BE(20)===l.height,
      'Original PNG dimensions changed: '+l.name);
    const hash=sha(image);
    checked(receipt.textures?.[l.name]?.sha256===hash &&
      receipt.textures[l.name].source_order===l.order &&
      /^[a-f0-9]{64}$/.test(receipt.textures[l.name].pixel_sha256),
      'Original PSD texture has changed or lacks pixel-fidelity evidence: '+l.name);
    files.push(['images/'+l.name+'.png',image]);
    hashes[l.name]=hash;
  }
  checked(files.length===40,'Expected 38 PNG textures plus skeleton and atlas');
  const zip=makeStoredZip(files);
  fs.mkdirSync(path.dirname(zipFile),{recursive:true});
  fs.writeFileSync(zipFile,zip,{flag:'wx'});
  materializeRuntimeFiles(sourceFolder,sk,atlas);
  fs.mkdirSync(path.dirname(reportFile),{recursive:true});
  const report={
    source_sha256:SOURCE_HASH,source_bytes:SOURCE_BYTES,
    visible_source_layers:38,original_canvas:[918,657],export_version:'4.3.26',
    zip_sha256:sha(zip),zip_size_bytes:zip.length,
    png_count:38,texture_sha256:hashes,atlas_pages:38,
    actual_ik_constraints:2,animations:EXPECTED_CLIPS,
    skeleton_and_motion_engine:'JavaScript engine/rig.js + engine/motion.js',
    raster_extraction_engine:'Python PSD decode only (no rig/keyframes)',
    zip_packaging_engine:'JavaScript Node.js',
    source_pixels_preserved_after_rasterization:true,
    original_psd_composite_visual_match_verified:false,
    editor_import_verified:false,artist_approved_anatomy:false,native_spine_project:false
  };
  fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log('JS_IK_ZIP_VERIFIED',JSON.stringify({
    sha256:report.zip_sha256,bytes:report.zip_size_bytes,layers:38,
    animations:EXPECTED_CLIPS,python_generated_animation:false}));
  return report;
}
if(process.argv[1] && path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname)){
  if(process.argv.length!==7)throw Error('Usage: node package_clgb71_ik.mjs manifest.json skeleton.json image-dir bundle.zip report.json');
  packageIK(...process.argv.slice(2));
}
