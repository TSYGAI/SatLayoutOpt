/** 文件说明：硬件设置的离页保护；未保存编辑阻止路由切换，刷新和关闭交由浏览器原生提示。 */
import { useEffect, useRef } from 'react';
import { useBlocker } from 'react-router-dom';
import { createPortal } from 'react-dom';

/** 提供继续编辑和明确丢弃两种操作，保存过程中禁止离开，避免不确定的写入状态。 */
export function HardwareLeaveDialog({ state }) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => state.dirty && currentLocation.pathname !== nextLocation.pathname);
  const dialog = useRef(null);
  const busy = state.status === 'saving';
  useEffect(() => {
    if (blocker.state === 'blocked') dialog.current?.showModal(); else dialog.current?.close();
  }, [blocker.state]);
  useEffect(() => {
    if (!state.dirty) return undefined;
    /** 关闭或刷新不能可靠等待异步写入，提示用户先完成保存。 */
    function beforeUnload(event) { event.preventDefault(); event.returnValue = ''; }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [state.dirty]);
  /** 丢弃当前草稿后继续已请求的页面导航。 */
  function discardAndLeave() { state.discard(); blocker.proceed(); }
  return createPortal(<dialog ref={dialog} className="hardware-leave-dialog" aria-labelledby="hardware-leave-title"
    onCancel={(event) => { event.preventDefault(); if (!busy) blocker.reset(); }}>
    <h2 id="hardware-leave-title">硬件设置尚未保存</h2>
    <p>{busy ? '正在写入配置，请稍候。' : '离开会丢弃本次未保存的修改。已保存到配置文件的内容不会改变。'}</p>
    <div><button type="button" disabled={busy} onClick={() => blocker.reset()}>继续编辑</button>
      <button type="button" disabled={busy} onClick={discardAndLeave}>丢弃修改并离开</button></div>
  </dialog>, document.body);
}
