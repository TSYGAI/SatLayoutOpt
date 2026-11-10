/**
 * 文件说明：数据管理页固化记录删除确认弹窗，负责居中展示删除范围、焦点和提交状态。
 * 删除请求由页面传入并执行，本组件不访问接口；失败时保留弹窗以便用户重试。
 */

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, X } from '../../components/icons.js';

/** 展示单条或批量固化记录删除确认，并在请求完成后关闭或保留错误状态。 */
export function StoredRecordDeleteDialog({ request, onClose, onConfirm }) {
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  const submittingRef = useRef(false);
  const mountedRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const titleId = useId();
  const descriptionId = useId();
  const isBulk = request.mode === 'bulk';
  const count = isBulk ? request.identifiers.length : 1;

  /** 打开居中弹窗并锁定背景滚动；卸载时恢复原滚动状态和焦点。 */
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    mountedRef.current = true;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    cancelRef.current.focus();
    return () => {
      mountedRef.current = false;
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  /** 关闭空闲弹窗；删除请求进行中时保留确认界面，避免重复提交。 */
  function close() {
    if (!submittingRef.current) onClose();
  }

  /** 接管 Esc 取消事件；提交期间不允许原生弹窗自动关闭。 */
  function cancel(event) {
    event.preventDefault();
    close();
  }

  /** 点击遮罩关闭弹窗，点击内容区域不触发取消。 */
  function backdropClick(event) {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
  }

  /** 提交删除请求；成功后关闭，失败原因留在当前居中弹窗内并允许重试。 */
  async function submit(event) {
    event.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await onConfirm();
      if (!mountedRef.current) return;
      if (result?.ok) onClose();
      else setError(result?.error || '删除未完成，请重试。');
    } catch (failure) {
      if (mountedRef.current) setError(failure.message || '删除未完成，请重试。');
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }

  return createPortal(<dialog ref={dialogRef} className="data-management-delete-dialog"
    aria-labelledby={titleId} aria-describedby={descriptionId} aria-modal="true"
    onCancel={cancel} onClick={backdropClick}>
    <form onSubmit={submit} aria-busy={busy}>
      <header className="data-management-delete-dialog-header">
        <span className="data-management-delete-dialog-icon"><Trash2 aria-hidden="true" /></span>
        <h2 id={titleId}>删除固化记录</h2>
        <button type="button" className="data-management-delete-dialog-close" aria-label="关闭弹窗" disabled={busy} onClick={close}>
          <X aria-hidden="true" />
        </button>
      </header>
      <div id={descriptionId} className="data-management-delete-dialog-body">
        <p>{isBulk ? `确定永久删除${request.scope}固化记录及其资源吗？` : '确定永久删除该固化记录及其资源吗？'}</p>
        {!isBulk && <strong className="data-management-delete-dialog-record">{request.deviceName}</strong>}
        {isBulk && <strong className="data-management-delete-dialog-record">共 {count} 条记录</strong>}
        <p>原始模型与包络产物不受影响。</p>
      </div>
      {error && <p className="data-management-delete-dialog-error" role="alert">{error}</p>}
      {busy && <p className="data-management-delete-dialog-progress" role="status">正在删除固化记录…</p>}
      <footer className="data-management-delete-dialog-actions">
        <button ref={cancelRef} type="button" disabled={busy} onClick={close}>取消</button>
        <button className="data-management-delete-dialog-confirm" type="submit" disabled={busy}>
          {busy ? '删除中…' : '确认删除'}
        </button>
      </footer>
    </form>
  </dialog>, document.body);
}
