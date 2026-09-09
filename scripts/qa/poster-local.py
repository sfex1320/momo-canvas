"""在真实生成样例上比较已有 U2NetP 与人工标记 GrabCut；不下载新模型。"""
import base64, importlib.util, io, json
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[2]
out = root / '.codex/poster-acceptance'
spec = importlib.util.spec_from_file_location('production', root / 'src-tauri/src/production_tools.py')
production = importlib.util.module_from_spec(spec)
spec.loader.exec_module(production)
original = Image.open(out / '海报实测-1.png').convert('RGBA')
# 人工看图校准的杯子范围，包含完整杯沿、杯底和把手，保留少量背景边缘。
box = (250, 805, 880, 1320)
crop = original.crop(box)
source = production.png_of(crop)
marks = Image.new('RGBA', crop.size)
draw = ImageDraw.Draw(marks)
draw.line([(130, 140), (170, 310), (265, 345)], fill=(0, 255, 0, 255), width=16)
draw.ellipse((200, 220, 290, 300), fill=(0, 255, 0, 255))
draw.line([(500, 180), (510, 260)], fill=(255, 0, 0, 255), width=12)
reports = []
initial = None
for method in ['semantic', 'segment', 'hybrid']:
    op = 'semantic' if method == 'semantic' else 'segment'
    result = production.run({'op': op, 'image': source, **({'marks': production.png_of(marks)} if op == 'segment' else {}), **({'initial': initial} if method == 'hybrid' else {})})
    if method == 'semantic': initial = result['png']
    img = Image.open(io.BytesIO(base64.b64decode(result['png'].split(',')[1]))).convert('RGBA')
    img.save(out / f'杯子-{method}.png')
    # 同一高光与杯把空洞采样，作为透明度检查，不等同于全图质量评分。
    reports.append({'method': method, 'width': img.width, 'height': img.height,
                    'white_print_alpha': img.getpixel((240, 260))[3],
                    'handle_hole_alpha': img.getpixel((510, 235))[3],
                    'corner_alpha': img.getpixel((0, 0))[3], 'manual_box': list(box),
                    'manual_marks': op == 'segment'})
    preview = Image.new('RGBA', img.size, '#537b89'); preview.alpha_composite(img)
    preview.convert('RGB').save(out / f'杯子-{method}-预览.png')
(out / 'local-report.json').write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(reports, ensure_ascii=False))
