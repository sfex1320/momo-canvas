"""独立 Python / ONNX / VTracer CLI 样例比较；不调用 ComfyUI，不改正式模型。

测试的是裸权重，不代表 MOMO 含保真校正与拼块的完整管线。
先下载并校验官方 VTracer 1.0.0-alpha.4 Windows CLI 到 .codex/vector-research/vtracer。
"""
from pathlib import Path
import json, time, subprocess
import numpy as np
from PIL import Image, ImageDraw, ImageFont
import onnxruntime as ort

root = Path(__file__).resolve().parents[2]
out = root / '.codex/vector-research'
out.mkdir(parents=True, exist_ok=True)
palette = ['#f5ebd7', '#a62e30', '#214f56', '#e4b558']
# 超采样绘制，保留高分辨率真值，再下采样得到 128×96 的测试输入。
k = 4
im = Image.new('RGB', (512*k, 384*k), palette[0])
d = ImageDraw.Draw(im)
d.ellipse((40*k, 30*k, 210*k, 200*k), fill=palette[1])
d.ellipse((85*k, 75*k, 165*k, 155*k), fill=palette[0])
d.polygon([(220*k, 40*k), (465*k, 60*k), (355*k, 220*k)], fill=palette[2])
d.rounded_rectangle((35*k, 245*k, 475*k, 351*k), radius=18*k, fill=palette[3])
font = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 44*k)
d.text((64*k, 256*k), '文化 · 共生', font=font, fill=palette[2])
ref = im.resize((512,384), Image.Resampling.LANCZOS)
ref.save(out/'reference.png')
low = ref.resize((128,96), Image.Resampling.LANCZOS)
low.save(out/'input.png')
low.resize(ref.size, Image.Resampling.LANCZOS).save(out/'lanczos.png')
rows = []
for name, flags in [
    ('trace-default', ['--preset', 'poster']),
    ('trace-palette', ['--preset', 'poster', '--palette', ','.join(palette), '--simplify', '1']),
    ('trace-cutout', ['--preset', 'poster', '--palette', ','.join(palette), '--hierarchical', 'cutout', '--simplify', '1']),
]:
    start = time.perf_counter()
    subprocess.run([str(out/'vtracer/vtracer.exe'), str(out/'input.png'), str(out/f'{name}.svg'), *flags], check=True, capture_output=True)
    rows.append({'name':name, 'seconds':round(time.perf_counter()-start,3), 'bytes':(out/f'{name}.svg').stat().st_size})
    print(rows[-1], flush=True)
tensor = np.asarray(low).astype(np.float32).transpose(2,0,1)[None] / 255
for name, filename in [('span', '4xNomosUni_span_multijpg_fp32_opset17.onnx'), ('nomos', '4xNomosWebPhoto_esrgan_fp32_opset17.onnx')]:
    opts = ort.SessionOptions(); opts.intra_op_num_threads = 8
    start = time.perf_counter()
    session = ort.InferenceSession(str(root/'models/sr'/filename), sess_options=opts, providers=['CPUExecutionProvider'])
    value = session.run(None, {session.get_inputs()[0].name: tensor})[0][0].transpose(1,2,0)
    result = Image.fromarray(np.clip(value*255,0,255).round().astype(np.uint8))
    result.save(out/f'{name}.png')
    rows.append({'name':name, 'seconds':round(time.perf_counter()-start,3), 'provider':'CPU', 'scope':'裸模型，不含 MOMO 后处理'})
    print(rows[-1], flush=True)
    del session
(out/'timing.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding='utf-8')
