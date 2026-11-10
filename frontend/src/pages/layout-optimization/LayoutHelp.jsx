/** 文件说明：复用布局页标题旁的问号入口，支持锚定悬浮卡片或模态说明弹窗；依赖 React 与独立卡片组件管理显示和焦点，不读写业务数据。 */

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleHelp, X } from '../../components/icons.js';
import { LayoutHelpPopover } from './LayoutHelpPopover.jsx';
import '../../../styles/layout-parameter-help.css';

/** 在浏览器顶层展示只读内容；关闭或卸载时恢复背景滚动和入口焦点。 */
function HelpDialog({ title, bodyLabel, compact, children, triggerRef, panelId, onClose }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const titleId = useId();

  /** 原生模态限制背景交互与键盘焦点；清理时保留打开前的滚动样式。 */
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (triggerRef.current?.isConnected) triggerRef.current.focus({ preventScroll: true });
    };
  }, [triggerRef]);

  /** 将原生 Esc 取消交给父组件，保持 React 状态与弹窗一致。 */
  function cancel(event) {
    event.preventDefault();
    onClose();
  }

  /** 只在点击弹窗外的遮罩时关闭，正文选择及内部滚动不会误触。 */
  function backdropClick(event) {
    if (event.target !== event.currentTarget) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();
  }

  return createPortal(<dialog ref={dialogRef} id={panelId}
    className={`layout-parameter-help-dialog${compact ? ' layout-parameter-help-dialog--compact' : ''}`}
    aria-labelledby={titleId} aria-modal="true" onCancel={cancel} onClick={backdropClick}>
    <div className="layout-parameter-help-shell">
      <header className="layout-parameter-help-header">
        <span className="layout-parameter-help-icon"><CircleHelp aria-hidden="true" /></span>
        <div><h2 id={titleId}>{title}</h2></div>
        <button ref={closeRef} type="button" className="layout-parameter-help-close" aria-label={`关闭${title}`} title="关闭" onClick={onClose}><X aria-hidden="true" /></button>
      </header>
      <div className="layout-parameter-help-body" tabIndex={0} aria-label={bodyLabel ?? `${title}内容`}>{children}</div>
      <footer className="layout-parameter-help-footer"><button type="button" onClick={onClose}>我知道了</button></footer>
    </div>
  </dialog>, document.body);
}

/** 提供统一的问号入口；popover 在按钮右侧显示悬浮卡片，compact 调整模态弹窗尺寸，标题用于可访问名称，所有状态仅控制显示。 */
export function LayoutHelp({ title, bodyLabel, compact = false, popover = false, children }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const panelId = useId();

  /** 打开只读说明，不触发表单更新或计算。 */
  function openHelp() { setOpen(true); }

  /** 关闭只读说明；相应展示组件负责焦点和滚动处理。 */
  function closeHelp() { setOpen(false); }

  return <>
    <button ref={triggerRef} type="button" className="layout-parameter-help-trigger" aria-label={`查看${title}`} title={title}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined}
      onClick={popover && open ? closeHelp : openHelp}><CircleHelp aria-hidden="true" /></button>
    {open && (popover
      ? <LayoutHelpPopover title={title} triggerRef={triggerRef} panelId={panelId} onClose={closeHelp}>{children}</LayoutHelpPopover>
      : <HelpDialog title={title} bodyLabel={bodyLabel} compact={compact} triggerRef={triggerRef} panelId={panelId} onClose={closeHelp}>{children}</HelpDialog>)}
  </>;
}
