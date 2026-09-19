/**
 * 统一浮层下拉系统 — LibLib 式圆角卡片弹层，全应用替代原生 <select>。
 * - PopLayer：通用浮层容器（点击外部 / Esc 关闭，弹性缩放淡入动画，按视口空间自动向上/向下翻转）
 * - PopSelect：通用下拉（触发按钮 = 当前值 + 下拉箭头；弹层列表项 = 图标 + 标题 + 描述 + 选中勾）
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { IcCheck, IcChevronD } from "./icons";

export interface PopOption {
  value: string;
  label: string;
  /** 第二行灰色小字描述（如服务商名） */
  desc?: string;
  icon?: ReactNode;
  disabled?: boolean;
  /** 二级选项：悬停、点击或键盘进入侧边列表。 */
  children?: PopOption[];
}

/** 当前打开的浮层栈（后开的在末尾）：Esc 只关最上层 */
const layerStack: RefObject<HTMLDivElement | null>[] = [];

/** 浮层容器：portal 到 document.body + position:fixed，按触发器实测坐标定位，
 *  绝不被任何父容器（设置面板 overflow、画布 transform 视口）裁剪——弹窗不受界面边界限制。
 *  点外部 / Esc 关闭；按视口空间自动向上/向下翻转；内容变化/窗口缩放/滚动时重定位。 */
