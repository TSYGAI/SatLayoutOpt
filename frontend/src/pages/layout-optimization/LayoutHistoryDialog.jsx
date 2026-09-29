/** 文件说明：提供历史项目重命名与删除的居中模态交互；使用原生 dialog 管理焦点，数据操作委托布局状态 Hook。 */

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Pencil, Trash2, X } from 'lucide-react';
import '../../../styles/layout-history-dialog.css';

/** 根据目标操作显示表单或删除确认；失败保留输入，提交期间禁止重复操作与关闭。 */
export function LayoutHistoryDialog({ target, state, fallbackFocusRef, onClose }) {
  const dialogRef = useRef(null);
  const inputRef = useRef(null);
  const cancelRef = useRef(null);
  const submittingRef = useRef(false);
  const [draft, setDraft] = useState(target.name);
  const [failed, setFailed] = useState(false);
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const renaming = target.mode === 'rename';
  const title = renaming ? '重命名项目' : '删除项目';
  const Icon = renaming ? Pencil : Trash2;

  /** 在浏览器顶层打开弹窗并锁定背景滚动，关闭后还原焦点和滚动样式。 */
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    if (renaming) { inputRef.current.focus(); inputRef.current.select(); }
    else cancelRef.current.focus();
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      const nextFocus = previousFocus?.isConnected ? previousFocus : fallbackFocusRef.current;
      nextFocus?.focus({ preventScroll: true });
    };
  }, [renaming, fallbackFocusRef]);

  /** 关闭空闲弹窗；正在提交时保留确认界面，避免结果未定时重复操作。 */
  function close() {
    if (!state.busy && !submittingRef.current) onClose();
  }

  /** 拦截原生 Esc 关闭，由受控状态统一卸载弹窗并清理焦点。 */
  function cancel(event) {
    event.preventDefault();
    close();
  }

  /** 仅点击面板外的遮罩时关闭，点击面板内留白不会丢失输入。 */
  function backdropClick(event) {
    if (event.target !== event.currentTarget) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
  }

  /** 提交名称或删除确认；只有持久化成功才关闭，失败原因在弹窗内显示。 */
  async function submit(event) {
    event.preventDefault();
    if (state.busy || submittingRef.current || (renaming && !draft.trim())) return;
    submittingRef.current = true;
    setFailed(false);
    try {
      const saved = renaming ? await state.renameHistory(target.id, draft.trim()) : await state.deleteHistory(target.id);
      if (saved) onClose();
      else setFailed(true);
    } finally { submittingRef.current = false; }
  }

  /** 中文输入法确认候选字时不提交；Tab 在弹窗可用控件间循环，避免焦点落到浏览器界面。 */
  function handleKeyDown(event) {
    if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault();
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    const controls = dialog.querySelectorAll('button:not(:disabled), input:not(:disabled)');
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!first) { event.preventDefault(); dialog.focus(); return; }
    if (document.activeElement === dialog || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }

  return createPortal(<dialog ref={dialogRef} className={`layout-history-dialog${renaming ? '' : ' layout-history-dialog--delete'}`}
    aria-labelledby={titleId} aria-describedby={renaming ? undefined : descriptionId} aria-modal="true"
    onCancel={cancel} onClick={backdropClick} onKeyDown={handleKeyDown}>
    <form onSubmit={submit} aria-busy={state.busy}>
      <header className="layout-history-dialog-header">
        <span className="layout-history-dialog-icon"><Icon aria-hidden="true" /></span>
        <h2 id={titleId}>{title}</h2>
        <button className="layout-history-dialog-close" type="button" aria-label="关闭弹窗" disabled={state.busy} onClick={close}><X aria-hidden="true" /></button>
      </header>
      <div className="layout-history-dialog-body">
        {renaming ? <label className="layout-history-dialog-field"><span>项目名称</span>
          <input ref={inputRef} value={draft} required maxLength={state.historyNameMaxLength} disabled={state.busy}
            aria-describedby={failed ? errorId : undefined} onChange={(event) => setDraft(event.target.value)} />
        </label> : <div id={descriptionId} className="layout-history-dialog-description">
          <p>确定删除以下项目吗？</p><strong className="layout-history-dialog-project">{target.name}</strong>
          <p>该项目的参数、布局结果和预览快照将永久删除。</p>
        </div>}
        {failed && <p id={errorId} className="layout-history-dialog-error" role="alert">{state.error || '操作未完成，请重试。'}</p>}
      </div>
      <footer className="layout-history-dialog-actions">
        <button ref={cancelRef} type="button" disabled={state.busy} onClick={close}>取消</button>
        <button className="layout-history-dialog-confirm" type="submit" disabled={state.busy || (renaming && !draft.trim())}>
          {state.busy ? (renaming ? '保存中…' : '删除中…') : (renaming ? '保存名称' : '确认删除')}
        </button>
      </footer>
    </form>
  </dialog>, document.body);
}
