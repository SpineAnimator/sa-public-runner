#!/usr/bin/env python3
"""Fail-closed source-pixel contact lock for Spine 4.3 bundles.

Tracks the SAME source alpha pixels at a gripping contact through every clip,
rather than recomputing overlap from arbitrary gun pixels each frame.
Uses common-ancestor transforms; complex relative IK/deform paths fail closed.
Free cards, particles and loose props are not implicitly locked.
"""
from __future__ import annotations
import argparse
import io
import json
import math
from pathlib import Path
import re
from zipfile import ZipFile
from PIL import Image, ImageFilter

ALPHA = 100
MAX_SAMPLES = 3601

def require(ok, msg):
    if not ok:
        raise ValueError(msg)

def multiply(a,b):
    x,y,z,w,tx,ty=a
    X,Y,Z,W,Tx,Ty=b
    return x*X+y*Z,x*Y+y*W,z*X+w*Z,z*Y+w*W,x*Tx+y*Ty+tx,z*Tx+w*Ty+ty

def transform(m,x,y):
    return m[0]*x+m[1]*y+m[4],m[2]*x+m[3]*y+m[5]

def inverse(m,x,y):
    a,b,c,d,tx,ty=m
    det=a*d-b*c
    require(abs(det)>1e-8,'Degenerate contact transform')
    x,y=x-tx,y-ty
    return (d*x-b*y)/det,(-c*x+a*y)/det

def local_matrix(x=0,y=0,rotation=0,scale_x=1,scale_y=1):
    r=math.radians(rotation)
    c,s=math.cos(r),math.sin(r)
    return c*scale_x,-s*scale_y,s*scale_x,c*scale_y,x,y

def key_value(keys,t,default,field):
    if not keys:
        return default
    if t<=keys[0].get('time',0):
        return keys[0].get(field,default)
    for i in range(len(keys)-1):
        a,b=keys[i],keys[i+1]
        if t<=b['time']:
            require(a.get('curve') in (None,'linear'),
                    'Nonlinear contact path requires native runtime sampling')
            span=b['time']-a['time']
            require(span>0,'Non-monotonic key time')
            q=(t-a['time'])/span
            return a.get(field,default)*(1-q)+b.get(field,default)*q
    return keys[-1].get(field,default)

def ancestors(name,bones):
    result=[]
    while name is not None:
        require(name in bones,'Missing contact bone '+str(name))
        require(name not in result,'Cyclic bone hierarchy')
        result.append(name)
        name=bones[name].get('parent')
    return result[::-1]

def pose_pair(bone_a,bone_b,bones,animation,t,constraints):
    aa,bb=ancestors(bone_a,bones),ancestors(bone_b,bones)
    shared=[a for a,b in zip(aa,bb) if a==b]
    require(shared,'No common bone ancestor')
    left,right=aa[len(shared):],bb[len(shared):]
    constrained={n for c in constraints for n in c.get('bones',[])}
    require(not constrained.intersection(left+right),
            'Relative IK contact path needs native Spine runtime world pose sampling')
    def chain(names):
        m=1.,0.,0.,1.,0.,0.
        for name in names:
            bone=bones[name]
            tracks=animation.get('bones',{}).get(name,{})
            require(set(tracks).issubset({'translate','rotate','scale'}),
                    'Unsupported contact timeline on '+name)
            require(not bone.get('shearX',0) and not bone.get('shearY',0),
                    'Bone shear needs native runtime sampling')
            tr=tracks.get('translate',[])
            rr=tracks.get('rotate',[])
            ss=tracks.get('scale',[])
            x=bone.get('x',0)+key_value(tr,t,0,'x')
            y=bone.get('y',0)+key_value(tr,t,0,'y')
            r=bone.get('rotation',0)+key_value(rr,t,0,'value')
            sx=bone.get('scaleX',1)*key_value(ss,t,1,'x')
            sy=bone.get('scaleY',1)*key_value(ss,t,1,'y')
            m=multiply(m,local_matrix(x,y,r,sx,sy))
        return m
    return chain(left),chain(right),shared[-1]

