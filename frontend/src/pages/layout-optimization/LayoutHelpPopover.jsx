/** 文件说明：在问号按钮右侧显示紧凑的只读说明悬浮卡片；通过 React Portal 避免侧栏裁切，按内容收紧宽度并与入口居中对齐，负责关闭和键盘焦点，不占用页面布局或修改业务状态。 */

import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/** 将 children 渲染为非模态说明卡片；依赖入口引用定位，关闭通过 onClose 通知父组件。 */
export function LayoutHelpPopover({ title, triggerRef, panelId, onClose, children }) {
  const panelRef = useRef(null);

  /** 根据内容和标题行剩余空间限制卡片宽度，与入口垂直居中；入口移动后收起，避免卡片脱离按钮。 */
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const trigger = triggerRef.current;
    let anchorPosition;

    /** 在标题右侧按内容宽度定位，让按钮中心对齐两条说明之间，并限制在视口内。 */
    function position() {
      const viewport = document.documentElement;
      const gap = Number.parseFloat(getComputedStyle(panel).getPropertyValue('--parameter-help-popover-gap'));
      const anchor = trigger.getBoundingClientRect();
      const heading = trigger.parentElement.getBoundingClientRect();
      anchorPosition = { left: anchor.left, top: anchor.top };
      panel.style.width = '';
      const left = anchor.right + gap;
      const right = Math.min(heading.right, viewport.clientWidth - gap);
      const width = Math.min(panel.getBoundingClientRect().width, Math.max(0, right - left));
      panel.style.width = `${width}px`;
      panel.style.left = `${left}px`;
      const height = panel.getBoundingClientRect().height;
      const top = anchor.top + (anchor.height - height) / 2;
      panel.style.top = `${Math.max(gap, Math.min(top, viewport.clientHeight - height - gap))}px`;
    }

    /** 忽略卡片内部及已完成的滚动；只在外部滚动确实改变入口位置时关闭。 */
    function handleScroll(event) {
      if (panel.contains(event.target)) return;
      const anchor = trigger.getBoundingClientRect();
      if (anchor.left !== anchorPosition.left || anchor.top !== anchorPosition.top) onClose();
    }

    position();
    const observer = new ResizeObserver(position);
    observer.observe(trigger.parentElement);
    window.addEventListener('resize', position);
    document.addEventListener('scroll', handleScroll, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', handleScroll, true);
    };
  }, [triggerRef, onClose]);

  /** 将焦点移入只读卡片；外部点击直接关闭，Esc 关闭并恢复入口焦点，不锁定背景。 */
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });

    /** 保留卡片内的文本选择和入口切换，其余点击关闭卡片且不拦截目标操作。 */
    function handlePointerDown(event) {
      if (!panelRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) onClose();
    }

    /** 处理键盘关闭并将焦点还给问号按钮，避免关闭后丢失键盘位置。 */
    function handleKeyDown(event) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
      triggerRef.current?.focus({ preventScroll: true });
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [triggerRef, onClose]);

  return createPortal(<div ref={panelRef} id={panelId} className="layout-parameter-help-popover"
    role="dialog" aria-modal="false" aria-label={title} tabIndex={-1}>{children}</div>, document.body);
}
