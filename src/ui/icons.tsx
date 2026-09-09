/**
 * SVG 图标集 — 统一 24 viewBox / 1.8 描边 / currentColor
 */
import type { CSSProperties, ReactNode } from "react";

type IconProps = { size?: number; className?: string; style?: CSSProperties };

function I({ children, size = 20, className, style, fill = false }: IconProps & { children: ReactNode; fill?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? "currentColor" : "none"}
      stroke={fill ? "none" : "currentColor"}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden
    >
      {children}
    </svg>
  );
}

/* 品牌 mark：画布 + 火花 */
export const IcLogo = (p: IconProps) => (
  <svg width={p.size ?? 22} height={p.size ?? 22} viewBox="0 0 48 48" fill="none" aria-hidden style={p.style}>
    <rect x="4" y="4" width="40" height="40" rx="12" fill="url(#momoG)" />
    <path
      d="M14 32V17.5c0-1 1.2-1.5 2-.8l6.4 6.1c.9.8 2.3.8 3.2 0l6.4-6.1c.8-.7 2-.2 2 .8V32"
      stroke="#fff"
      strokeWidth="3.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="36.5" cy="11.5" r="3" fill="#fff" opacity="0.95" />
    <defs>
      <linearGradient id="momoG" x1="4" y1="4" x2="44" y2="44">
        <stop stopColor="var(--logo-from, #5B8CFF)" />
        <stop offset="0.6" stopColor="var(--logo-mid, #9A6BFF)" />
        <stop offset="1" stopColor="var(--logo-to, #C86BFF)" />
      </linearGradient>
    </defs>
  </svg>
);

/* 局部重绘：画笔 + 虚线选区 */
export const IcBrush = (p: IconProps) => (
  <I {...p}>
    <path d="M14.5 5.5 18.5 9.5 10 18l-4.6 1.1a.6.6 0 0 1-.7-.7L5.8 14z" />
    <path d="M17 3l4 4" />
    <path d="M3 9.5V7a2 2 0 0 1 .8-1.6M21 14.5V17a2 2 0 0 1-.8 1.6" strokeDasharray="2.6 2.6" />
  </I>
);

/* 扩图：中心画面 + 四角外扩箭头 */
export const IcExpand = (p: IconProps) => (
  <I {...p}>
    <rect x="8.5" y="8.5" width="7" height="7" rx="1.4" />
    <path d="M3 8V4.5A1.5 1.5 0 0 1 4.5 3H8M16 3h3.5A1.5 1.5 0 0 1 21 4.5V8M21 16v3.5a1.5 1.5 0 0 1-1.5 1.5H16M8 21H4.5A1.5 1.5 0 0 1 3 19.5V16" />
  </I>
);

/* 抠图：剪刀 + 主体轮廓 */
export const IcScissors = (p: IconProps) => (
  <I {...p}>
    <circle cx="6" cy="7" r="2.4" />
    <circle cx="6" cy="17" r="2.4" />
    <path d="M8.1 8.4 20 17M8.1 15.6 20 7" />
  </I>
);

/* 高清增强：向上箭头 + 闪光 */
export const IcEnhance = (p: IconProps) => (
  <I {...p}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" />
    <path d="M12 16.5v-8M8.6 11.5 12 8l3.4 3.5" />
    <path d="M17.6 5.2l.5 1.2 1.2.5-1.2.5-.5 1.2-.5-1.2-1.2-.5 1.2-.5z" fill="currentColor" strokeWidth="0.6" />
  </I>
);

/* 聚焦裁剪：裁切框 + 取景角 */
export const IcCrop = (p: IconProps) => (
  <I {...p}>
    <path d="M7 3v12a2 2 0 0 0 2 2h12" />
    <path d="M3 7h12a2 2 0 0 1 2 2v12" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" strokeWidth="0" />
  </I>
);

/* 宫格切分：整图九宫格等分（抽卡关键帧拆格） */
export const IcGrid = (p: IconProps) => (
  <I {...p}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
    <path d="M9.2 3.5v17M14.8 3.5v17M3.5 9.2h17M3.5 14.8h17" />
  </I>
);