def pixel_to_local(u,v,attachment,image):
    iw,ih=image.size
    x=(u+.5-iw/2)*attachment.get('width',iw)/iw
    y=(ih/2-v-.5)*attachment.get('height',ih)/ih
    m=local_matrix(attachment.get('x',0),attachment.get('y',0),
                   attachment.get('rotation',0),
                   attachment.get('scaleX',1),attachment.get('scaleY',1))
    return transform(m,x,y)

def local_to_pixel(x,y,attachment,image):
    m=local_matrix(attachment.get('x',0),attachment.get('y',0),
                   attachment.get('rotation',0),
                   attachment.get('scaleX',1),attachment.get('scaleY',1))
    x,y=inverse(m,x,y)
    iw,ih=image.size
    return math.floor(x*iw/attachment.get('width',iw)+iw/2),math.floor(ih/2-y*ih/attachment.get('height',ih))

def pixel_opaque(im,x,y):
    return 0<=x<im.width and 0<=y<im.height and im.getpixel((x,y))>ALPHA

def asset(skeleton,archive,name):
    slot=next((s for s in skeleton['slots'] if s['name']==name),None)
    require(slot is not None,'Protected slot absent: '+name)
    key=slot.get('attachment',name)
    attachment=None
    for skin in skeleton.get('skins',[]):
        attachment=skin.get('attachments',{}).get(name,{}).get(key)
        if attachment is not None:
            break
    require(attachment is not None,'Protected attachment absent: '+name)
    require(attachment.get('type','region')=='region',
            'Mesh contacts require native vertex sampling: '+name)
    with Image.open(io.BytesIO(archive.read('images/'+name+'.png'))) as png:
        im=png.convert('RGBA').getchannel('A')
    return slot['bone'],attachment,im

def inferred_locks(skeleton):
    bones={b['name']:b for b in skeleton['bones']}
    siblings={}
    for slot in skeleton['slots']:
        bone=bones.get(slot['bone'])
        if bone:
            siblings.setdefault(bone.get('parent'),[]).append(slot['name'])
    locks=[]
    for names in siblings.values():
        guns=[n for n in names if re.search(r'pistol|weapon|gun|пистолет|оруж',n,re.I)]
        fingers=[n for n in names if re.search(r'finger|палец|grip',n,re.I)]
        for gun in guns:
            require(fingers,'Weapon has no connected grip layer: '+gun)
            finger=next((n for n in fingers if ('right' in n.lower())==('right' in gun.lower())),fingers[0])
            locks.append({'source':gun,'target':finger,'min_retention':.58,'tolerance_px':4})
    return locks

def sampling_times(animation):
    times={0.}
    end=0.
    for group in ('bones','slots','ik','transform','path','deform'):
        for tracks in animation.get(group,{}).values():
            require(group!='deform','Animated mesh deformation needs native vertex sampling')
            arrs=[tracks] if isinstance(tracks,list) else list(tracks.values())
            for arr in arrs:
                if isinstance(arr,list):
                    for key in arr:
                        if 'time' in key:
                            t=key['time']
                            require(isinstance(t,(int,float)) and math.isfinite(t) and t>=0,'Invalid animation time')
                            times.add(float(t))
                            end=max(end,float(t))
    require(end<=90,'Contact check animation duration is unexpectedly long')
    times.update(min(end,i/60) for i in range(int(end*60)+2))
    result=sorted(times)
    require(len(result)<=MAX_SAMPLES,'Excessive number of guard samples')
    return result