export function PopLayer({
  anchorRef,
  onClose,
  up,
  children,
  className,
  style,
  side,
}: {
  /** 触发器所在容器：点在容器内（如触发按钮）不视为外部点击 */
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** 强制向上弹出；不传则按视口剩余空间自动判断 */
  up?: boolean;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  side?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef=useRef(onClose);
  closeRef.current=onClose;
  const [flipUp, setFlipUp] = useState(up ?? false);
  // 初始放到屏幕外，useLayoutEffect 在首帧绘制前量好坐标，避免闪烁
  const [pos, setPos] = useState<{ left: number; top: number; minW: number }>({ left: -9999, top: -9999, minW: 200 });

  // 翻转 + 视口坐标定位，按实测尺寸算；内容变化/缩放/滚动时重算
  useLayoutEffect(() => {
    const measure = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      const el = ref.current;
      if (!r || !el) return;
      const lw = el.offsetWidth;
      const lh = el.offsetHeight;
      const below = window.innerHeight - r.bottom;
      const flip = up ?? (below < lh + 16 && r.top > below);
      setFlipUp(flip);
      // 横向：默认与触发器左对齐；右边溢出则右对齐；最后整体收进视口
      let left = r.left + lw > window.innerWidth - 12 && r.right - lw > 0 ? r.right - lw : r.left;
      left = Math.max(8, Math.min(left, window.innerWidth - lw - 8));
      // 纵向：向下优先，下方不够则向上翻；整体收进视口
      let top = flip ? r.top - lh - 6 : r.bottom + 6;
      if(side){left=r.right+lw+8<window.innerWidth?r.right+4:r.left-lw-4;left=Math.max(8,Math.min(left,window.innerWidth-lw-8));top=r.top;}
      top = Math.max(8, Math.min(top, window.innerHeight - lh - 8));
      // 最小宽度：至少与触发器同宽（兜底 180），替代原先 max(100%,200px)（fixed 下 100%=视口，会撑满）
      setPos({ left, top, minW: side?220:Math.max(r.width, 180) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (ref.current) ro.observe(ref.current);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [up, side, anchorRef]);

  useEffect(() => {
    // 浮层栈：嵌套弹层时 Esc 只关最上面那层（否则一次全关，外层弹窗也跟着没了）
    layerStack.push(ref);
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      const index=layerStack.indexOf(ref);
      if(layerStack.slice(index+1).some(layer=>layer.current?.contains(t)))return;
      if (ref.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return; // 触发按钮的 onClick 自己处理开合
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (layerStack[layerStack.length - 1] !== ref) return;
      e.stopPropagation();
      closeRef.current();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      const i = layerStack.indexOf(ref);
      if (i >= 0) layerStack.splice(i, 1);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [anchorRef]);

  return createPortal(
    <div
      ref={ref}
      className={`pop-layer nodrag nowheel ${flipUp ? "up" : "down"} ${className ?? ""}`}
      style={{ position: "fixed", left: pos.left, top: pos.top, right: "auto", bottom: "auto", minWidth: pos.minW, ...style }}
    >
      {children}
    </div>,
    document.body,
  );
}

/** 通用下拉：原生 select 的完整替代（动作型用法：value 固定传 ""，onChange 即触发动作） */
export function PopSelect({
  value,
  options,
  onChange,
  placeholder = "请选择…",
  title,
  className,
  layerClassName,
  style,
  up,
  disabled,
  triggerIcon,
}: {
  value: string;
  options: PopOption[];
  onChange: (v: string) => void;
  placeholder?: string;
  /** 弹层顶部标题（如「模型选择」） */
  title?: string;
  className?: string;
  /** 弹层附加类名（调宽 / 右对齐等） */
  layerClassName?: string;
  style?: CSSProperties;
  up?: boolean;
  disabled?: boolean;
  /** 触发按钮也显示当前项图标（默认只显示文字） */
  triggerIcon?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const childRef=useRef<HTMLButtonElement|null>(null);
  const [group,setGroup]=useState<PopOption|null>(null);
  const activeGroup=options.find(o=>o.value===group?.value);
  const cur = options.flatMap(o=>o.children??[o]).find((o) => o.value === value);
  const close=()=>{setOpen(false);setGroup(null);};
  return (
    <div ref={wrapRef} className={`pop-wrap ${className ?? ""}`} style={style}>
      <button
        type="button"
        className={`pop-trigger ${open ? "open" : ""}`}
        disabled={disabled}
        onClick={() => {setOpen((v) => !v);setGroup(null);}}
      >
        {triggerIcon && cur?.icon ? <span className="pt-ic">{cur.icon}</span> : null}
        <span className={`pt-label ${cur ? "" : "ph"}`}>{cur ? cur.label : placeholder}</span>
        <IcChevronD size={13} />
      </button>
      {open ? (
        <PopLayer anchorRef={wrapRef} onClose={close} up={up} className={layerClassName}>
          {title ? <div className="pop-title">{title}</div> : null}
          <div className="pop-list">
            {options.map((o) => (
              <button
                key={o.value || "__ph__"}
                type="button"
                className={`pop-item ${o.value === value ? "on" : ""}`}
                disabled={o.disabled}
                aria-haspopup={o.children?"menu":undefined}
                onMouseEnter={e=>{childRef.current=e.currentTarget;setGroup(o.children?o:null);}}
                onFocus={e=>{if(o.children){childRef.current=e.currentTarget;setGroup(o);}}}
                onKeyDown={e=>{if(o.children&&e.key==="ArrowRight"){e.preventDefault();childRef.current=e.currentTarget;setGroup(o);}}}
                onClick={(e) => {
                  if (o.disabled) return;
                  if(o.children){childRef.current=e.currentTarget;setGroup(o);return;}
                  onChange(o.value);
                  close();
                }}
              >
                {o.icon ? <span className="pi-icon">{o.icon}</span> : null}
                <span className="pi-text">
                  <span className="pi-label">{o.label}</span>
                  {o.desc ? <span className="pi-desc">{o.desc}</span> : null}
                </span>
                {o.value === value ? <IcCheck size={15} /> : null}
                {o.children?<span aria-hidden="true">›</span>:null}
              </button>
            ))}
          </div>
          {activeGroup?.children?<PopLayer key={activeGroup.value} anchorRef={childRef} side onClose={()=>setGroup(null)} className={layerClassName}>
            <div className="pop-title">{activeGroup.label}</div><div className="pop-list">{activeGroup.children.map(o=><button type="button" key={o.value} className={`pop-item ${o.value===value?"on":""}`} disabled={o.disabled} onClick={()=>{onChange(o.value);close();}}>
              {o.icon?<span className="pi-icon">{o.icon}</span>:null}<span className="pi-text"><span className="pi-label">{o.label}</span>{o.desc?<span className="pi-desc">{o.desc}</span>:null}</span>{o.value===value?<IcCheck size={15}/>:null}
            </button>)}</div>
          </PopLayer>:null}
        </PopLayer>
      ) : null}
    </div>
  );
}
