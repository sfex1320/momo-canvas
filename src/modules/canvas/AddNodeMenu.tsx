/**
 * 快速添加菜单 — 双击空白 / 从端口拖线到空白处触发
 */
import { useBoard } from "../../core/stores/boardStore";
import { useUi } from "../../core/stores/uiStore";
import { NODE_CATALOG } from "./nodeCatalog";

export function AddNodeMenu() {
  const menu = useUi((s) => s.addMenu);
  const setAddMenu = useUi((s) => s.setAddMenu);
  const addNode = useBoard((s) => s.addNode);
  const connectNodes = useBoard((s) => s.connectNodes);

  if (!menu) return null;

  const items = NODE_CATALOG.filter((i) => !menu.sourcePort || i.hasInput);
  const left = Math.min(menu.screenX, window.innerWidth - 260);
  const top = Math.min(menu.screenY, window.innerHeight - (items.length * 54 + 60));

  const pick = (kind: (typeof items)[number]["kind"]) => {
    const id = addNode(kind, { x: menu.flowX, y: menu.flowY });
    if (menu.sourceNode && menu.sourcePort) {
      connectNodes(menu.sourceNode, id, menu.sourcePort === "image" ? "in-image" : "in-text");
    }
    setAddMenu(null);
  };

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 290 }} onMouseDown={() => setAddMenu(null)} />
      <div className="add-menu glass" style={{ left, top }}>
        <div className="am-title">{menu.sourcePort ? "连接到新节点" : "添加节点"}</div>
        {items.map((i) => (
          <button key={i.kind} className="am-item" onClick={() => pick(i.kind)}>
            <span className="di-ic">{i.icon}</span>
            <span>
              <b>{i.label}</b>
              <span>{i.desc}</span>
            </span>
          </button>
        ))}
      </div>
    </>
  );
}