def check_bundle(bundle,rules=None):
    with ZipFile(bundle) as z:
        require(z.testzip() is None,'Corrupt bundle ZIP')
        skeleton=json.loads(z.read('skeleton.json'))
        bones={b['name']:b for b in skeleton['bones']}
        pairs=inferred_locks(skeleton) if rules is None else rules
        require(pairs,'No inferred contacts: provide explicit protected_pairs for this rig')
        animations=skeleton.get('animations',{})
        require(animations,'No animations in bundle')
        assets={}
        for pair in pairs:
            for name in (pair['source'],pair['target']):
                if name not in assets:
                    assets[name]=asset(skeleton,z,name)
        report={'status':'PASS','release_ready':False,'artistic_quality_approved':False,
                'inferred_locks':rules is None,'sample_hz':60,
                'clips':sorted(animations),'checks':[]}
        for pair in pairs:
            source,target=pair['source'],pair['target']
            abone,a,amask=assets[source]
            bbone,b,bmask=assets[target]
            tol=pair.get('tolerance_px',4)
            minimum=pair.get('min_retention',.58)
            require(isinstance(tol,int) and 0<=tol<=10,'Contact tolerance must be 0-10 px')
            require(isinstance(minimum,(int,float)) and .05<=minimum<=1,'Invalid retention threshold')
            soft=bmask.filter(ImageFilter.MaxFilter(1+2*tol)) if tol else bmask
            ma,mb,ancestor=pose_pair(abone,bbone,bones,{},0,skeleton.get('constraints',[]))
            original=[]
            for v in range(amask.height):
                for u in range(amask.width):
                    if amask.getpixel((u,v))<=ALPHA:
                        continue
                    x,y=pixel_to_local(u,v,a,amask)
                    x,y=transform(ma,x,y)
                    x,y=inverse(mb,x,y)
                    uu,vv=local_to_pixel(x,y,b,bmask)
                    if pixel_opaque(bmask,uu,vv):
                        original.append((u,v))
            require(len(original)>=max(20,min(amask.size)*.15),
                    'Unable to infer source grip contact patch: '+source+'/'+target)
            for name,animation in animations.items():
                require(source not in animation.get('slots',{}) and target not in animation.get('slots',{}),
                        'Animated attachment swaps need explicit contact handoff')
                worst={'retention':1.,'time':0.,'frame':0}
                times=sampling_times(animation)
                for t in times:
                    ma,mb,_=pose_pair(abone,bbone,bones,animation,t,skeleton.get('constraints',[]))
                    alive=0
                    for u,v in original:
                        x,y=pixel_to_local(u,v,a,amask)
                        x,y=transform(ma,x,y)
                        x,y=inverse(mb,x,y)
                        uu,vv=local_to_pixel(x,y,b,bmask)
                        alive+=int(pixel_opaque(soft,uu,vv))
                    retained=alive/len(original)
                    if retained<worst['retention']:
                        worst={'retention':round(retained,5),'time':round(t,5),'frame':round(t*60)}
                report['checks'].append({'source':source,'target':target,'clip':name,
                                         'common_ancestor':ancestor,
                                         'setup_contact_px':len(original),'samples':len(times),
                                         'min_retention':minimum,**worst})
                if worst['retention']+1e-8<minimum:
                    report['status']='FAIL'
        return report

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--bundle',type=Path,required=True)
    p.add_argument('--report',type=Path,required=True)
    p.add_argument('--rules',type=Path)
    args=p.parse_args()
    report={'status':'ERROR','release_ready':False,'artistic_quality_approved':False}
    try:
        rules=json.loads(args.rules.read_text())['protected_pairs'] if args.rules else None
        report=check_bundle(args.bundle,rules)
    except Exception as exc:
        report['error']=f'{type(exc).__name__}: {exc}'
    args.report.parent.mkdir(parents=True,exist_ok=True)
    args.report.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print('SPINE_CONTACT_GUARD',json.dumps(report,ensure_ascii=False))
    if report['status']!='PASS':
        raise SystemExit(1)

if __name__=='__main__':
    main()
