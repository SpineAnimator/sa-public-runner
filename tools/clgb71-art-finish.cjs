'use strict';
/** Source-specific choreography for pinned clgb71 PSD, not a generic preset.
 * Original PNGs, initial pose, draw order and two IK chains remain unchanged.
 * This pass is a candidate, NOT a claim of native Editor visual approval.
 */
const SOURCE='7adee866547a3b3cc9838b655cf70865980c5dba00313373cbf903fed776c7b2';
const MOTION={
 shoot_up_01:{
  'b_Sombrero':[[0,0,0,0],[.19,-.5,0,.5],[.36,1.3,0,1.1],[.58,-.8,0,-.9],[.82,.45,0,.4],[1.16,0,0,0]],
  'b_plash':[[0,0,0,0],[.2,0,0,0],[.38,-3.9,-4,1.4],[.61,2.5,3,-2],[.89,-1.4,-2,1],[1.2,.45,1,-.3],[1.72,0,0,0]],
  'b_bant':[[0,0,0,0],[.22,0,0,0],[.37,3,1,1.5],[.59,-2,-1,-.7],[.84,.8,.3,.3],[1.15,0,0,0]],
  'b_card-20':[[0,0,0,0],[.28,0,0,0],[.55,8,-5,7],[.91,-4,5,11],[1.28,3,-2,4],[1.75,0,0,0]],
  'b_card-21':[[0,0,0,0],[.21,0,0,0],[.5,-9,5,-6],[.85,4,-3,-9],[1.3,-2,2,-4],[1.78,0,0,0]],
  'b_card-17':[[0,0,0,0],[.2,0,0,0],[.62,6,-5,-6],[1.04,-3,4,-9],[1.54,2,-2,-3],[1.86,0,0,0]],
  'b_card-22':[[0,0,0,0],[.2,0,0,0],[.6,-7,5,9],[1.0,3,-3,11],[1.54,-1,1,3],[1.87,0,0,0]]
 },
 shoot_up_02:{
  'b_Sombrero':[[0,0,0,0],[.27,0,0,0],[.55,1.1,0,1],[.81,-.8,0,-.7],[1.04,0,0,0],[1.41,1.5,0,1.3],[1.66,-1.1,0,-.8],[1.95,0,0,0]],
  'b_plash':[[0,0,0,0],[.29,0,0,0],[.58,-3.4,-4,1],[.82,2.3,2,-1.5],[1.06,0,0,0],[1.43,-4.6,-5,2],[1.7,3.1,3,-2],[1.95,0,0,0]],
  'b_bant':[[0,0,0,0],[.29,0,0,0],[.6,2.7,1,1],[.87,-1.8,-.5,-1],[1.09,0,0,0],[1.44,3.5,1.2,1.4],[1.72,-2,-1,-1],[1.96,0,0,0]],
  'b_card-20':[[0,0,0,0],[.32,0,0,0],[.67,8,-6,6],[1.0,-4,4,9],[1.25,2,-2,2],[1.64,-7,6,10],[1.94,0,0,0]],
  'b_card-21':[[0,0,0,0],[.29,0,0,0],[.68,-8,5,-6],[1.0,3,-2,-9],[1.27,-2,2,-2],[1.66,8,-6,-11],[1.94,0,0,0]],
  'b_card-17':[[0,0,0,0],[.31,0,0,0],[.7,6,-5,-4],[1.01,-3,3,-7],[1.3,1,-1,-2],[1.66,7,-4,-9],[1.96,0,0,0]],
  'b_card-22':[[0,0,0,0],[.32,0,0,0],[.67,-7,5,7],[1.02,3,-3,11],[1.29,0,0,0],[1.67,-9,6,8],[1.95,0,0,0]]
 }
};
function fail(m){throw Error('clgb71 artistic finish: '+m);}
function interpolate(anchors,time,column){
 let a=anchors[0],b=anchors.at(-1);
 if(time<=a[0])return a[column];if(time>=b[0])return b[column];
 for(let i=1;i<anchors.length;i++)if(time<=anchors[i][0]){a=anchors[i-1];b=anchors[i];break;}
 let t=(time-a[0])/(b[0]-a[0]);t=t*t*(3-2*t);
 return a[column]*(1-t)+b[column]*t;
}
function rounded(n){return Math.abs(n)<1e-9?0:+n.toFixed(6);}
function addArtFinish(skeleton,sourceSha256){
 if(sourceSha256!==SOURCE)fail('source PSD SHA-256 mismatch');
 if(skeleton?.skeleton?.spine!=='4.3.26')fail('expected Spine 4.3.26');
 const names=new Set((skeleton.bones||[]).map(b=>b.name));
 const clips=Object.keys(skeleton.animations||{});
 if(clips.sort().join(',')!=='shoot_up_01,shoot_up_02')fail('unexpected animation inventory');
 let keyedBones=0;
 for(const [clipId,profiles] of Object.entries(MOTION)){
  const clip=skeleton.animations[clipId];
  if(!clip?.bones||!clip?.ik||Object.keys(clip.ik).length!==2)fail('missing original two-hand IK');
  for(const [boneId,anchors] of Object.entries(profiles)){
   if(!names.has(boneId)||clip.bones[boneId])fail('missing or already keyed '+boneId);
   if(anchors[0][0]!==0||anchors[0].slice(1).some(Boolean)||
      anchors.at(-1)[0]>=2||anchors.at(-1).slice(1).some(Boolean))
    fail('non-zero setup/last profile '+boneId);
   for(let i=1;i<anchors.length;i++)if(anchors[i][0]<=anchors[i-1][0])fail('unordered anchor '+boneId);
   for(const a of anchors)if(!a.every(Number.isFinite)||Math.abs(a[1])>12||Math.abs(a[2])>12||Math.abs(a[3])>12)
    fail('unsafe artistic accent '+boneId);
   const rotate=[],translate=[];
   for(let i=0;i<=60;i++){
    const time=i/30;
    rotate.push({time,value:rounded(interpolate(anchors,time,1))});
    translate.push({time,x:rounded(interpolate(anchors,time,2)),y:rounded(interpolate(anchors,time,3))});
   }
   clip.bones[boneId]={rotate,translate};keyedBones++;
  }
 }
 return {sourceSha256,clips:2,secondaryBones:keyedBones,setupPreserved:true,
  drawOrderPreserved:true,originalPngsPreserved:true,artistApproved:false,editorRerenderRequired:true};
}
module.exports={addArtFinish};
