/**
 * 设置面板 · MCP 工具页 —— Streamable HTTP 服务器管理
 * 连接成功的服务器其工具自动注册进能力层（mcp__<服务器>__<工具>），
 * 创作助手的 tool 动作可直接调用。
 */
import { useState } from "react";
import { Field, Row } from "../../../ui/kit";
import { useSettings } from "../../../core/stores/settingsStore";
import { testMcpServer, useMcpStatus } from "../../../core/capability/mcp";
import { IcLink, IcCheck, IcClose, IcPlus, IcTrash, IcRefresh } from "../../../ui/icons";
import type { McpServerCfg } from "../../../core/types";
import { uid, errMsg } from "../../../core/utils";
import { SecHelp } from "../shared";

export function McpTab() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const status = useMcpStatus((s) => s.byId);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authLine, setAuthLine] = useState("");
  const [busy, setBusy] = useState("");
  const [lastTest, setLastTest] = useState("");

  const servers = settings.mcp.servers;
  const patch = (next: McpServerCfg[]) => update("mcp", { servers: next });

  /** 「Authorization: Bearer xxx」单行鉴权头 → headers（写回时也渲染成单行） */
  const headerLine = (s: McpServerCfg) => {
    const e = Object.entries(s.headers ?? {})[0];
    return e ? `${e[0]}: ${e[1]}` : "";
  };
  const parseHeader = (line: string): Record<string, string> | undefined => {
    const t = line.trim();
    if (!t) return undefined;
    const i = t.indexOf(":");
    if (i <= 0) return undefined;
    return { [t.slice(0, i).trim()]: t.slice(i + 1).trim() };
  };

  const add = () => {
    const u = url.trim();
    if (!/^https?:\/\//i.test(u)) {
      setLastTest("地址必须是 http(s):// 开头的 Streamable HTTP 端点");
      return;
    }
    patch([...servers, { id: uid(6), name: name.trim() || u.replace(/^https?:\/\//, "").slice(0, 24), url: u, enabled: true, headers: parseHeader(authLine) }]);
    setName("");
    setUrl("");
    setAuthLine("");
    setLastTest("");
  };

  const test = async (s: McpServerCfg) => {
    setBusy(s.id);
    setLastTest("");
    try {
      const r = await testMcpServer(s);
      setLastTest(r.ok ? `「${s.name}」连接成功，发现 ${r.toolCount} 个工具（已注册进创作助手）` : `「${s.name}」连接失败：${r.error}`);
    } catch (e) {
      setLastTest(`「${s.name}」连接失败：${errMsg(e)}`);
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="set-page">
      <div className="set-page-h">
        <div className="set-page-t">MCP 工具</div>
        <div className="set-page-d">添加 MCP 服务器（Streamable HTTP），其工具自动出现在创作助手的 tool 能力目录里。</div>
      </div>
      <div className="set-card">
        <div className="set-card-h">
          服务器
          <span className="sec-h-tail">
            <SecHelp>
              只支持 Streamable HTTP 端点（形如 https://…/mcp 的 URL）；本地 stdio 服务器暂不支持。
              连接成功后工具按「服务器·工具名」注册（mcp__前缀），只读性质——它们作用于你配置的外部服务，
              不能写 MOMO 数据、不能触发扣费。鉴权头支持一行「Header: 值」（如 Authorization: Bearer xxx）。
            </SecHelp>
          </span>
        </div>
        {servers.length ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {servers.map((s) => {
              const st = status[s.id];
              return (
                <div key={s.id} className="set-row" style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "stretch" }}>
                  <Row gap={8} style={{ alignItems: "center" }}>
                    <input
                      className="input sm"
                      style={{ width: 150 }}
                      value={s.name}
                      onChange={(e) => patch(servers.map((x) => (x.id === s.id ? { ...x, name: e.target.value } : x)))}
                    />
                    <input
                      className="input sm"
                      style={{ flex: 1, minWidth: 200 }}
                      value={s.url}
                      onChange={(e) => patch(servers.map((x) => (x.id === s.id ? { ...x, url: e.target.value.trim() } : x)))}
                    />
                    <span className={`set-badge ${st?.state === "connected" ? "ok" : st?.state === "error" ? "warn" : "dim"}`}>
                      {st?.state === "connected" ? `${st.toolCount} 工具` : st?.state === "connecting" ? "连接中" : st?.state === "error" ? "离线" : "未连接"}
                    </span>
                    <button className="btn sm" disabled={busy === s.id} title="握手并拉取工具清单" onClick={() => void test(s)}>
                      <IcRefresh size={13} /> 测试
                    </button>
                    <button
                      className="btn sm"
                      title={s.enabled ? "停用（工具从能力目录移除）" : "启用"}
                      onClick={() => patch(servers.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x)))}
                    >
                      {s.enabled ? <IcCheck size={13} /> : <IcClose size={13} />}
                    </button>
                    <button className="btn sm" title="删除" onClick={() => patch(servers.filter((x) => x.id !== s.id))}>
                      <IcTrash size={13} />
                    </button>
                  </Row>
                  <Row gap={8} style={{ alignItems: "center" }}>
                    <input
                      className="input sm"
                      style={{ flex: 1, minWidth: 200 }}
                      placeholder="鉴权头（可选），如 Authorization: Bearer xxx"
                      value={headerLine(s)}
                      onChange={(e) => patch(servers.map((x) => (x.id === s.id ? { ...x, headers: parseHeader(e.target.value) } : x)))}
                    />
                    {st?.state === "error" ? <span className="set-hint warn" style={{ flex: 1 }}>{(st.error ?? "").slice(0, 120)}</span> : null}
                  </Row>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="set-hint">还没有 MCP 服务器。在下方添加第一个（例如搜索类、知识库类 MCP），连接成功后创作助手立刻可用其工具。</div>
        )}
        <Field label="添加服务器" hint="保存即自动连接；改地址/鉴权后点「测试」立即重连（设置变更也会自动重连）">
          <Row gap={8} style={{ alignItems: "center" }}>
            <input className="input sm" style={{ width: 150 }} placeholder="名称（可省）" value={name} onChange={(e) => setName(e.target.value)} />
            <input className="input sm" style={{ flex: 1, minWidth: 220 }} placeholder="https://example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />
            <input className="input sm" style={{ width: 220 }} placeholder="鉴权头（可选）" value={authLine} onChange={(e) => setAuthLine(e.target.value)} />
            <button className="btn sm primary" onClick={add}>
              <IcPlus size={13} /> 添加
            </button>
          </Row>
        </Field>
        {lastTest ? (
          <div className={`set-hint ${lastTest.includes("失败") || lastTest.includes("必须") ? "warn" : "ok"}`}>
            <IcLink size={12} /> {lastTest}
          </div>
        ) : null}
      </div>
    </div>
  );
}
