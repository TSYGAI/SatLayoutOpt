/**
 * 文件说明：由体素设置标题旁的小图标打开内存建议浮窗，只读取统一 TOML 的推荐档位。
 * 浮窗通过 Portal 挂在页面根部并固定定位，避免撑大侧栏或被侧栏滚动容器裁切。
 * 管理点击、外部点击及 Esc 关闭，不修改模型参数，不触发包络计算，也不限制机器资源。
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleHelp, X } from '../../components/icons.js';
import { getEnvelopeMemoryRecommendations } from '../../api/model-upload-api.js';

/** 呈现标题旁的帮助图标及两列悬浮推荐表；外部滚动时收起，展开不改变侧栏布局。 */
export function EnvelopeResolutionHelp() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const panelRef = useRef(null);
  const triggerRef = useRef(null);
  const closeRef = useRef(null);
  const panelId = useId();
  const titleId = useId();

  /** 首次展开时读取建议；关闭或卸载后忽略尚未完成的读取。 */
  useEffect(() => {
    if (!open || rows) return undefined;
    let active = true;
    setError('');
    getEnvelopeMemoryRecommendations().then((values) => {
      if (active) setRows(values);
    }).catch((reason) => {
      if (active) setError(reason.message);
    });
    return () => { active = false; };
  }, [open, rows]);

  /** 按设置区域的右侧空白定位浮窗并限制在视口内；尺寸变化重新定位，外部滚动时收起。 */
  useLayoutEffect(() => {
    if (!open) return undefined;
    const panel = panelRef.current;
    const trigger = triggerRef.current;
    const section = trigger.closest('.model-envelope-settings-section');
    /** 使用当前控件的实际尺寸定位，保持浮窗宽度接近输入框且不超出视口。 */
    function updatePosition() {
      const anchor = trigger.getBoundingClientRect();
      const sectionBox = section.getBoundingClientRect();
      const inputBox = section.querySelector('input').getBoundingClientRect();
      const margin = 8;
      const viewport = document.documentElement;
      const width = Math.min(inputBox.width, viewport.clientWidth - margin * 2);
      panel.style.width = `${width}px`;
      const height = panel.getBoundingClientRect().height;
      const preferredTop = anchor.bottom + margin;
      const top = preferredTop + height <= viewport.clientHeight - margin
        ? preferredTop : anchor.top - height - margin;
      panel.style.left = `${Math.max(margin, Math.min(sectionBox.right - width, viewport.clientWidth - width - margin))}px`;
      panel.style.top = `${Math.max(margin, Math.min(top, viewport.clientHeight - height - margin))}px`;
    }
    /** 侧栏或页面滚动后关闭旧锚点浮窗，浮窗内部滚动不影响阅读。 */
    function handleScroll(event) {
      if (!panel.contains(event.target)) setOpen(false);
    }
    updatePosition();
    window.addEventListener('resize', updatePosition);
    document.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      document.removeEventListener('scroll', handleScroll, true);
    };
  }, [open, rows, error]);

  /** 打开后将焦点放到浮窗，关闭时允许 Esc 返回入口，外部点击保留用户的新焦点。 */
  useEffect(() => {
    if (!open) return undefined;
    closeRef.current?.focus({ preventScroll: true });
    /** 点击图标及独立浮窗以外的内容时收起，不拦截后续点击。 */
    function handlePointerDown(event) {
      if (!triggerRef.current?.contains(event.target) && !panelRef.current?.contains(event.target)) setOpen(false);
    }
    /** 用 Esc 收起浮窗并把键盘焦点还给提示图标。 */
    function handleKeyDown(event) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    }
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  /** 通过关闭按钮收起建议，并恢复入口焦点。 */
  function close() {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }

  return <>
    <button ref={triggerRef} type="button" className="envelope-resolution-help-trigger" aria-label="查看体素分辨率推荐配置"
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} title="推荐配置"
      onClick={() => setOpen((value) => !value)}>
      <CircleHelp aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={panelRef} id={panelId} className="envelope-resolution-help-panel" role="dialog" aria-modal="false" aria-labelledby={titleId}>
      <header>
        <h3 id={titleId}>推荐配置</h3>
        <button ref={closeRef} type="button" className="envelope-resolution-help-close" aria-label="关闭推荐配置" onClick={close}>
          <X aria-hidden="true" />
        </button>
      </header>
      {rows ? <table aria-label="体素分辨率与内存建议">
        <thead><tr><th scope="col">体素分辨率</th><th scope="col">内存最低建议</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.resolution}>
          <td>{row.resolution}{row.isDefault && <span>（默认）</span>}</td><td>{row.memoryGb} GB</td>
        </tr>)}</tbody>
      </table> : <p role={error ? 'alert' : 'status'}>{error || '正在加载推荐配置…'}</p>}
    </div>, document.body)}
  </>;
}
