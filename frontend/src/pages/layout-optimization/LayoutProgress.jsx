/** 文件说明：以配置校验、布局搜索、结果整理展示任务阶段和总预算进度，失败原因仅在对应阶段告警；依赖展示模型与既有图标，不控制任务执行。 */

import { Check, ChevronDown, ListTree, X } from '../../components/icons.js';
import { layoutJobProgressView } from './layout-job-progress.js';
import '../../../styles/layout-job-progress.css';

/** 显示阶段编号或结束标识；状态文字由相邻标签提供，图标仅作辅助。 */
function StageMark({ state, index }) {
  return <span className={`layout-progress-mark is-${state}`} aria-hidden="true">
    {state === 'done' ? <Check /> : state === 'error' ? <X /> : state === 'stopped' ? <span className="layout-progress-stop" /> : index + 1}
  </span>;
}

/** 展示累计尝试占任务总预算的比例；缺少总预算时保留未知值，不伪造百分比。 */
function SearchProgress({ view }) {
  const countText = `${view.attempts ?? '—'}${view.total === null ? '' : ` / ${view.total}`} 次`;
  return <div className="layout-progress-budget">
    <div className="layout-progress-row"><span>整体优化进度</span><strong className="layout-progress-percent">
      {view.percent ?? '—'}{view.percent !== null && <small>%</small>}
    </strong></div>
    {view.percent !== null && <div className="layout-progress-meter" role="progressbar" aria-label="整体优化进度（按总尝试次数）"
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={view.percent} aria-valuetext={`累计尝试 ${countText}，${view.percent}%`}>
      <span style={{ width: `${view.percent}%` }} />
    </div>}
    <p className="layout-progress-attempts" aria-label="累计尝试"><span>累计尝试</span>{' '}<strong>{countText}</strong></p>
  </div>;
}

/** 渲染真实任务阶段与日志；日志默认展开并按新到旧排列，折叠状态在同一任务轮询时保持。 */
export function LayoutProgress({ job }) {
  const view = layoutJobProgressView(job);
  return <section className={`layout-optimization-section layout-job-progress is-${view.tone}`} aria-label="任务进度">
    <header className="layout-progress-heading"><h2 className="layout-sidebar-title">任务进度</h2>
      <span className="layout-progress-status" aria-live="polite">{view.statusLabel}</span>
    </header>
    <ol className="layout-progress-steps" aria-label="优化阶段">{view.steps.map((step, index) => <li key={step.id} data-stage={step.id}>
      <StageMark state={step.state} index={index} />
      <div className="layout-progress-stage-heading"><h3 className="layout-sidebar-subtitle">{step.label}</h3><span aria-live="polite">{step.status}</span></div>
      {step.id === 'search' && view.showSearchDetails && <SearchProgress view={view} />}
      {step.message && <p className={`layout-progress-message${step.state === 'error' ? ' is-error' : ''}`} role={step.state === 'error' ? 'alert' : undefined}>{step.message}</p>}
      {step.id === 'result' && view.count !== null && <p className="layout-progress-result">已验收 <strong>{view.count}</strong> 组布局</p>}
    </li>)}</ol>
    {view.showSearchDetails && view.events.length > 0 && <details className="layout-progress-records" open>
      <summary><ListTree aria-hidden="true" /><h3 className="layout-sidebar-subtitle">运行记录</h3><small>{view.events.length} 条</small><ChevronDown className="layout-progress-chevron" aria-hidden="true" /></summary>
      <ol className="layout-progress-events">{view.events.slice().reverse().map((event, index) => <li key={`${event.time ?? ''}-${view.events.length - index}`}>
        <time dateTime={Number.isFinite(Date.parse(event.time)) ? event.time : undefined}>{event.timeLabel || '—'}</time>
        <span>{event.message}</span>
      </li>)}</ol>
    </details>}
  </section>;
}
