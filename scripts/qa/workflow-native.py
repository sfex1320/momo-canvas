"""人工素材验收：草稿时间、音轨、字幕、参考图片，禁止触碰用户工程。"""
from pathlib import Path
import json, subprocess, runpy, sys, uuid
from PIL import Image, ImageDraw

root=Path(__file__).resolve().parents[2]
folder=root/'.codex-tmp'/('workflow-'+uuid.uuid4().hex[:8])
folder.mkdir(parents=True)
ffmpeg=sys.argv[1]
video=folder/'纯色测试.mp4'
audio=folder/'测试配乐.wav'
subprocess.run([ffmpeg,'-v','error','-f','lavfi','-i','color=c=blue:s=320x180:r=30:d=5','-f','lavfi','-i','sine=frequency=440:duration=5','-c:v','libx264','-c:a','aac','-shortest',str(video)],check=True)
subprocess.run([ffmpeg,'-v','error','-f','lavfi','-i','sine=frequency=220:duration=8',str(audio)],check=True)
(folder/'字幕.srt').write_text('1\n00:00:00,000 --> 00:00:01,200\n人工验收字幕\n',encoding='utf8')
plan={'width':320,'height':180,'fps':30,'totalSec':4,'clips':[{'path':str(video),'inSec':.5,'outSec':2.5,'durSec':2,'volume':.7,'fadeIn':.2,'transition':'fade','transitionDur':.3},{'path':str(video),'inSec':1,'outSec':3,'durSec':2,'volume':1,'flipH':True,'fadeOut':.2}],'audio':[{'path':str(audio),'atSec':.75,'volume':.4,'fadeIn':.1,'fadeOut':.2}]}
module=runpy.run_path(str(root/'src-tauri/src/production_tools.py'),run_name='momo_qa')
result=module['run']({'op':'jianying','directory':str(folder),'name':'人工验收','plan':plan})
content=json.loads((folder/'draft_content.json').read_text(encoding='utf8'))
tracks=content['tracks'];v=next(t for t in tracks if t['type']=='video')['segments'];a=next(t for t in tracks if t['type']=='audio')['segments'];subs=next(t for t in tracks if t['type']=='text')['segments']
assert v[0]['source_timerange']=={'start':500000,'duration':2000000}
assert v[1]['target_timerange']=={'start':2000000,'duration':2000000}
assert a[0]['target_timerange']['start']==750000
assert len(subs)==1
assert content['duration']==4000000
assert (folder/'draft_meta_info.json').is_file()
try: module['run']({'op':'jianying','directory':str(folder),'name':'人工验收','plan':plan})
except ValueError: pass
else: raise AssertionError('重复导出覆盖已有草稿')
image=Image.new('RGB',(256,128),'red');ImageDraw.Draw(image).rectangle((128,0,255,127),fill='blue');image.save(folder/'vision.png')
(folder/'request.json').write_text(json.dumps({'plan':plan,'result':result},ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps({'passed':6,'folder':str(folder),'vision':str(folder/'vision.png')},ensure_ascii=False))
