/** 文件说明：人工微调离页保护；未保存操作可保留本地草稿后离开，关闭浏览器显示原生提示，不静默丢弃。 */
import { useEffect, useRef } from 'react';
import { useBlocker } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { Save } from '../../components/icons.js';

/** 在路由、刷新和关闭时保护草稿；已保存后 dirty 清除，正常返回不再阻断。 */
export function RefinementLeaveDialog({ dirty, saving, storageError }) {
  const dialog = useRef(null);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => (dirty || saving)
    && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search));
  useEffect(() => { if (blocker.state === 'blocked') dialog.current?.showModal(); else dialog.current?.close(); }, [blocker.state]);
  useEffect(() => {
    if (!dirty && !saving) return undefined;
    /** 浏览器关闭无法可靠等待保存，用原生提示让用户决定并依靠已同步的本地草稿恢复。 */
    function beforeUnload(event) { event.preventDefault(); event.returnValue = ''; }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty, saving]);
  return createPortal(<dialog className="refinement-leave-dialog" ref={dialog} aria-labelledby="refinement-leave-title"
    onCancel={(event) => { event.preventDefault(); if (!saving) blocker.reset(); }}>
    <h2 id="refinement-leave-title"><Save aria-hidden="true" />微调尚未另存</h2><p>{saving ? '正在正式校核并保存，请稍候。' : storageError || '当前操作已保留为本地草稿，再次打开这个来源方案可继续编辑。'}</p>
    <div><button type="button" className="primary" disabled={saving} onClick={() => blocker.reset()}>继续编辑</button>
      <button type="button" disabled={saving || Boolean(storageError)} onClick={() => blocker.proceed()}>保留草稿并离开</button></div>
  </dialog>, document.body);
}
