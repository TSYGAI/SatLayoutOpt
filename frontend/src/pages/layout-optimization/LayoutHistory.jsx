/** 文件说明：展示布局历史及图标入口，由独立居中弹窗承接重命名和删除；持久化委托布局状态 Hook。 */

import { useRef, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { JOB_LABELS, isLayoutRunning } from './layout-state.js';
import { LayoutHistoryDialog } from './LayoutHistoryDialog.jsx';

/** 展示单条历史及操作入口，保留旧名称回退和运行任务的删除保护。 */
function HistoryItem({ item, state, navigationLocked, onAction }) {
  const name = item.name || item.notes || item.job_id.slice(0, 8);
  const active = state.job?.job_id === item.job_id;
  const running = isLayoutRunning(active ? state.job : item);

  return <article className={`layout-history-item${active ? ' active' : ''}`} data-project-id={item.job_id}>
    <button className="layout-history-open" type="button" disabled={navigationLocked}
      aria-pressed={active} onClick={() => state.restore(item.job_id)}>
      <strong title={name}>{name}</strong>
      <span>{new Date(item.created_at).toLocaleString()} · {JOB_LABELS[item.status]}</span>
    </button>
    <div className="layout-history-actions">
      <button type="button" aria-label="重命名" title="重命名" disabled={state.busy}
        onClick={() => onAction({ mode: 'rename', id: item.job_id, name })}><Pencil aria-hidden="true" /></button>
      <button className="layout-history-delete" type="button" disabled={state.busy || running}
        aria-label="删除" title={running ? '请取消计算并等待结束后再删除' : '删除该历史项目及快照'}
        onClick={() => onAction({ mode: 'delete', id: item.job_id, name })}><Trash2 aria-hidden="true" /></button>
    </div>
  </article>;
}

/** 按原顺序展示历史和分页入口；当前任务运行时保留编辑能力，暂停切换预览。 */
export function LayoutHistory({ state }) {
  const [dialog, setDialog] = useState(null);
  const headingRef = useRef(null);
  const navigationLocked = state.busy || isLayoutRunning(state.job);
  return <section className="layout-optimization-section" aria-label="历史项目">
    <details className="layout-history-list" open>
      <summary><h3 ref={headingRef} tabIndex={-1}>历史项目</h3></summary>
      <div className="layout-history-list-items">
        <div className="layout-history">
          {state.history.map((item) => <HistoryItem key={item.job_id} item={item} state={state} navigationLocked={navigationLocked} onAction={setDialog} />)}
        </div>
        {!state.historyTotal && <p className="layout-optimization-hint">暂无历史项目。</p>}
        {state.history.length < state.historyTotal && <button type="button" disabled={state.busy} onClick={state.loadMoreHistory}>加载更多历史</button>}
      </div>
    </details>
    {dialog && <LayoutHistoryDialog target={dialog} state={state} fallbackFocusRef={headingRef} onClose={() => setDialog(null)} />}
  </section>;
}
