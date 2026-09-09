/**
 * 设置面板 · ComfyUI 页
 */
import { useRef, useState } from "react";
import { Field, Row } from "../../../ui/kit";
import { useSettings } from "../../../core/stores/settingsStore";
import { useComfy, useComfyTemplates } from "../../../core/stores/comfyStore";
import { toast, useUi } from "../../../core/stores/uiStore";
import { freeComfyMemory, freeResultText } from "../../../core/services/comfy";
import { importTemplateFilesAuto, packTemplates, saveTextFile } from "../../comfy/templateIO";
import { useComfySync } from "../../../core/stores/comfySyncStore";
import { IcBroom, IcDownload, IcEdit, IcFlow, IcLoading, IcRefresh, IcTrash, IcUpload } from "../../../ui/icons";
import { SecHelp } from "../shared";
import { Switch } from "../../../ui/kit";

export function ComfyTab() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const online = useComfy((s) => s.online);
  const onlineInfo = useComfy((s) => s.onlineInfo);
  const test = useComfy((s) => s.test);
  const templates = useComfyTemplates();
  const removeTpl = useComfy((s) => s.remove);
  const setTemplateMgr = useUi((s) => s.setTemplateMgr);
  const setComfySyncOpen = useUi((s) => s.setComfySyncOpen);
  const closeSettings = useUi((s) => s.closeSettings);
  const syncSources = useComfySync((s) => s.sources);
  const syncRunning = useComfySync((s) => s.running);
  const syncUntracked = useComfySync((s) => s.workflows.filter((w) => w.status === "untracked").length);
  const [testing, setTesting] = useState(false);
  const [freeing, setFreeing] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const tplFileRef = useRef<HTMLInputElement>(null);

  const exportAllTpl = async () => {
    if (!templates.length) return toast("还没有模板可导出", "err");
    if (await saveTextFile("momo-comfy-templates.json", packTemplates(templates)))
      toast(`已导出全部 ${templates.length} 个模板 ✓`, "ok");
  };

  return (
    <div className="set-page">
      <div className="set-page-h">
        <div className="set-page-t">ComfyUI</div>
        <div className="set-page-d">连接本机或局域网内已启动的 ComfyUI 服务，通过工作流模板在画布上直接出图。</div>
      </div>

      <div className="set-card">
        <div className="set-card-h">
          工作流无感同步
          <span className="sec-h-tail">
            <SecHelp>
              配置一次 ComfyUI 工作流目录后：ComfyUI 里新建、保存、改名工作流，MOMO 自动同步更新；
              完整工作流 JSON（布局/分组/子图）原样入库，API 格式自动派生，不再需要手工导出导入。
              默认 ComfyUI 主控：MOMO 对源目录只读，绝不写回。画布节点上改的参数不受同步影响。
            </SecHelp>
          </span>
        </div>
        <Field label="启用无感同步">
          <Row>
            <Switch
              on={settings.comfy.syncV2Enabled !== false}
              onChange={(v) => {
                update("comfy", { ...settings.comfy, syncV2Enabled: v });
                void import("../../../core/comfySync/engine").then((m) => (v ? m.startEngine() : m.stopEngine()));
              }}
            />
            <span className="set-hint">关闭后回退旧的手工导入/往返编辑路径，已同步数据不受影响</span>
          </Row>
        </Field>
        <Row gap={8}>
          <span className={`set-badge ${syncRunning ? "ok" : "dim"}`}>{syncRunning ? `同步服务运行中 · ${syncSources.length} 个来源` : "同步服务未运行"}</span>
          <button className="btn sm" style={{ marginLeft: "auto" }} onClick={() => {
            closeSettings();
            setComfySyncOpen(true);
          }}>
            <IcRefresh size={14} /> 打开同步中心
          </button>
        </Row>
        <div className="set-hint" style={{ marginTop: 6 }}>
          同步中心入口也在顶部工具栏（工作流图标按钮，带状态点）。{syncUntracked ? `当前有 ${syncUntracked} 套新发现的工作流待勾选。` : ""}
        </div>
      </div>

      <div className="set-card">
        <div className="set-card-h">服务连接</div>
        <Field label="服务地址">
          <Row>
            <input className="input" value={settings.comfy.host} placeholder="http://127.0.0.1:8188"
              onChange={(e) => update("comfy", { ...settings.comfy, host: e.target.value.trim() })} />
            <button
              className="btn"
              disabled={testing}
              onClick={async () => {
                setTesting(true);
                const r = await test(settings.comfy.host);
                setTesting(false);
                toast(
                  r.ok ? "ComfyUI 已连接 ✓" : `无法连接 ComfyUI${r.err ? `：${r.err}` : "，请确认已启动"}`,
                  r.ok ? "ok" : "err",
                );
              }}
            >
              {testing ? <IcLoading size={15} /> : null} 测试连接
            </button>
          </Row>
        </Field>
        <Field label="工作流目录（往返编辑）">
          <Row>
            <input
              className="input"
              value={settings.comfy.workflowDir ?? ""}
              placeholder="ComfyUI 的用户工作流目录，如 G:\ComfyUI\ComfyUI\user\default\workflows"
              title="配置后，模板管理里可把模板一键送进 ComfyUI 画布编辑（Ctrl+S 保存），再一键同步回模板"
              onChange={(e) => update("comfy", { ...settings.comfy, workflowDir: e.target.value })}
            />
            <button
              className="btn"
              onClick={async () => {
                try {
                  const { open } = await import("@tauri-apps/plugin-dialog");
                  const picked = await open({ directory: true, title: "选择 ComfyUI 的用户工作流目录（通常在 …/ComfyUI/user/default/workflows）" });
                  if (picked && typeof picked === "string") update("comfy", { ...settings.comfy, workflowDir: picked });
                } catch {
                  toast("当前环境不支持选择目录，可直接粘贴路径", "info");
                }
              }}
            >
              选择…
            </button>
          </Row>
          <div className="set-hint" style={{ marginTop: 6 }}>
            模板「⬆」按钮默认走 ComfyUI 自身接口直接推送工作流库（无需此项）。仅当不配服务地址（离线/旧版 ComfyUI）时，才用此目录以本地文件方式兜底。
          </div>
        </Field>
        <Row gap={8}>
          <span className={`set-badge ${online === "ok" ? "ok" : online === "down" ? "warn" : "dim"}`}>
            {online === "ok" ? `已连接 ${onlineInfo}` : online === "down" ? "未连接" : "未检测"}
          </span>
          <button
            className="btn sm"
            style={{ marginLeft: "auto" }}
            disabled={freeing}
            title="立即调用 ComfyUI /free：卸载全部模型、释放显存与 ComfyUI 进程内存缓存（下次运行会重新加载模型）"
            onClick={async () => {
              setFreeing(true);
              const r = await freeComfyMemory(settings.comfy.host);
              setFreeing(false);
              toast(freeResultText(r), r.ok ? "ok" : "err");
            }}
          >
            {freeing ? <IcLoading size={13} /> : <IcBroom size={13} />} 一键释放显存与内存
          </button>
        </Row>
      </div>

      <div className="set-card">
        <div className="set-card-h">
          工作流模板（{templates.length}）
          <span className="sec-h-tail">
            <SecHelp>
              模板管理器支持选文件 / 直接拖入 / Ctrl+V 粘贴 ComfyUI「API 格式」工作流 JSON，自由勾选要暴露的输入/参数/输出节点保存为模板；
              画布的 ComfyUI 节点上即可直接编辑这些参数并运行。
            </SecHelp>
          </span>
        </div>
        {templates.length ? (
          templates.map((t) => (
            <div key={t.id} className="tpl-row">
              <span className="kind-ic" style={{ width: 34, height: 34, borderRadius: 9, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "var(--grad-brand-soft)", color: "var(--accent)" }}>
                <IcFlow size={17} />
              </span>
              <div className="tn">
                <b>{t.name}</b>
                <span>
                  {Object.keys(t.workflow).length} 个节点 · 暴露 {t.params.length} 个参数
                </span>
              </div>
              <button className="icon-btn" title="编辑模板（参数/输入输出）" onClick={() => setTemplateMgr(true, t.id)}>
                <IcEdit size={17} />
              </button>
              <button
                className="icon-btn"
                title="导出该模板（含参数配置，可再导入）"
                onClick={() =>
                  void saveTextFile(`${t.name}.momo-tpl.json`, packTemplates([t])).then(
                    (ok) => ok && toast(`模板「${t.name}」已导出 ✓`, "ok"),
                  )
                }
              >
                <IcDownload size={17} />
              </button>
              <button
                className="icon-btn danger"
                title={confirmDel === t.id ? "再点一次确认删除" : "删除模板"}
                style={confirmDel === t.id ? { color: "var(--danger)", background: "color-mix(in srgb, var(--danger) 12%, transparent)" } : undefined}
                onClick={() => {
                  if (confirmDel === t.id) {
                    removeTpl(t.id);
                    setConfirmDel(null);
                  } else setConfirmDel(t.id);
                }}
              >
                <IcTrash size={17} />
              </button>
            </div>
          ))
        ) : (
          <p className="set-hint">还没有模板——打开模板管理器导入，或直接批量导入工作流/模板包 JSON。</p>
        )}
        <Row gap={8} style={{ marginTop: 10, flexWrap: "wrap" }}>
          <button className="btn primary" onClick={() => setTemplateMgr(true)}>
            <IcFlow size={16} /> 打开工作流模板管理器
          </button>
          <button className="btn" title="选择多个 JSON（API 工作流 / 模板 / 模板包）一次性导入" onClick={() => tplFileRef.current?.click()}>
            <IcUpload size={15} /> 批量导入
          </button>
          <button className="btn" title="把全部模板导出为一个模板包 JSON，可在其他设备导入恢复" onClick={() => void exportAllTpl()}>
            <IcDownload size={15} /> 全部导出
          </button>
          <input
            ref={tplFileRef}
            type="file"
            accept=".json,application/json"
            multiple
            hidden
            onChange={(e) => {
              const files = e.target.files;
              if (files?.length)
                void importTemplateFilesAuto(files).then(({ saved, errs }) => {
                  if (saved) toast(`批量导入完成：${saved} 个模板 ✓`, "ok");
                  if (errs.length) toast(`${errs.length} 个文件失败：${errs[0]}`, "err");
                });
              e.target.value = "";
            }}
          />
        </Row>
      </div>
    </div>
  );
}