/* 超清放大：放大镜 + 镜内上箭头（本地超分） */
export const IcUpscale = (p: IconProps) => (
  <I {...p}>
    <circle cx="10.5" cy="10.5" r="6.8" />
    <path d="m15.4 15.4 5.1 5.1" />
    <path d="M10.5 13.8V8.6M8.1 10.7l2.4-2.4 2.4 2.4" />
  </I>
);

/* 智能矢量：锚点方块 + 贝塞尔曲线 + 手柄（钢笔路径） */
export const IcVector = (p: IconProps) => (
  <I {...p}>
    <path d="M5.5 18.5C8.5 10.5 15.5 9 18.5 5.5" />
    <path d="M6.6 16.6 9.3 11.2M17.4 7.4l-2.6-1" strokeDasharray="1.6 2" />
    <circle cx="9.3" cy="11.2" r="1.2" fill="currentColor" strokeWidth="0" />
    <circle cx="14.8" cy="6.4" r="1.2" fill="currentColor" strokeWidth="0" />
    <rect x="3.5" y="16.5" width="4.2" height="4.2" rx="1" />
    <rect x="16.3" y="3.4" width="4.2" height="4.2" rx="1" />
  </I>
);

/* 极速：闪电 */
export const IcZap = (p: IconProps) => (
  <I {...p}>
    <path d="M13 2.5 3.5 14h7l-1 7.5L19 10h-7z" />
  </I>
);

/* 清理：扫帚 */
export const IcBroom = (p: IconProps) => (
  <I {...p}>
    <path d="M20.5 3.5l-7.8 7.8" />
    <path d="M13.2 10.8l1.6 1.6-4.5 4.5c-1 1-2.5 1.1-3.5.2l-.7-.7c-.9-.9-.8-2.5.2-3.5z" />
    <path d="M6.4 19.1l-2.4 2.4" />
    <path d="M9 20.2l-1.6 2.1" />
  </I>
);

/* 专业：钻石 */
export const IcDiamond = (p: IconProps) => (
  <I {...p}>
    <path d="M7 4h10L20.5 9 12 20 3.5 9Z" />
    <path d="M3.5 9h17" />
    <path d="m7 4 2.5 5L12 20l2.5-11L17 4" />
  </I>
);

