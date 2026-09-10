"""受控本地生产工具；请求由 Rust 经标准输入传入，不执行用户代码。"""
import sys, json, io, base64, os, tempfile

def image_of(data):
    from PIL import Image
    raw = base64.b64decode(data.split(',', 1)[-1], validate=True)
    img = Image.open(io.BytesIO(raw))
    if img.width * img.height > 24_000_000:
        raise ValueError('图片超过 2400 万像素，请先缩小')
    img.load()
    return img

def png_of(img):
    stream = io.BytesIO(); img.save(stream, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(stream.getvalue()).decode()

def run(p):
    if p['op'] == 'jianying':
        return jianying_export(p)
    if p['op'] in ('video_info', 'lossless'):
        return video_tool(p)
    if p['op'] == 'probe':
        import importlib.util
        return {k: bool(importlib.util.find_spec(k)) for k in ['PIL', 'cv2', 'rembg']}
    if p['op'] == 'semantic':
        # 首次下载约 5MB 官方 U2NetP，模型缓存属于 MOMO，不修改 ComfyUI 安装。
        os.environ['U2NET_HOME'] = os.path.join(os.environ.get('APPDATA',os.path.expanduser('~')), 'site.jinpengi.momo', 'models', 'segmentation')
        from rembg import new_session, remove
        import numpy as np
        from PIL import Image
        original=image_of(p['image']).convert('RGBA')
        alpha=remove(original.convert('RGB'),session=new_session('u2netp',providers=['CPUExecutionProvider']),only_mask=True)
        original.putalpha(Image.fromarray(np.minimum(np.array(original)[:,:,3],np.array(alpha.convert('L')))))
        return {'png':png_of(original),'model':'u2netp'}
    if p['op'] == 'segment':
        import cv2, numpy as np
        from PIL import Image
        original = image_of(p['image']).convert('RGBA')
        # 在缩略图上优化蒙版，最终仅改原图 alpha，RGB 像素不重绘。
        rgb = original.convert('RGB'); w, h = rgb.size
        factor = min(1, 1536 / max(w, h)); size = (max(8, round(w*factor)), max(8, round(h*factor)))
        pix = np.array(rgb.resize(size)); mask = np.full(pix.shape[:2], cv2.GC_PR_FGD, np.uint8)
        mask[[0,-1],:] = cv2.GC_BGD; mask[:,[0,-1]] = cv2.GC_BGD
        if p.get('initial'):
            initial=np.array(image_of(p['initial']).convert('RGBA').resize(size))[:,:,3]
            mask[:]=np.where(initial>127,cv2.GC_PR_FGD,cv2.GC_PR_BGD)
        if p.get('marks'):
            marks = np.array(image_of(p['marks']).convert('RGBA').resize(size, Image.Resampling.NEAREST))
            active = marks[:,:,3] > 100
            mask[active & (marks[:,:,1] > marks[:,:,0])] = cv2.GC_FGD
            mask[active & (marks[:,:,0] >= marks[:,:,1])] = cv2.GC_BGD
        cv2.grabCut(pix, mask, None, np.zeros((1,65),np.float64), np.zeros((1,65),np.float64), 5, cv2.GC_INIT_WITH_MASK)
        alpha = Image.fromarray(np.where((mask==1)|(mask==3), 255, 0).astype('uint8')).resize((w,h), Image.Resampling.LANCZOS)
        # 用户明确标记保留/删除的像素，在原分辨率强制兑现。
        a = np.minimum(np.array(alpha), np.array(original)[:,:,3])
        if p.get('marks'):
            marks = np.array(image_of(p['marks']).convert('RGBA').resize((w,h), Image.Resampling.NEAREST)); active=marks[:,:,3]>100
            a[active & (marks[:,:,1]>marks[:,:,0])] = np.array(original)[:,:,3][active & (marks[:,:,1]>marks[:,:,0])]
            a[active & (marks[:,:,0]>=marks[:,:,1])] = 0
        original.putalpha(Image.fromarray(a)); return {'png': png_of(original)}
    if p['op'] == 'cmyk':
        from PIL import ImageCms
        img = image_of(p['image']).convert('RGB')
        profile = ImageCms.getOpenProfile(p['profile'])
        if profile.profile.xcolor_space.strip() != 'CMYK': raise ValueError('请选择 CMYK 输出 ICC 配置文件')
        out = ImageCms.profileToProfile(img, ImageCms.createProfile('sRGB'), profile, outputMode='CMYK', renderingIntent=1)
        dpi = float(p['dpi'])
        if not 1 <= dpi <= 2400: raise ValueError('DPI 无效')
        path = os.path.abspath(p['output'])
        if not path.lower().endswith(('.tif','.tiff')): raise ValueError('CMYK 输出必须为 TIFF')
        fd, temp = tempfile.mkstemp(suffix='.tif', dir=p.get('scratch',os.path.dirname(path))); os.close(fd)
        try:
            out.save(temp, format='TIFF', compression='tiff_lzw', dpi=(dpi,dpi), icc_profile=profile.tobytes())
            os.replace(temp,path)
        finally:
            if os.path.exists(temp): os.remove(temp)
        return {'path':path,'mode':'CMYK','profile':ImageCms.getProfileName(profile).strip()}
    raise ValueError('不支持的生产工具')

def video_tool(p):
    import subprocess, math
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    probe = p['ffprobe']; ffmpeg = p.get('ffmpeg')
    if not ffmpeg:
        import imageio_ffmpeg
        ffmpeg=imageio_ffmpeg.get_ffmpeg_exe()
    def command(args):
        r = subprocess.run(args, capture_output=True, creationflags=flags, timeout=120)
        if r.returncode: raise ValueError(r.stderr.decode('utf8', 'replace')[-1200:])
        return r.stdout
    def inspect(path):
        if not os.path.isabs(path) or not os.path.isfile(path): raise ValueError('无损剪辑需要已落盘的视频文件')
        info=json.loads(command([probe,'-v','error','-show_streams','-show_format','-show_data','-of','json',path]))
        keys=json.loads(command([probe,'-v','error','-select_streams','v:0','-skip_frame','nokey','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',path]))
        info['keys']=[float(x['best_effort_timestamp_time']) for x in keys['frames'] if 'best_effort_timestamp_time' in x]
        return info
    if p['op']=='video_info':
        i=inspect(p['input']); return {'duration':float(i['format']['duration']),'keys':i['keys'],'streams':[{k:s.get(k) for k in ['codec_type','codec_name','width','height','sample_rate']} for s in i['streams']]}
    parts=p['parts']
    if not 1<=len(parts)<=200: raise ValueError('片段数量须为1至200')
    infos=[inspect(x['path']) for x in parts]
    fields=['codec_type','codec_name','profile','width','height','pix_fmt','time_base','sample_rate','channels','channel_layout','extradata']
    signatures=[[{k:s.get(k) for k in fields} for s in i['streams']] for i in infos]
    if any(s!=signatures[0] for s in signatures): raise ValueError('素材的编码、音轨或编码参数不同，无法直接无损拼接；请选择兼容合成或先统一素材')
    streams=infos[0]['streams']
    if any(s['codec_type'] not in ('video','audio') for s in streams): raise ValueError('无损模式暂不接入字幕或数据轨，请先选择纯音视频素材')
    if any(s['codec_name'] not in ('h264','hevc','aac','mp3','av1') for s in streams): raise ValueError('当前无损输出为 MP4，所选编码不兼容；请使用兼容合成')
    ranges=[]
    for part,info in zip(parts,infos):
        duration=float(info['format']['duration']);start=float(part.get('start',0));end=float(part.get('end',duration))
        if not all(map(math.isfinite,[start,end,duration])) or start<0 or end>duration+.02 or end-start<.02: raise ValueError('无效的剪辑区间')
        keys=info['keys']
        for t in (start,end):
            if t<.005 or abs(t-duration)<.02: continue
            near=min(keys,key=lambda k:abs(t-k)) if keys else None
            if near is None or abs(t-near)>.005: raise ValueError(f'切点 {t:.3f}秒不是关键帧；最近可用切点为 {near}秒，请明确调整后重试')
        ranges.append((start,min(end,duration)))
    output=os.path.abspath(p['output'])
    if not output.lower().endswith('.mp4'): raise ValueError('无损输出必须为 MP4')
    if any(os.path.normcase(os.path.realpath(x['path']))==os.path.normcase(os.path.realpath(output)) for x in parts): raise ValueError('输出不能覆盖源素材')
    with tempfile.TemporaryDirectory(prefix='momo-copy-',dir=p.get('scratch',os.path.dirname(output))) as folder:
        clips=[]
        for index,(part,(start,end)) in enumerate(zip(parts,ranges)):
            out=os.path.join(folder,f'{index}.mp4')
            command([ffmpeg,'-v','error','-y','-ss',str(start),'-i',part['path'],'-t',str(end-start),'-map','0','-c','copy','-avoid_negative_ts','make_zero',out]);clips.append(out)
        listing=os.path.join(folder,'list.txt')
        with open(listing,'w',encoding='utf8') as f:
            # 只写自产安全文件名，路径由 concat 文件位置解析。
            for index in range(len(clips)): f.write(f"file '{index}.mp4'\n")
        ready=os.path.join(folder,'result.mp4')
        command([ffmpeg,'-v','error','-y','-f','concat','-safe','1','-i',listing,'-map','0','-c','copy','-movflags','+faststart',ready])
        actual=json.loads(command([probe,'-v','error','-show_format','-of','json',ready]))
        actual_duration=float(actual['format']['duration']);expected=sum(b-a for a,b in ranges)
        if abs(actual_duration-expected)>max(.12,len(parts)*.04): raise ValueError('无损片段的实际时长偏移超过容差，未交付；请使用兼容合成')
        os.replace(ready,output)
    return {'path':output,'duration':actual_duration,'requestedDuration':expected,'mode':'stream-copy'}

def jianying_export(p):
    """只新建草稿文件，不覆盖剪映已有草稿，不调用 UI 自动化。"""
    import uuid, time
    import pyJianYingDraft as draft
    from pyJianYingDraft import assets
    folder = os.path.realpath(p['directory'])
    content_path = os.path.join(folder, 'draft_content.json')
    meta_path = os.path.join(folder, 'draft_meta_info.json')
    if os.path.exists(content_path) or os.path.exists(meta_path):
        raise ValueError('该目录已有剪映草稿，请选择新的导出目录')
    plan = p['plan']
    script = draft.ScriptFile(int(plan['width']), int(plan['height']), round(plan['fps']), False)
    script.append_tracks([draft.TrackSpec(draft.TrackType.video, '画面')])
    us = lambda sec: round(float(sec) * 1_000_000)
    cursor = 0
    for i, clip in enumerate(plan['clips']):
        path = os.path.realpath(clip['path'])
        if os.path.commonpath([folder, path]) != folder: raise ValueError('素材不在交付目录内')
        duration = us(clip['durSec'])
        segment = draft.VideoSegment(path, draft.Timerange(cursor, duration), source_timerange=draft.Timerange(us(clip['inSec']), duration), volume=0 if clip.get('muted') else clip.get('volume', 1), clip_settings=draft.ClipSettings(flip_horizontal=clip.get('flipH', False), flip_vertical=clip.get('flipV', False), rotation=clip.get('rotate', 0)))
        if clip.get('transition') == 'fade' and i < len(plan['clips']) - 1:
            segment.add_transition(draft.TransitionType.叠化, duration=us(min(clip.get('transitionDur') or .5, clip['durSec']/2, plan['clips'][i+1]['durSec']/2)))
        if clip.get('fadeIn', 0) > 0: segment.add_animation(draft.IntroType.渐显, duration=us(min(clip['fadeIn'], clip['durSec']/2)))
        if clip.get('fadeOut', 0) > 0: segment.add_animation(draft.OutroType.渐隐, duration=us(min(clip['fadeOut'], clip['durSec']/2)))
        script.add_segment(segment, '画面')
        cursor += duration
    for i, audio in enumerate(plan['audio']):
        if audio.get('muted'): continue
        path = os.path.realpath(audio['path'])
        if os.path.commonpath([folder, path]) != folder: raise ValueError('音频不在交付目录内')
        material = draft.AudioMaterial(path)
        duration = min(material.duration, cursor-us(audio['atSec']))
        if duration <= 0: continue
        name = f'音频 {i+1}'
        script.append_tracks([draft.TrackSpec(draft.TrackType.audio, name)])
        segment = draft.AudioSegment(material, draft.Timerange(us(audio['atSec']), duration), volume=audio.get('volume', 1))
        segment.add_fade(min(us(audio.get('fadeIn') or 0),duration//2), min(us(audio.get('fadeOut') or 0),duration//2))
        script.add_segment(segment, name)
    subtitle = os.path.join(folder, '字幕.srt')
    if os.path.isfile(subtitle): script.import_srt(subtitle, '字幕')
    script.content['name'] = p['name']
    script.dump(content_path)
    with open(assets.get_asset_path('DRAFT_META_TEMPLATE'), encoding='utf8') as f: meta = json.load(f)
    meta.update(draft_name=p['name'], draft_fold_path=folder, draft_id=str(uuid.uuid4()).upper(), tm_duration=cursor, tm_draft_create=us(time.time()), tm_draft_modified=us(time.time()))
    with open(meta_path, 'x', encoding='utf8') as f: json.dump(meta, f, ensure_ascii=False)
    return {'path':folder, 'durationUs':cursor, 'clips':len(plan['clips'])}

if __name__ == '__main__':
    try:
        print(json.dumps(run(json.load(sys.stdin)),ensure_ascii=True))
    except Exception as exc:
        print(json.dumps({'error':str(exc)},ensure_ascii=True)); sys.exit(1)
