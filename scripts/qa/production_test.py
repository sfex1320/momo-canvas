"""真实本地生产回归：原像素蒙版、ICC、关键帧无损拼接。只写 .Codex/native-acceptance。"""
import importlib.util, pathlib, json, sys, subprocess, hashlib, time
from PIL import Image, ImageDraw, ImageCms
import numpy as np
ROOT=pathlib.Path(__file__).resolve().parents[2]
OUT=ROOT/'.Codex/native-acceptance'; OUT.mkdir(parents=True,exist_ok=True)
spec=importlib.util.spec_from_file_location('production',ROOT/'src-tauri/src/production_tools.py')
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
import imageio_ffmpeg
ffmpeg=imageio_ffmpeg.get_ffmpeg_exe();ffprobe=r'C:\Program Files\ffmpeg\bin\ffprobe.exe'
results=[]
def test(name,fn):
    start=time.monotonic()
    try: fn(); result={'name':name,'passed':True}
    except Exception as e: result={'name':name,'passed':False,'error':str(e)}
    result['seconds']=round(time.monotonic()-start,3);results.append(result);print(json.dumps(result,ensure_ascii=True),flush=True)
def check(value,message):
    if not value:raise AssertionError(message)
def rejects(req,expected):
    try:p.run(req)
    except Exception as e:check(expected in str(e),str(e));return
    raise AssertionError('应拒绝却成功')
im=Image.new('RGBA',(160,120),'white');d=ImageDraw.Draw(im);d.rectangle((30,20,130,100),fill='#ad172e');d.rectangle((65,45,95,75),fill='white')
marks=Image.new('RGBA',im.size);d=ImageDraw.Draw(marks);d.rectangle((45,30,52,40),fill='lime');d.rectangle((70,50,90,70),fill='red');d.rectangle((10,10,15,15),fill='red')
def segment():
    r=p.image_of(p.run({'op':'segment','image':p.png_of(im),'marks':p.png_of(marks)})['png']);a=np.array(r);original=np.array(im)
    check(np.array_equal(a[:,:,:3],original[:,:,:3]),'RGB 被更改');check(a[35,48,3]==255 and a[60,80,3]==0 and a[10,10,3]==0,'人工标记没有兑现');r.save(OUT/'标记蒙版.png')
test('精细蒙版保留原 RGB，保留笔与删除笔兑现',segment)
def semantic():
    original=Image.open(ROOT/'.Codex/live-acceptance/连续生图-1.png').convert('RGBA')
    r=p.image_of(p.run({'op':'semantic','image':p.png_of(original)})['png']);a=np.array(r)
    check(np.array_equal(a[:,:,:3],np.array(original)[:,:,:3]),'语义分割重绘了 RGB');check(a[0,0,3]<20 and a[a.shape[0]//2,a.shape[1]//2,3]>200,'主体或背景识别失败');r.save(OUT/'真实生成图-主体蒙版.png')
test('真实生图作品经 U2NetP 语义抠图',semantic)
icc=r'C:\Windows\System32\spool\drivers\color\RSWOP.icm'
def cmyk():
    r=p.run({'op':'cmyk','image':p.png_of(im),'profile':icc,'dpi':300,'output':str(OUT/'ICC验收.tif')})
    with Image.open(r['path']) as image:
        check(image.mode=='CMYK' and image.size==im.size,'模式或像素尺寸错误');check(abs(image.info['dpi'][0]-300)<.001,'DPI 错误');check(image.info.get('icc_profile')==ImageCms.getOpenProfile(icc).tobytes(),'ICC 未完整嵌入')
test('CMYK TIFF 模式、DPI、ICC 与尺寸读回',cmyk)
test('RGB ICC 不冒充 CMYK',lambda:rejects({'op':'cmyk','image':p.png_of(im),'profile':r'C:\Windows\System32\spool\drivers\color\sRGB Color Space Profile.icm','dpi':300,'output':str(OUT/'不应输出.tif')},'CMYK'))
def command(args):return subprocess.check_output(args,stderr=subprocess.STDOUT,creationflags=subprocess.CREATE_NO_WINDOW)
source=OUT/'source.mp4'
command([ffmpeg,'-v','error','-y','-f','lavfi','-i','testsrc2=size=160x120:rate=24:duration=6','-c:v','libx264','-g','24','-keyint_min','24','-sc_threshold','0','-bf','0','-pix_fmt','yuv420p',str(source)])
request={'op':'lossless','ffmpeg':ffmpeg,'ffprobe':ffprobe,'parts':[{'path':str(source),'start':0,'end':1},{'path':str(source),'start':3,'end':5}],'output':str(OUT/'无损局部替换.mp4')}
def frames(path):
    raw=command([ffmpeg,'-v','error','-i',str(path),'-f','framemd5','-']).decode()
    return [x.rsplit(',',1)[-1].strip() for x in raw.splitlines() if not x.startswith('#')]
def lossless():
    r=p.run(request);check(abs(r['duration']-3)<.05,'时长错误');original=frames(source);out=frames(r['path']);check(out==original[:24]+original[72:120],'拼接解码像素与源片段不一致')
test('真实 FFmpeg 无损局部替换：逐帧像素哈希完全相同',lossless)
test('非关键帧切点明确拒绝',lambda:rejects({**request,'parts':[{'path':str(source),'start':.1,'end':1}]},'不是关键帧'))
test('无损输出禁止覆盖源文件',lambda:rejects({**request,'output':str(source)},'覆盖'))
before=hashlib.sha256(source.read_bytes()).hexdigest()
def reject_mismatch():
    different=OUT/'different.mp4'
    command([ffmpeg,'-v','error','-y','-f','lavfi','-i','color=blue:size=128x128:rate=24:duration=1','-c:v','libx264',str(different)])
    rejects({**request,'parts':[{'path':str(source),'start':0,'end':1},{'path':str(different),'start':0,'end':1}]},'参数不同')
    check(hashlib.sha256(source.read_bytes()).hexdigest()==before,'源文件变化')
test('不兼容素材拒绝且源文件保持',reject_mismatch)
(OUT/'report.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf8')
sys.exit(0 if all(x['passed'] for x in results) else 1)
