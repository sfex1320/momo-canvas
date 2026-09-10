/** 节点空白、标题和说明均可拖动；真实控件与编辑画面保留各自手势。 */
export const NODE_CONTROL_SELECTOR = 'button,input,textarea,select,option,a,label,summary,[contenteditable]:not([contenteditable="false"]),[draggable="true"],[role="button"],[role="slider"],[role="textbox"],[role="checkbox"],[role="combobox"],[role="option"],[role="menuitem"],[data-node-interactive],.react-flow__handle,.react-flow__resize-control,.mnode.editing,canvas,video[controls],audio[controls]';
export function prepareNodeDrag(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const control = Boolean(target.closest(NODE_CONTROL_SELECTOR));
  // 捕获阶段先标记，供 React Flow 读取；不把整块 nodrag 内容容器当成控件。
  target.closest('.react-flow__node')?.classList.toggle('momo-node-control', control);
  return control;
}
