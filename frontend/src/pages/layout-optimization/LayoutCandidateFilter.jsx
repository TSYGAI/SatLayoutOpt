/** 文件说明：为原始方案和微调版本提供排序、高度上限与半径下限筛选浮窗；应用草稿后更新展示，Portal 定位避免侧栏裁切。 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, Funnel, X } from '../../components/icons.js';
import { candidateFilterError, candidateFilterSummary, createCandidateFilter, selectCandidateRows } from './layout-candidate-view.js';
import { ParameterNumberInput } from '../../components/ParameterNumberInput.jsx';

/** 显示默认顺序及两种尺寸的方向切换按钮与范围输入；refinements 切换版本文案和重置顺序，通过 onApply 提交草稿，不修改候选或预览选择。 */
export function LayoutCandidateFilter({ candidates, value, onApply, refinements = false }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState('');
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const closeRef = useRef(null);
  const heightRef = useRef(null);
  const radiusRef = useRef(null);
  const panelId = useId();
  const titleId = useId();
  const heightId = useId();
  const radiusId = useId();
  const active = Boolean(candidateFilterSummary(value));
  const defaultSort = refinements ? 'saved' : 'score';
  const subject = refinements ? '微调版本' : '方案';

  /** 按入口定位并限制在视口内；外部滚动时收起，内部滚动保留编辑状态。 */
  useLayoutEffect(() => {
    if (!open) return undefined;
    const panel = panelRef.current;
    const trigger = triggerRef.current;
    let anchorPosition;
    /** 根据浮窗、工具栏与视口的实际尺寸决定上方或下方位置。 */
    function position() {
      const margin = 8;
      const viewport = document.documentElement;
      const anchor = trigger.getBoundingClientRect();
      anchorPosition = { left: anchor.left, top: anchor.top };
      const toolbar = trigger.closest('.layout-candidate-toolbar').getBoundingClientRect();
      panel.style.width = '';
      const width = Math.min(panel.getBoundingClientRect().width, toolbar.width, viewport.clientWidth - margin * 2);
      panel.style.width = `${width}px`;
      const height = panel.getBoundingClientRect().height;
      const below = anchor.bottom + margin;
      const top = below + height <= viewport.clientHeight - margin ? below : anchor.top - height - margin;
      panel.style.left = `${Math.max(margin, Math.min(anchor.right - width, viewport.clientWidth - width - margin))}px`;
      panel.style.top = `${Math.max(margin, Math.min(top, viewport.clientHeight - height - margin))}px`;
    }
    /** 入口确实移动后收起；忽略打开前已发生、延后派发的滚动事件。 */
    function handleScroll(event) {
      if (panel.contains(event.target)) return;
      const anchor = trigger.getBoundingClientRect();
      if (Math.abs(anchor.left - anchorPosition.left) > 0.5 || Math.abs(anchor.top - anchorPosition.top) > 0.5) setOpen(false);
    }
    position();
    window.addEventListener('resize', position);
    document.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', handleScroll, true);
    };
  }, [open, error]);

  /** 将焦点带入浮窗，外部点击关闭；Escape 关闭并返回入口。 */
  useEffect(() => {
    if (!open) return undefined;
    closeRef.current?.focus({ preventScroll: true });
    /** 不拦截外部点击，让用户直接操作其他控件。 */
    function handlePointerDown(event) {
      if (!panelRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) setOpen(false);
    }
    /** 处理键盘关闭并恢复筛选入口焦点。 */
    function handleKeyDown(event) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    }
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  /** 关闭并丢弃未应用草稿，不改变已有筛选。 */
  function close() { setOpen(false); triggerRef.current?.focus({ preventScroll: true }); }

  /** 打开时复制已应用条件；再次点击入口时仅收起。 */
  function toggle() {
    if (!open) { setDraft({ ...value }); setError(''); }
    setOpen((current) => !current);
  }

  /** 再次点击当前指标切换方向；点击另一指标时使用该指标上次的方向。 */
  function changeSort(sort) {
    setDraft((current) => ({ ...current, sort, [`${sort}Direction`]: current.sort === sort
      ? current[`${sort}Direction`] === 'asc' ? 'desc' : 'asc' : current[`${sort}Direction`] }));
  }

  /** 立即读取受控输入值，避免更新函数执行时读取到浏览器恢复后的旧内容。 */
  function changeRange(key, event) {
    const next = event.target.value;
    setDraft((current) => ({ ...current, [key]: next }));
    setError('');
  }

  /** 校验数值与浏览器坏输入状态，通过后原子应用草稿并关闭浮窗。 */
  function apply(event) {
    event.preventDefault();
    const invalidInput = [heightRef.current, radiusRef.current].some((input) => !input.validity.valid);
    const failure = candidateFilterError(draft) || (invalidInput ? '请输入大于或等于 0 的有效数值。' : '');
    if (failure) { setError(failure); return; }
    onApply({ ...draft });
    close();
  }

  return <>
    <button ref={triggerRef} className="layout-candidate-filter-trigger" type="button" aria-label={`筛选${subject}`} title={`筛选${subject}`}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} data-active={active} onClick={toggle}>
      <Funnel aria-hidden="true" />
    </button>
    {open && createPortal(<form ref={panelRef} id={panelId} className="layout-candidate-filter-popover" noValidate
      role="dialog" aria-modal="false" aria-labelledby={titleId} onSubmit={apply}>
      <header><h3 id={titleId}>{subject}筛选</h3><button ref={closeRef} className="layout-candidate-filter-close" type="button" aria-label="关闭筛选" onClick={close}><X aria-hidden="true" /></button></header>
      <div className="layout-candidate-filter-heading"><span>排序</span><small>再次点击切换升降序</small></div>
      <div className="layout-candidate-sort-buttons">{[[defaultSort, refinements ? '保存顺序' : '默认评分'], ['height', '安装筒高度'], ['radius', '安装筒半径']].map(([sort, label]) => {
        const ascending = draft[`${sort}Direction`] === 'asc';
        const Icon = ascending ? ArrowUp : ArrowDown;
        const direction = sort === 'saved' ? ascending ? '旧到新' : '新到旧'
          : sort === 'score' ? ascending ? '低到高' : '高到低' : ascending ? '升序' : '降序';
        return <button key={sort} type="button" className="layout-candidate-sort-button" data-sort={sort} aria-pressed={draft.sort === sort} onClick={() => changeSort(sort)}>
          <span>{label}</span><span className="layout-candidate-sort-direction"><Icon aria-hidden="true" />{direction}</span>
        </button>;
      })}</div>
      <div className="layout-candidate-range">
        <div className="layout-candidate-filter-heading"><span>数值范围</span><small>两个条件同时满足</small></div>
        <div className="layout-candidate-range-fields">{[
          ['maxHeight', heightId, heightRef, '高度', '<', '安装筒高度小于'],
          ['minRadius', radiusId, radiusRef, '半径', '>', '安装筒半径大于'],
        ].map(([key, id, ref, label, comparison, fullLabel]) => <div className="layout-candidate-range-row" key={key}>
          <label htmlFor={id} title={fullLabel}>{label} {comparison}</label><ParameterNumberInput ref={ref} id={id} min="0" step="any" placeholder="不限"
            aria-label={fullLabel} value={draft[key]} onChange={(event) => changeRange(key, event)} /><span>mm</span>
        </div>)}</div>
      </div>
      {error && <p className="layout-candidate-filter-error" role="alert">{error}</p>}
      <footer><span role="status">符合 {selectCandidateRows(candidates, draft).length} 个{refinements ? '版本' : '方案'}</span><div>
        <button type="button" onClick={() => { setDraft(createCandidateFilter(defaultSort)); setError(''); }}>重置</button>
        <button className="layout-candidate-filter-apply" type="submit">应用</button>
      </div></footer>
    </form>, document.body)}
  </>;
}
