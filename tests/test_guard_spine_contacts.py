"""Pixel-contact guard regression: catches detached gun without changing textures."""
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from PIL import Image

sys.path.insert(0,str(Path(__file__).resolve().parents[1] / 'tools'))
from guard_spine_contacts import check_bundle

def fixture(folder, *, gun_rotation=0, missing_finger=False, swap=False):
    skeleton={
        'skeleton':{'spine':'4.3.26'},
        'bones':[{'name':'root'},{'name':'hand','parent':'root'},
                 {'name':'b_pistol','parent':'hand','x':9},
                 {'name':'b_finger','parent':'hand'}],
        'slots':[{'name':'pistol','bone':'b_pistol','attachment':'pistol'}],
        'skins':[{'name':'default','attachments':{
            'pistol':{'pistol':{'type':'region','width':16,'height':16}}
        }}],
        'animations':{'shoot':{
            'bones':{'b_pistol':{'rotate':[
                {'time':0,'value':0},{'time':.5,'value':gun_rotation},{'time':1,'value':0}
            ]}}
        }}
    }
    if not missing_finger:
        skeleton['slots'].append({'name':'finger','bone':'b_finger','attachment':'finger'})
        skeleton['skins'][0]['attachments']['finger']={
            'finger':{'type':'region','width':16,'height':16}}
    if swap:
        skeleton['animations']['shoot']['slots']={'pistol':{'attachment':[{'time':.5,'name':None}]}}
    file=Path(folder) / 'fixture.zip'
    with ZipFile(file,'w',ZIP_DEFLATED) as z:
        z.writestr('skeleton.json',json.dumps(skeleton))
        for name in ('pistol', 'finger'):
            if name=='finger' and missing_finger:continue
            img=Image.new('RGBA',(16,16),(255,255,255,255))
            b=io.BytesIO();img.save(b,format='PNG')
            z.writestr('images/'+name+'.png',b.getvalue())
    return file

class ContactLockTests(unittest.TestCase):
    def test_safe_motion_retains_contact(self):
        with tempfile.TemporaryDirectory() as d:
            report=check_bundle(fixture(d))
            self.assertEqual(report['status'],'PASS')
            self.assertEqual(report['checks'][0]['retention'],1.0)

    def test_unattached_grip_fails_even_when_both_sprites_exist(self):
        with tempfile.TemporaryDirectory() as d:
            report=check_bundle(fixture(d,gun_rotation=90))
            self.assertEqual(report['status'],'FAIL')
            self.assertLess(report['checks'][0]['retention'],.58)

    def test_no_grip_fails_closed(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaisesRegex(ValueError,'no connected grip'):
                check_bundle(fixture(d,missing_finger=True))

    def test_undocumented_release_fails_closed(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaisesRegex(ValueError,'contact handoff'):
                check_bundle(fixture(d,swap=True))

if __name__=='__main__':
    unittest.main()
