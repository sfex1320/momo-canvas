import { DEFAULT_HOTKEYS, type HotkeyAction } from "./types";

const retired = new Set<HotkeyAction>(["charLib", "addChat", "addLlmText"]);
const isDirectorAction = (action: HotkeyAction) => action.startsWith("dir") && action !== "director";
const canonical = (combo: string) => combo.toLowerCase().replace(/(^|\+) $/, "$1space");

/** 监看器和画布的按键互不抢占，导演台开关则在两个作用域都生效。 */
export function hotkeysConflict(a: HotkeyAction, keyA: string, b: HotkeyAction, keyB: string): boolean {
  if (a === b || retired.has(a) || retired.has(b) || !keyA || !keyB || canonical(keyA) !== canonical(keyB)) return false;
  return a === "director" || b === "director" || isDirectorAction(a) === isDirectorAction(b);
}

/** 加载和导入同路：保留手改与空串解绑，新增默认值只填未占用的组合键。 */
export function normalizeHotkeys(raw: unknown): Record<HotkeyAction, string> {
  const saved = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const result = {} as Record<HotkeyAction, string>;
  const actions = Object.keys(DEFAULT_HOTKEYS) as HotkeyAction[];
  for (const action of actions) {
    if (retired.has(action)) result[action] = "";
    else if (typeof saved[action] === "string") result[action] = saved[action];
  }
  for (const action of actions) {
    if (Object.prototype.hasOwnProperty.call(result, action)) continue;
    const key = DEFAULT_HOTKEYS[action];
    result[action] = (Object.entries(result) as [HotkeyAction, string][]).some(([other, value]) => hotkeysConflict(action, key, other, value)) ? "" : key;
  }
  return result;
}

/** 录键、输入法与浮层优先；长按不能重复启动、开关窗口或追加附件。 */
export function shouldIgnoreCanvasHotkey(
  event: Pick<KeyboardEvent, "defaultPrevented" | "isComposing" | "repeat">,
  active: Pick<HTMLElement, "tagName" | "isContentEditable"> | null,
  overlayOpen: boolean,
): boolean {
  return event.defaultPrevented || event.isComposing || event.repeat || overlayOpen || !!active &&
    (["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName) || active.isContentEditable);
}
