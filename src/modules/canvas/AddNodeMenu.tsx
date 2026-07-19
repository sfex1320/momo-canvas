/**
 * 快速添加菜单 — 双击空白 / 从端口拖线到空白处触发；底部可直接插入画布模板
 */
import { NODE_INPUTS, useBoard } from "../../core/stores/boardStore";
import { useTemplates } from "../../core/stores/templateStore";
import { useUi } from "../../core/stores/uiStore";
import { NODE_CATALOG } from "./nodeCatalog";
import { IcLayers } from "../../ui/icons";

export function AddNodeMenu() {
  const menu = useUi((s) => s.addMenu);
  const setAddMenu = useUi((s) => s.setAddMenu);
  const addNode = useBoard((s) => s.addNode);
  const connectNodes = useBoard((s) => s.connectNodes);
  const templates = useTemplates((s) => s.templates);
  const allTemplates = useTemplates((s) => s.all);
  void templates; // 订阅模板增删以刷新菜单

  if (!menu) return null;

  const items = NODE_CATALOG.filter((i) => {
    if (!menu.sourcePort) return true;
    const ins = NODE_INPUTS[i.kind];
    return menu.sourcePort === "image" ? !!ins.image : menu.sourcePort === "video" ? !!ins.video : !!ins.text;
  });
  const left = Math.min(menu.screenX, window.innerWidth - 265);
  const top = Math.max(50, Math.min(menu.screenY, window.innerHeight - (items.length * 50 + 80)));

  const pick = (kind: (typeof items)[number]["kind"]) => {
    const id = addNode(kind, { x: menu.flowX, y: menu.flowY });
    if (menu.sourceNode && menu.sourcePort) {
      connectNodes(menu.sourceNode, id, menu.sourcePort === "image" ? "in-image" : menu.sourcePort === "video" ? "in-video" : "in-text");
    }
    setAddMenu(null);
  };

  let lastGroup = "";
  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 290 }} onMouseDown={() => setAddMenu(null)} />
      <div className="add-menu glass nowheel" style={{ left, top }}>
        <div className="am-title">{menu.sourcePort ? "连接到新节点" : "添加节点"}</div>
        {items.map((i) => {
          const showGroup = i.group !== lastGroup;
          lastGroup = i.group;
          return (
            <div key={i.kind}>
              {showGroup && !menu.sourcePort ? <div className="am-group">{i.group}</div> : null}
              <button className="am-item" onClick={() => pick(i.kind)}>
                <span className="di-ic">{i.icon}</span>
                <span>
                  <b>{i.label}</b>
                  <span>{i.desc}</span>
                </span>
              </button>
            </div>
          );
        })}
        {!menu.sourcePort && allTemplates().length ? (
          <>
            <div className="am-group">画布模板</div>
            {allTemplates().map((tpl) => (
              <button
                key={tpl.id}
                className="am-item"
                onClick={() => {
                  useTemplates.getState().instantiate(tpl, { x: menu.flowX, y: menu.flowY });
                  setAddMenu(null);
                }}
              >
                <span className="di-ic">
                  <IcLayers size={18} />
                </span>
                <span>
                  <b>{tpl.name}</b>
                  <span>{tpl.nodes.filter((x) => x.kind !== "group").length} 个节点 · 连好线，插入即用</span>
                </span>
              </button>
            ))}
          </>
        ) : null}
      </div>
    </>
  );
}
