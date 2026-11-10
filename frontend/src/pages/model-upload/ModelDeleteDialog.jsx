/**
 * 文件说明：上传模型删除的页面内确认弹窗，负责模型名称展示、焦点、等待和失败重试。
 * 删除业务通过控制器传入的 onConfirm 执行，本组件不访问 API 或管理模型缓存。
 */

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, X } from '../../components/icons.js';
import '../../../styles/model-delete-dialog.css';

/** 显示待删除模型并在确认后执行操作；失败保留弹窗，提交期间禁止重复确认与关闭。 */
export function ModelDeleteDialog({ target, onClose }) {
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  const submittingRef = useRef(false);
  const mountedRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const titleId = useId();
  const descriptionId = useId();

  /** 在页面顶层打开居中弹窗并聚焦取消按钮，卸载时恢复背景滚动与原按钮焦点。 */
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

  /** 关闭空闲弹窗；请求尚未完成时保留确认界面，避免重复删除。 */
  function close() {
    if (!submittingRef.current) onClose();
  }

  /** 将 Esc 关闭交给受控状态，提交过程中阻止浏览器自动关闭页面弹窗。 */
  function cancel(event) {
    event.preventDefault();
    close();
  }

  /** 点击面板外遮罩时取消，面板内的空白区域不会误触关闭。 */
  function backdropClick(event) {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
  }

  /** 执行控制器删除操作；只在成功后关闭，失败原因持久显示并允许再次确认重试。 */
  async function submit(event) {
    event.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await target.onConfirm();
      if (!mountedRef.current) return;
      if (result?.ok) onClose();
      else setError(result?.error || '删除未完成，请重试。');
    } catch (failure) {
      if (mountedRef.current) setError(failure.message);
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }

  return createPortal(<dialog ref={dialogRef} className="model-delete-dialog"
    aria-labelledby={titleId} aria-describedby={descriptionId} aria-modal="true"
    onCancel={cancel} onClick={backdropClick}>
    <form onSubmit={submit} aria-busy={busy}>
      <header className="model-delete-dialog-header">
        <span className="model-delete-dialog-icon"><Trash2 aria-hidden="true" /></span>
        <h2 id={titleId}>删除模型</h2>
        <button type="button" className="model-delete-dialog-close" aria-label="关闭弹窗" disabled={busy} onClick={close}><X aria-hidden="true" /></button>
      </header>
      <div id={descriptionId} className="model-delete-dialog-body">
        <p>确定删除以下 {target.models.length} 个模型吗？</p>
        <ul className="model-delete-dialog-models">
          {target.models.map((model) => <li key={model.id}>{model.filename}</li>)}
        </ul>
        <p>原始文件、预览和包络将永久删除。已存储到数据库的记录会保留。</p>
      </div>
      {error && <p className="model-delete-dialog-error" role="alert">{error}</p>}
      {busy && <p className="model-delete-dialog-progress" role="status">正在停止模型转换并删除文件…</p>}
      <footer className="model-delete-dialog-actions">
        <button ref={cancelRef} type="button" disabled={busy} onClick={close}>取消</button>
        <button className="model-delete-dialog-confirm" type="submit" disabled={busy}>{busy ? '删除中…' : '确认删除'}</button>
      </footer>
    </form>
  </dialog>, document.body);
}