/* 黑白：半填圆 */
export const IcContrast = (p: IconProps) => (
  <I {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" strokeWidth="0" />
  </I>
);

export const IcImage = (p: IconProps) => (
  <I {...p}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M3.5 17.5 9 12.5l4 3.6 3.2-2.8 4.3 4" />
  </I>
);

/* 电商长图：竖版长图 + 分段（详情页切片拼接） */
export const IcEcom = (p: IconProps) => (
  <I {...p}>
    <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
    <path d="M9 6.5h6" />
    <path d="M9 10.5h6" />
    <path d="M9 14.5h6" />
    <path d="M9 18h4" />
  </I>
);

export const IcText = (p: IconProps) => (
  <I {...p}>
    <path d="M5 6.5V5h14v1.5" />
    <path d="M12 5v14M9.5 19h5" />
  </I>
);

export const IcChat = (p: IconProps) => (
  <I {...p}>
    <path d="M21 12a8 8 0 0 1-8 8H4l2.3-2.7A8 8 0 1 1 21 12Z" />
    <path d="M8.5 10.5h7M8.5 13.8h4.5" />
  </I>
);

export const IcSparkles = (p: IconProps) => (
  <I {...p}>
    <path d="M12 3.5 13.8 9 19 10.8 13.8 12.6 12 18l-1.8-5.4L5 10.8 10.2 9 12 3.5Z" />
    <path d="M18.6 15.6l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" />
  </I>
);

export const IcVideo = (p: IconProps) => (
  <I {...p}>
    <rect x="3" y="6" width="13.5" height="12" rx="3" />
    <path d="m16.5 10.5 4.5-2.6v8.2l-4.5-2.6" />
  </I>
);

export const IcFlow = (p: IconProps) => (
  <I {...p}>
    <rect x="3" y="3.5" width="7" height="6" rx="2" />
    <rect x="14" y="14.5" width="7" height="6" rx="2" />
    <path d="M10 6.5h4.5a2 2 0 0 1 2 2v3M14 17.5H9.5a2 2 0 0 1-2-2v-3" />
  </I>
);

export const IcGear = (p: IconProps) => (
  <I {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 2.8 13.5 5h2.6l.9 2.4 2.3 1.1-.4 2.6 1.6 2-1.6 2 .4 2.6-2.3 1.1-.9 2.4h-2.6L12 21.2 10.5 19H7.9L7 16.6l-2.3-1.1.4-2.6-1.6-2 1.6-2-.4-2.6L7 5.3 7.9 5h2.6L12 2.8Z" />
  </I>
);

export const IcSun = (p: IconProps) => (
  <I {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5 5l1.6 1.6M17.4 17.4 19 19M19 5l-1.6 1.6M6.6 17.4 5 19" />
  </I>
);

export const IcMoon = (p: IconProps) => (
  <I {...p}>
    <path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z" />
  </I>
);
export const IcBlack = (p: IconProps) => (
  <I {...p}>
    {/* 深邃黑：实心圆 + 右上角暖橙弧光，呼应黑主题冷暖反差 */}
    <circle cx="12" cy="12" r="8.5" fill="currentColor" stroke="none" />
    <path d="M16.5 7.5a3 3 0 0 0 0 6" stroke="#ff9a3c" strokeWidth="1.6" fill="none" strokeLinecap="round" />
  </I>
);

export const IcMin = (p: IconProps) => (
  <I {...p}>
    <path d="M5 12h14" />
  </I>
);

export const IcMax = (p: IconProps) => (
  <I {...p}>
    <rect x="5" y="5" width="14" height="14" rx="2" />
  </I>
);

export const IcRestore = (p: IconProps) => (
  <I {...p}>
    <rect x="5" y="8" width="11" height="11" rx="2" />
    <path d="M8.5 5H17a2 2 0 0 1 2 2v8.5" />
  </I>
);

export const IcClose = (p: IconProps) => (
  <I {...p}>
    <path d="m6 6 12 12M18 6 6 18" />
  </I>
);

export const IcPlus = (p: IconProps) => (
  <I {...p}>
    <path d="M12 5v14M5 12h14" />
  </I>
);

export const IcTrash = (p: IconProps) => (
  <I {...p}>
    <path d="M4 7h16M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12" />
    <path d="M10 11v6M14 11v6" />
  </I>
);

export const IcCopy = (p: IconProps) => (
  <I {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2.5" />
    <path d="M5.5 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v.5" />
  </I>
);

export const IcDownload = (p: IconProps) => (
  <I {...p}>
    <path d="M12 4v11M7.5 11 12 15.5 16.5 11" />
    <path d="M4.5 19.5h15" />
  </I>
);

export const IcPlay = (p: IconProps) => (
  <I {...p} fill>
    <path d="M8.2 5.6a1 1 0 0 1 1.5-.9l9.2 6.4a1 1 0 0 1 0 1.7l-9.2 6.4a1 1 0 0 1-1.5-.8V5.6Z" />
  </I>
);

/** 暂停（Comfy 同步中心的来源/工作流暂停按钮） */
export const IcPause = (p: IconProps) => (
  <I {...p} fill>
    <rect x="7" y="5" width="3.4" height="14" rx="1.2" />
    <rect x="13.6" y="5" width="3.4" height="14" rx="1.2" />
  </I>
);

/** 差异对比（Comfy 同步中心的「查看差异」） */
export const IcDiff = (p: IconProps) => (
  <I {...p}>
    <rect x="3" y="4.5" width="8" height="15" rx="2" />
    <path d="M14 8.5h7M17.5 5v7M14 15.5h7" />
  </I>
);

export const IcRefresh = (p: IconProps) => (
  <I {...p}>
    <path d="M20 12a8 8 0 1 1-2.4-5.7" />
    <path d="M20 3.5V8h-4.5" />
  </I>
);

export const IcGlobe = (p: IconProps) => (
  <I {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.6 2.3 3.9 5.2 3.9 8.5s-1.3 6.2-3.9 8.5c-2.6-2.3-3.9-5.2-3.9-8.5S9.4 5.8 12 3.5Z" />
  </I>
);

export const IcBrain = (p: IconProps) => (
  <I {...p}>
    <path d="M9.5 4.5A2.8 2.8 0 0 0 6 7.2a3 3 0 0 0-1.8 5A3 3 0 0 0 6 17.4 2.9 2.9 0 0 0 11 19V6.7a2.5 2.5 0 0 0-1.5-2.2Z" />
    <path d="M14.5 4.5A2.8 2.8 0 0 1 18 7.2a3 3 0 0 1 1.8 5A3 3 0 0 1 18 17.4 2.9 2.9 0 0 1 13 19V6.7a2.5 2.5 0 0 1 1.5-2.2Z" />
  </I>
);

export const IcFolder = (p: IconProps) => (
  <I {...p}>
    <path d="M3.5 7A2.5 2.5 0 0 1 6 4.5h3.6l2 2.5H18A2.5 2.5 0 0 1 20.5 9.5v7A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5V7Z" />
  </I>
);

export const IcCheck = (p: IconProps) => (
  <I {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </I>
);

export const IcStar = (p: IconProps) => (
  <I {...p}>
    <path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 17l-5.2 2.6 1-5.8L3.5 9.7l5.9-.8L12 3.5z" />
  </I>
);

export const IcChevronD = (p: IconProps) => (
  <I {...p}>
    <path d="m6 9.5 6 6 6-6" />
  </I>
);

export const IcUpload = (p: IconProps) => (
  <I {...p}>
    <path d="M12 15.5V4.5M7.5 9 12 4.5 16.5 9" />
    <path d="M4.5 19.5h15" />
  </I>
);

export const IcDice = (p: IconProps) => (
  <I {...p}>
    <rect x="4" y="4" width="16" height="16" rx="4" />
    <circle cx="9" cy="9" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="15" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="9" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="9" cy="15" r="1.1" fill="currentColor" stroke="none" />
  </I>
);

export const IcGallery = (p: IconProps) => (
  <I {...p}>
    <rect x="3.5" y="3.5" width="7.5" height="7.5" rx="2" />
    <rect x="13" y="3.5" width="7.5" height="7.5" rx="2" />
    <rect x="3.5" y="13" width="7.5" height="7.5" rx="2" />
    <rect x="13" y="13" width="7.5" height="7.5" rx="2" />
  </I>
);

export const IcEdit = (p: IconProps) => (
  <I {...p}>
    <path d="M4.5 19.5h15" />
    <path d="m13.7 5 3.3 3.3L9.3 16 5 17l1-4.3L13.7 5Z" />
  </I>
);

export const IcLayers = (p: IconProps) => (
  <I {...p}>
    <path d="m12 3.5 8.5 4.5L12 12.5 3.5 8 12 3.5Z" />
    <path d="m4.5 12.5 7.5 4 7.5-4M4.5 16.5l7.5 4 7.5-4" />
  </I>
);

export const IcFit = (p: IconProps) => (
  <I {...p}>
    <path d="M4 9V6a2 2 0 0 1 2-2h3M15 4h3a2 2 0 0 1 2 2v3M20 15v3a2 2 0 0 1-2 2h-3M9 20H6a2 2 0 0 1-2-2v-3" />
  </I>
);

/* 尺寸调整：大框缩小框 + 对角箭头 */
export const IcResize = (p: IconProps) => (
  <I {...p}>
    <path d="M4 4h9v9H4z" />
    <path d="M20 14v4a2 2 0 0 1-2 2h-4" />
    <path d="M16.5 10.5 20 7m0 0h-3.2M20 7v3.2" />
  </I>
);

export const IcLoading = (p: IconProps) => (
  <I {...p} className={`spin ${p.className ?? ""}`}>
    <path d="M12 3a9 9 0 1 0 9 9" />
  </I>
);

export const IcSearch = (p: IconProps) => (
  <I {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </I>
);

/** 停止（运行中任务的停止按钮）：圆圈套一个实心小方块 */
export const IcStop = (p: IconProps) => (
  <I {...p}>
    <circle cx="12" cy="12" r="9" />
    <rect x="8.5" y="8.5" width="7" height="7" rx="1.2" fill="currentColor" stroke="none" />
  </I>
);

export const IcLink = (p: IconProps) => (
  <I {...p}>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 1 0-5.7-5.7l-1.2 1.2" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 1 0 5.7 5.7l1.2-1.2" />
  </I>
);

export const IcSend = (p: IconProps) => (
  <I {...p} fill>
    <path d="M3.4 11.1 19.8 4a.8.8 0 0 1 1.1 1L14 21.4a.8.8 0 0 1-1.5 0l-2.2-6.2a1 1 0 0 0-.6-.6l-6.2-2.2a.8.8 0 0 1 0-1.4Z" />
  </I>
);

export const IcLibrary = (p: IconProps) => (
  <I {...p}>
    <path d="M4 4.5h3.5v15H4zM9.5 4.5H13v15H9.5z" />
    <path d="m15 5.5 4.4 1.2-3.7 13.4-4.4-1.2z" />
  </I>
);

export const IcWand = (p: IconProps) => (
  <I {...p}>
    <path d="m14 7 3 3L6.5 20.5l-3-3L14 7Z" />
    <path d="m14 7 3 3M18.5 3v2.4M21.5 8.5h-2.4M19.8 4.7l-1.6 1.6" />
  </I>
);

export const IcPalette = (p: IconProps) => (
  <I {...p}>
    <path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-.8 2-1.7 0-.8-.5-1.3-.5-2 0-1 .8-1.8 2-1.8h1.8a3.2 3.2 0 0 0 3.2-3.2c0-4.6-3.9-8.3-8.5-8.3Z" />
    <circle cx="7.8" cy="10" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="12" cy="7.6" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="16.2" cy="10" r="1.2" fill="currentColor" stroke="none" />
  </I>
);

export const IcScan = (p: IconProps) => (
  <I {...p}>
    <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
    <circle cx="12" cy="12" r="3.2" />
  </I>
);

export const IcMerge = (p: IconProps) => (
  <I {...p}>
    <path d="M4 6h4l4.5 6H20M4 18h4l2.5-3.4" />
    <path d="m17 8.5 3.5 3.5-3.5 3.5" />
  </I>
);

export const IcNote = (p: IconProps) => (
  <I {...p}>
    <path d="M4.5 6A1.5 1.5 0 0 1 6 4.5h12A1.5 1.5 0 0 1 19.5 6v8.5L14.5 19.5H6A1.5 1.5 0 0 1 4.5 18V6Z" />
    <path d="M14.5 19.5V15a.5.5 0 0 1 .5-.5h4.5" />
  </I>
);

export const IcMusic = (p: IconProps) => (
  <I {...p}>
    <path d="M9 18.5V6l11-2v12.5" />
    <circle cx="6.5" cy="18.5" r="2.5" />
    <circle cx="17.5" cy="16.5" r="2.5" />
  </I>
);

/** 麦克风（生成音频：TTS/音乐） */
export const IcMic = (p: IconProps) => (
  <I {...p}>
    <rect x="9" y="3" width="6" height="11.5" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
    <path d="M12 18v3M9 21h6" />
  </I>
);

/** 视频配音（画面 + 声波） */
export const IcDub = (p: IconProps) => (
  <I {...p}>
    <rect x="2.5" y="5.5" width="12.5" height="12" rx="3" />
    <path d="M17.8 9.4a4.2 4.2 0 0 1 0 5.2" />
    <path d="M20.3 7.2a7.6 7.6 0 0 1 0 9.6" />
  </I>
);

export const IcFile = (p: IconProps) => (
  <I {...p}>
    <path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h6L18.5 8v11.5a1.5 1.5 0 0 1-1.5 1.5H7.5A1.5 1.5 0 0 1 6 19.5v-15Z" />
    <path d="M13.5 3v5h5" />
  </I>
);

export const IcFilter = (p: IconProps) => (
  <I {...p}>
    <path d="M4 5.5h16l-6.2 7.4v5.6l-3.6-1.8v-3.8L4 5.5Z" />
  </I>
);

export const IcTag = (p: IconProps) => (
  <I {...p}>
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h5.4c.4 0 .8.16 1.06.44l7.6 7.6a1.5 1.5 0 0 1 0 2.12l-5.4 5.4a1.5 1.5 0 0 1-2.12 0l-7.6-7.6A1.5 1.5 0 0 1 4 10.9V5.5Z" />
    <circle cx="8.6" cy="8.6" r="1.3" />
  </I>
);

export const IcFolderPlus = (p: IconProps) => (
  <I {...p}>
    <path d="M3.5 7A2.5 2.5 0 0 1 6 4.5h3.6l2 2.5H18A2.5 2.5 0 0 1 20.5 9.5v7A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5V7Z" />
    <path d="M12 10.5v5M9.5 13h5" />
  </I>
);

export const IcArrowL = (p: IconProps) => (
  <I {...p}>
    <path d="m14.5 6-6 6 6 6" />
  </I>
);

export const IcArrowR = (p: IconProps) => (
  <I {...p}>
    <path d="m9.5 6 6 6-6 6" />
  </I>
);

export const IcCheckSquare = (p: IconProps) => (
  <I {...p}>
    <rect x="4" y="4" width="16" height="16" rx="4" />
    <path d="m8.5 12 2.5 2.5 4.8-5" />
  </I>
);

export const IcLock = (p: IconProps) => (
  <I {...p}>
    <rect x="5" y="10.5" width="14" height="9.5" rx="2.5" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    <path d="M12 14.5v2" />
  </I>
);

export const IcUnlock = (p: IconProps) => (
  <I {...p}>
    <rect x="5" y="10.5" width="14" height="9.5" rx="2.5" />
    <path d="M8 10.5V8a4 4 0 0 1 7.8-1.2" />
    <path d="M12 14.5v2" />
  </I>
);

export const IcHistory = (p: IconProps) => (
  <I {...p}>
    <path d="M4 12a8 8 0 1 1 2.3 5.7" />
    <path d="M4 13.5V9h4.5" />
    <path d="M12 8v4.5l3 1.8" />
  </I>
);

export const IcActivity = (p: IconProps) => (
  <I {...p}>
    <path d="M3 12h3.5l2.5-6 4 12 2.5-6H21" />
  </I>
);

export const IcRows = (p: IconProps) => (
  <I {...p}>
    <path d="M4 6h16" />
    <path d="M4 12h12" />
    <path d="M4 18h16" />
  </I>
);

export const IcClapper = (p: IconProps) => (
  <I {...p}>
    <path d="M3.5 10h17v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V10Z" />
    <path d="M3.5 10 4.8 5.2 21 3.6l-1.1 4.6L3.5 10Z" />
    <path d="m8.4 9.5 1.2-4.2M13.2 9l1.2-4.2M18 8.6l1.2-4.2" />
  </I>
);

export const IcFilmFrame = (p: IconProps) => (
  <I {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M7 5v14M17 5v14M3 12h4M17 12h4" />
    <circle cx="12" cy="12" r="2.2" />
  </I>
);

export const IcFilmCut = (p: IconProps) => (
  <I {...p}>
    <rect x="2.5" y="7" width="19" height="10" rx="2" />
    <path d="M9 7v10M15 7v10" />
    <path d="M12 4v16" strokeDasharray="2.5 2.5" />
  </I>
);

export const IcFilmJoin = (p: IconProps) => (
  <I {...p}>
    <rect x="2.5" y="6" width="7.5" height="7" rx="1.5" />
    <rect x="14" y="6" width="7.5" height="7" rx="1.5" />
    <path d="M6 16.5v2h12v-2" />
    <path d="M10.5 9.5h3" />
  </I>
);

export const IcCursor = (p: IconProps) => (
  <I {...p} fill>
    <path d="M6.2 3.6a.8.8 0 0 1 1.3-.6l11.2 8.7a.8.8 0 0 1-.4 1.4l-4.8.6 2.7 5.4a.8.8 0 0 1-.35 1.07l-1.6.8a.8.8 0 0 1-1.07-.36l-2.7-5.4-3.5 3.4a.8.8 0 0 1-1.35-.55L6.2 3.6Z" />
  </I>
);

export const IcEye = (p: IconProps) => (
  <I {...p}>
    <path d="M2.5 12c1.5-3.2 4.9-6.1 9.5-6.1s8 2.9 9.5 6.1c-1.5 3.2-4.9 6.1-9.5 6.1S4 15.2 2.5 12Z" />
    <circle cx="12" cy="12" r="2.6" />
  </I>
);

export const IcEyeOff = (p: IconProps) => (
  <I {...p}>
    <path d="M4 4.5 20 19.5" />
    <path d="M9.6 6.2A9.8 9.8 0 0 1 12 5.9c4.4 0 7.6 3 9 6.1a11 11 0 0 1-3.2 4M6.4 7.6A11.4 11.4 0 0 0 3 12c1.4 3.1 4.6 6.1 9 6.1 1.2 0 2.3-.2 3.3-.6" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </I>
);

export const IcGroup = (p: IconProps) => (
  <I {...p}>
    <path d="M4 7V5.5A1.5 1.5 0 0 1 5.5 4H7M17 4h1.5A1.5 1.5 0 0 1 20 5.5V7M20 17v1.5a1.5 1.5 0 0 1-1.5 1.5H17M7 20H5.5A1.5 1.5 0 0 1 4 18.5V17M4 11.5v1M11.5 4h1M20 11.5v1M11.5 20h1" />
    <rect x="7.5" y="7.5" width="4" height="4" rx="1.2" />
    <rect x="12.5" y="12.5" width="4" height="4" rx="1.2" />
  </I>
);

export const IcKeyboard = (p: IconProps) => (
  <I {...p}>
    <rect x="3" y="6" width="18" height="12" rx="2.5" />
    <path d="M6.5 9.5h.01M10 9.5h.01M13.5 9.5h.01M17 9.5h.01M6.5 12.5h.01M10 12.5h.01M13.5 12.5h.01M17 12.5h.01M8 15.5h8" />
  </I>
);

export const IcUndo = (p: IconProps) => (
  <I {...p}>
    <path d="M8.5 6 4 10.5 8.5 15" />
    <path d="M4 10.5h10a6 6 0 0 1 6 6v1" />
  </I>
);

export const IcRedo = (p: IconProps) => (
  <I {...p}>
    <path d="M15.5 6 20 10.5 15.5 15" />
    <path d="M20 10.5H10a6 6 0 0 0-6 6v1" />
  </I>
);

/* 打光：灯泡 + 光线 */
export const IcBulb = (p: IconProps) => (
  <I {...p}>
    <path d="M12 3.2a5.8 5.8 0 0 1 3.5 10.4c-.8.6-1.1 1.3-1.1 2.1h-4.8c0-.8-.3-1.5-1.1-2.1A5.8 5.8 0 0 1 12 3.2Z" />
    <path d="M9.6 18.6h4.8M10.4 21h3.2" />
    <path d="M4.2 5.2l1.4 1.4M19.8 5.2l-1.4 1.4" />
  </I>
);

/* 多角度：主体 + 环绕轨道 */
export const IcOrbit = (p: IconProps) => (
  <I {...p}>
    <circle cx="12" cy="12" r="3.1" />
    <path d="M20.3 9.3c.8 1 .9 2 .3 2.9-1.3 2-5 3.5-9.2 3.7-4.2.2-7.6-.9-8.3-2.6-.4-.9 0-1.9.9-2.8" />
    <circle cx="18.6" cy="16.2" r="1.5" />
  </I>
);

/* 角色卡：证件卡片 */
export const IcIdCard = (p: IconProps) => (
  <I {...p}>
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
    <circle cx="8.6" cy="10.2" r="2" />
    <path d="M5.6 15.8c.6-1.7 1.7-2.5 3-2.5s2.4.8 3 2.5" />
    <path d="M14.2 9.2h4.2M14.2 12.2h4.2M14.2 15.2h2.6" />
  </I>
);

/* 角色库：两个人物 */
export const IcUsers = (p: IconProps) => (
  <I {...p}>
    <circle cx="9" cy="8.4" r="3.2" />
    <path d="M3.4 19.2c.7-3 2.9-4.7 5.6-4.7s4.9 1.7 5.6 4.7" />
    <path d="M15.4 5.6a3.2 3.2 0 0 1 .2 5.9M17.2 14.8c1.9.7 3.1 2.2 3.6 4.4" />
  </I>
);

export const IcBell = (p: IconProps) => (
  <I {...p}>
    <path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6" />
    <path d="M10 19a2.2 2.2 0 0 0 4 0" />
  </I>
);

/* 3D 导演台：单人偶 */
export const IcPerson = (p: IconProps) => (
  <I {...p}>
    <circle cx="12" cy="6.4" r="2.9" />
    <path d="M12 11v5.4M12 16.4l-3.2 4.6M12 16.4l3.2 4.6M5.8 12.6c2-1 4.2-1.6 6.2-1.6s4.2.6 6.2 1.6" />
  </I>
);

/* 3D 导演台：摄影机 */
export const IcCamera = (p: IconProps) => (
  <I {...p}>
    <rect x="3" y="7" width="13" height="11" rx="2.2" />
    <path d="M16 11.2 21 8v8.8l-5-3.2" />
    <circle cx="8" cy="12.5" r="2.2" />
  </I>
);

/* 3D 导演台：几何体 */
export const IcBox = (p: IconProps) => (
  <I {...p}>
    <path d="M12 3.2 20 7.6v8.8l-8 4.4-8-4.4V7.6Z" />
    <path d="M12 12.2 20 7.6M12 12.2 4 7.6M12 12.2v8.6" />
  </I>
);

/* 3D 导演台：旋转模式（圆弧箭头） */
export const IcRotate = (p: IconProps) => (
  <I {...p}>
    <path d="M20 12a8 8 0 1 1-2.5-5.8" />
    <path d="M20 3.6v4h-4" />
  </I>
);

/* 3D 导演台：移动模式（四向箭头） */
export const IcMove = (p: IconProps) => (
  <I {...p}>
    <path d="M12 3v18M3 12h18" />
    <path d="M9.4 5.6 12 3l2.6 2.6M9.4 18.4 12 21l2.6-2.6M5.6 9.4 3 12l2.6 2.6M18.4 9.4 21 12l-2.6 2.6" />
  </I>
);

/* 3D 导演台：姿势（抬手人形） */
export const IcPose = (p: IconProps) => (
  <I {...p}>
    <circle cx="12" cy="5.6" r="2.6" />
    <path d="M12 9.6v5M12 14.6l-2.8 4.2M12 14.6l2.8 4.2M7 4.8c1.6 2 3.2 3 5 3s3.4-1 5-3" />
  </I>
);

/* 警告：三角 + 感叹号 */
export const IcWarn = (p: IconProps) => (
  <I {...p}>
    <path d="M12 4.2 21 19.2H3z" />
    <path d="M12 10v4.4" />
    <circle cx="12" cy="16.8" r="0.4" fill="currentColor" stroke="none" />
  </I>
);

/* 耗时：圆形秒表 */
export const IcTimer = (p: IconProps) => (
  <I {...p}>
    <circle cx="12" cy="13.4" r="7.4" />
    <path d="M12 9.6v3.8l2.6 1.8" />
    <path d="M9.6 3h4.8" />
  </I>
);


/* Eagle 资产桥：展翅鹰形 */
export const IcEagle = (p: IconProps) => (
  <I {...p}>
    <path d="M12 8.5c-1.2-2.4-3.4-3.9-6.6-4.4 2 1 3.2 2.2 3.7 3.5-2.4-.6-4.6-.2-6.6 1.3 1.9.2 3.4.8 4.4 1.8-1.5.5-2.6 1.5-3.3 3 1.8-1 3.6-1.3 5.4-.9L12 15l3-2.2c1.8-.4 3.6-.1 5.4.9-.7-1.5-1.8-2.5-3.3-3 1-1 2.5-1.6 4.4-1.8-2-1.5-4.2-1.9-6.6-1.3.5-1.3 1.7-2.5 3.7-3.5-3.2.5-5.4 2-6.6 4.4Z" />
    <path d="M10.6 16.4c.4 1 .8 1.8 1.4 2.6.6-.8 1-1.6 1.4-2.6" />
  </I>
);
