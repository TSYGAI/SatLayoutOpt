/**
 * 文件说明：横向展示三档共享预算，默认中档；选择仅更新弹窗，明确确认后才合并草稿。
 * 硬件策略和功能优先级由后端计算，组件仅展示结果，适配窗口大小及键盘操作。
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from '../../components/icons.js';
import { formatMemory } from './hardware-config-state.js';
import { formatParameterNumber } from '../../utils/number-format.js';

/** 展示单个方案；原生单选框支持方向键，资源不足的档位保持可见并解释原因。 */
function RecommendationCard({ tier, selected, defaultId, onSelect }) {
  return <section className={`hardware-tier${selected ? ' is-selected' : ''}${tier.available ? '' : ' is-unavailable'}`}
    data-tier-id={tier.id} aria-label={`${tier.label}完整推荐参数`} onClick={() => { if (tier.available) onSelect(tier.id); }}>
    <header className="hardware-tier-summary"><label className="hardware-tier-heading">
      <span>{tier.label}</span><span className="hardware-tier-badge">{selected ? '已选择' : tier.id === defaultId ? '默认方案' : '可选方案'}</span>
      <input type="radio" name="hardware-recommendation-tier" value={tier.id} checked={selected}
        disabled={!tier.available} aria-label={`${tier.label} ${Math.round(tier.fraction * 100)}%`}
        onChange={() => onSelect(tier.id)} />
    </label>
    <div className="hardware-tier-budget"><strong className="hardware-tier-percent">{Math.round(tier.fraction * 100)}<small>%</small></strong>
      <span className="hardware-tier-caption">{tier.cpu_slots ?? '—'} 个计算槽位 · {formatMemory(tier.memory_budget_bytes)}</span></div>
    <p>{tier.description}</p>
    </header>
    <div className="hardware-tier-content" tabIndex={0} aria-label={`${tier.label}参数详情`}>
      {tier.available ? <>
        <RecommendationChanges tier={tier} />
        <details className="hardware-minimum-details"><summary>各功能最低配置与优先级</summary>
          {tier.allocation.map((item) => <p key={item.label}><strong>{item.label}</strong><br />
            优先级 {item.priority} · 最低 {item.minimum_threads} 线程 / {formatMemory(item.minimum_memory_bytes)}<br />
            推荐线程上限 {item.threads}，内存另按模型规模追加。
          </p>)}
        </details>
        <p className="hardware-tier-footnote">总预算已为界面、缓存与显示工作空间预留 {formatMemory(tier.application_memory_bytes)}；各任务共享剩余资源。</p>
        {(tier.notes || []).map((note) => <p className="hardware-tier-footnote" key={note}>{note}</p>)}
      </> : <p className="hardware-tier-footnote">{tier.unavailable_reason}</p>}
    </div>
  </section>;
}

/** 每一列都直接展开完整的分模块差异，沿用单套推荐的当前值、推荐值及原因展示。 */
function RecommendationChanges({ tier }) {
  if (!tier?.available) return null;
  return <div className="hardware-recommendation-changes">
    <p className="hardware-recommendation-summary">当前编辑值 → 推荐值 · {tier.items.length} 项调整</p>
    {tier.items.length ? <div className="hardware-recommendation-list">
      {tier.groups.map((group) => <section key={group.id}><h3>{group.label}</h3>
          {group.items.map((item) => <article key={item.key} data-recommendation-key={item.key}>
            <div><strong>{item.label}</strong><small>{item.reason}</small>
              {item.replacesDraft && <small className="hardware-tag pending">将替换未保存修改</small>}</div>
            <span><em>{formatParameterNumber(item.fromDisplay, item.fromDisplay)} {item.unit}</em><b aria-hidden="true">→</b><em>{formatParameterNumber(item.toDisplay, item.toDisplay)} {item.unit}</em></span>
          </article>)}
      </section>)}
    </div> : <p className="hardware-recommendation-empty">当前编辑值已符合此方案，无需修改。</p>}
  </div>;
}

/** 选择不会改动草稿；确认只提交当前选中的可用方案，右上角关闭与 Esc 均保持原稿。 */
export function HardwareRecommendationDialog({ recommendation, onClose, onApply }) {
  const dialog = useRef(null);
  const [selectedId, setSelectedId] = useState(null);
  useEffect(() => {
    if (!dialog.current) return;
    if (recommendation) {
      setSelectedId(recommendation.default_tier_id);
      if (!dialog.current.open) dialog.current.showModal();
    } else if (dialog.current.open) dialog.current.close();
  }, [recommendation]);
  const selected = recommendation?.tiers.find((tier) => tier.id === (selectedId || recommendation.default_tier_id));
  return createPortal(<dialog ref={dialog} className="hardware-recommendation-dialog" aria-labelledby="hardware-recommendation-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    {recommendation && <>
      <header className="hardware-recommendation-header">
        <button type="button" className="hardware-dialog-close" aria-label="关闭硬件推荐弹窗" title="关闭" onClick={onClose}>
          <X aria-hidden="true" strokeWidth={1.5} />
        </button>
        <h2 id="hardware-recommendation-title">硬件推荐参数</h2>
        <p className="hardware-recommendation-summary">{recommendation.summary}</p>
      </header>
      <div className="hardware-recommendation-body">
        <div className="hardware-tiers" role="radiogroup" aria-label="全软件资源预算档位">
          {recommendation.tiers.map((tier) => <RecommendationCard key={tier.id} tier={tier}
            selected={selected?.id === tier.id} defaultId={recommendation.default_tier_id} onSelect={setSelectedId} />)}
        </div>
      </div>
      <details className="hardware-budget-notes"><summary>预算与并行说明 · 最低配置先保障，剩余资源按需分配</summary>
        <ul className="hardware-recommendation-notes">{recommendation.notes.map((note) => <li key={note}>{note}</li>)}</ul>
      </details>
      <footer className="hardware-recommendation-actions">
        <p className="hardware-recommendation-selection" role="status">
          {selected?.available ? `已选${selected.label} · ${Math.round(selected.fraction * 100)}%，确认后调整 ${selected.items.length} 项参数。` : '此档位资源不足，请选择其他可用档位。'}
        </p>
        <button type="button" className="hardware-button primary" disabled={!selected?.available || selected.items.length === 0}
          onClick={() => onApply(selected.id)}>确认方案并应用到草稿</button>
      </footer>
    </>}
  </dialog>, document.body);
}
