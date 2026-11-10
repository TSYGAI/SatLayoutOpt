/** 文件说明：提供稳定的大画布及可退出的放大预览；保留现有视口实例和编辑状态，并管理放大时的键盘焦点。 */
import { useEffect, useRef, useState } from 'react';

/** 放大同一预览区域，不重新挂载视口；Escape 和按钮均恢复原布局及焦点。 */
export function RefinementPreview({ renderToolbar, children }) {
  const container = useRef(null), [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded) return undefined;
    const previousFocus = document.activeElement, previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    container.current.querySelector('[data-preview-expand]')?.focus();
    /** 在放大区域内循环焦点，Escape 返回编辑工作台，避免键盘操作落到被遮挡的参数区。 */
    function keyboard(event) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setExpanded(false); }
      if (event.key !== 'Tab') return;
      const targets = [...container.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary')]
        .filter((node) => node.getClientRects().length);
      const first = targets[0], last = targets.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    container.current.addEventListener('keydown', keyboard);
    const element = container.current;
    return () => {
      element.removeEventListener('keydown', keyboard); document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [expanded]);
  return <section ref={container} className={`refinement-center${expanded ? ' refinement-preview-expanded' : ''}`}
    role={expanded ? 'dialog' : 'region'} aria-modal={expanded || undefined} aria-label="微调多视图">
    {renderToolbar(expanded, () => setExpanded((current) => !current))}{children}
  </section>;
}
