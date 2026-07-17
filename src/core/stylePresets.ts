/**
 * 风格预设库 — 内置提示词片段（中文标签 → 英文片段）
 */
export type StyleEntry = { label: string; value: string };

export const STYLE_PRESETS: Record<string, StyleEntry[]> = {
  艺术风格: [
    { label: "吉卜力动画", value: "Studio Ghibli style, hand-painted animation" },
    { label: "赛博朋克", value: "cyberpunk, neon lights, futuristic city" },
    { label: "国风水墨", value: "traditional Chinese ink painting, shan shui" },
    { label: "油画厚涂", value: "impasto oil painting, thick brush strokes" },
    { label: "扁平插画", value: "flat vector illustration, minimal shapes" },
    { label: "像素艺术", value: "pixel art, 16-bit retro game style" },
    { label: "水彩", value: "watercolor painting, soft edges, paper texture" },
    { label: "3D 渲染", value: "octane render, 3D, physically based rendering" },
    { label: "黏土定格", value: "claymation, stop motion, plasticine texture" },
    { label: "浮世绘", value: "ukiyo-e, Japanese woodblock print" },
    { label: "蒸汽波", value: "vaporwave aesthetic, retro futurism, pastel gradients" },
    { label: "极简主义", value: "minimalist, negative space, clean composition" },
  ],
  光影: [
    { label: "电影布光", value: "cinematic lighting, dramatic shadows" },
    { label: "黄金时刻", value: "golden hour, warm sunlight, long shadows" },
    { label: "霓虹夜景", value: "neon glow, night scene, reflective surfaces" },
    { label: "柔光棚拍", value: "soft studio lighting, diffused light" },
    { label: "逆光剪影", value: "backlight, rim light, silhouette" },
    { label: "体积光", value: "volumetric light, god rays, atmospheric" },
    { label: "烛光暖调", value: "candlelight, warm amber tones, cozy" },
    { label: "冷月清辉", value: "moonlight, cool blue tones, tranquil night" },
  ],
  镜头: [
    { label: "特写", value: "close-up shot, shallow depth of field" },
    { label: "广角全景", value: "wide angle panorama, expansive view" },
    { label: "俯拍航拍", value: "aerial view, drone shot, top-down" },
    { label: "低角度仰拍", value: "low angle shot, towering perspective" },
    { label: "微距", value: "macro photography, extreme detail" },
    { label: "鱼眼", value: "fisheye lens, distorted perspective" },
    { label: "移轴微缩", value: "tilt-shift, miniature effect" },
    { label: "长焦压缩", value: "telephoto compression, bokeh background" },
  ],
  质感: [
    { label: "8K 超清", value: "8K resolution, ultra detailed, sharp focus" },
    { label: "胶片颗粒", value: "film grain, Kodak Portra 400, analog photo" },
    { label: "磨砂玻璃", value: "frosted glass, translucent material" },
    { label: "金属拉丝", value: "brushed metal, metallic reflections" },
    { label: "丝绒织物", value: "velvet fabric, soft plush texture" },
    { label: "湿润反光", value: "wet surface, glossy reflections, rain" },
  ],
  氛围: [
    { label: "梦幻仙境", value: "dreamy, ethereal, fairy tale atmosphere" },
    { label: "史诗宏大", value: "epic scale, grand, awe-inspiring" },
    { label: "静谧治愈", value: "serene, peaceful, healing atmosphere" },
    { label: "神秘暗黑", value: "mysterious, dark fantasy, ominous" },
    { label: "热闹烟火气", value: "lively street, bustling, warm human touch" },
    { label: "孤独苍凉", value: "lonely, desolate, melancholic vast emptiness" },
  ],
  色彩: [
    { label: "莫兰迪低饱和", value: "muted morandi color palette, low saturation" },
    { label: "高饱和撞色", value: "vibrant complementary colors, bold contrast" },
    { label: "黑白灰", value: "monochrome, black and white, grayscale" },
    { label: "马卡龙粉彩", value: "pastel macaron colors, soft and sweet" },
    { label: "青橙电影感", value: "teal and orange color grading, cinematic" },
    { label: "复古暖褐", value: "vintage sepia tones, nostalgic warmth" },
  ],
};

export const STYLE_CATEGORIES = Object.keys(STYLE_PRESETS);
