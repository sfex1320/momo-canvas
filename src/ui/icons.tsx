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
        <stop stopColor="#5B8CFF" />
        <stop offset="0.6" stopColor="#9A6BFF" />
        <stop offset="1" stopColor="#C86BFF" />
      </linearGradient>
    </defs>
  </svg>
);

export const IcImage = (p: IconProps) => (
  <I {...p}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M3.5 17.5 9 12.5l4 3.6 3.2-2.8 4.3 4" />
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
