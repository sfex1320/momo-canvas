/**
 * 提示词历史/收藏按钮 + 弹层 — 提示词节点与生成节点共用
 *  生成成功的提示词自动入库（promptHistStore）；这里可搜索、收藏置顶、点选回填。
 */
import { useEffect, useRef, useState } from "react";
import { usePromptHist } from "../core/stores/promptHistStore";
import { IcHistory, IcTrash } from "./icons";

export function PromptHistoryBtn({ onPick }: { onPick: (text: string) => void }) {
  const items = usePromptHist((s) => s.items);
  const [open, setOpen] = useState(false);
  const [kw, setKw] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void usePromptHist.getState().init();
  }, []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const list = items
    .filter((i) => !kw || i.text.toLowerCase().includes(kw.toLowerCase()))
    .sort((a, b) => Number(b.pin) - Number(a.pin) || b.ts - a.ts)
    .slice(0, 60);

  return (
    <div className="phist nodrag" ref={ref}>
      <button
        className={`btn sm ${open ? "on" : ""}`}
        title="提示词历史：生成成功的提示词自动收录，点选回填；⭐ 收藏置顶"
        onClick={() => setOpen(!open)}
      >
        <IcHistory size={15} /> 历史
      </button>
      {open ? (
        <div className="phist-pop glass nowheel">
          <div className="phist-head">
            <input
              className="input"
              placeholder="搜索提示词…"
              value={kw}
              autoFocus
              onChange={(e) => setKw(e.target.value)}
            />
            {items.some((i) => !i.pin) ? (
              <button className="btn sm" title="清空未收藏的历史" onClick={() => usePromptHist.getState().clear()}>
                清空
              </button>
            ) : null}
          </div>
          {list.length === 0 ? (
            <div className="phist-empty">{items.length ? "没有匹配的提示词" : "暂无历史——生成成功后自动收录"}</div>
          ) : (
            <div className="phist-list">
              {list.map((i) => (
                <div key={i.id} className={`phist-item ${i.pin ? "pin" : ""}`}>
                  <span
                    className="t"
                    title={`${i.text}\n\n点击回填`}
                    onClick={() => {
                      onPick(i.text);
                      setOpen(false);
                    }}
                  >
                    {i.text}
                  </span>
                  <button
                    className={`star ${i.pin ? "on" : ""}`}
                    title={i.pin ? "取消收藏" : "收藏置顶（不被清理）"}
                    onClick={() => usePromptHist.getState().togglePin(i.id)}
                  >
                    ★
                  </button>
                  <button className="icon-btn danger del" title="删除" onClick={() => usePromptHist.getState().remove(i.id)}>
                    <IcTrash size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
