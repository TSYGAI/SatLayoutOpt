/** 文件说明：固定草稿离页保护；明确区分全部保存、丢弃未发布编辑与继续编辑，浏览器关闭使用原生提示。 */
import { useEffect, useRef, useState } from 'react';
import { useBlocker } from 'react-router-dom';
import { createPortal } from 'react-dom';

/** 在存在未发布草稿时展示选择；关闭/刷新使用浏览器原生提示，草稿已同步持久化。 */
export function FixedLeaveDialog({ state, active, navigationRef }) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => state.dirty
    && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search));
  const [sectionPending, setSectionPending] = useState(false);
  const resolveSection = useRef(null);
  const dialog = useRef(null);
  const open = blocker.state === 'blocked' || sectionPending;
  const busy = state.status === 'saving';
  const canSave = state.status === 'ready' && state.snapshot?.validation.valid;
  /** 页内分组切换与路由导航共享弹窗，但不通过模拟链接改变浏览器历史。 */
  useEffect(() => {
    if (!navigationRef) return undefined;
    navigationRef.current = () => {
      if (!active || !state.dirty) return Promise.resolve(true);
      return new Promise((resolve) => { resolveSection.current = resolve; setSectionPending(true); });
    };
    return () => { navigationRef.current = null; };
  }, [active, state.dirty, navigationRef]);
  /** 原生模态窗口限制焦点；关闭组件时也关闭模态层。 */
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  /** 浏览器关闭不能可靠等待异步保存，使用原生离页确认并依靠已落盘草稿恢复。 */
  useEffect(() => {
    if (!state.dirty) return undefined;
    /** 请求浏览器显示原生未保存确认；异步发布必须在应用内先完成。 */
    function beforeUnload(event) { event.preventDefault(); event.returnValue = ''; }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [state.dirty]);
  /** 完成或取消待决导航；保存或丢弃由各自按钮处理。 */
  function finish(leave) {
    if (blocker.state === 'blocked') { if (leave) blocker.proceed(); else blocker.reset(); }
    resolveSection.current?.(leave); resolveSection.current = null; setSectionPending(false);
  }
  /** 正式保存通过才继续导航；校验或网络失败保持弹窗和草稿。 */
  async function saveAndLeave() { if (await state.saveAll()) finish(true); }
  /** 不保存直接离开；清除临时草稿和旧请求，不向服务端提交更改。 */
  function discardAndLeave() { state.discard(); finish(true); }
  return createPortal(<dialog ref={dialog} className="fixed-leave-dialog" aria-labelledby="fixed-leave-title"
    onCancel={(event) => { event.preventDefault(); if (!busy) finish(false); }}>
    <h2 id="fixed-leave-title">固定约束尚未保存</h2>
    <p>还有固定组尚未保存。可返回逐组保存，或保存全部更改后离开；“不保存”仅丢弃未保存的更改。</p>
    {state.storageError && <p role="alert">{state.storageError}</p>}
    {state.error && <p role="alert">{state.error}</p>}
    {!canSave && !busy && !state.error && <p>当前更改尚未通过校验，请继续编辑，或选择“不保存”直接离开。</p>}
    <footer>
      <button className="pre-config-action-button" disabled={busy} onClick={() => finish(false)}>继续编辑</button>
      <button className="pre-config-action-button" disabled={busy} onClick={discardAndLeave}>不保存</button>
      <button className="pre-config-action-button primary" disabled={busy || !canSave} onClick={saveAndLeave}>{busy ? '保存中…' : '全部保存并离开'}</button>
    </footer>
  </dialog>, document.body);
}
