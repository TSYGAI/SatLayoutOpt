/**
 * 文件说明：硬件设置功能页，按业务阶段组织资源设置，以自适应滚动区承载等高面板和常驻保存栏。
 * 依赖公共外壳、独立表单组件和配置 API；不在前端实现调度规则或直接写入 TOML。
 */

import { AppShell } from '../app/AppShell.jsx';
import { useState } from 'react';
import { RefreshCw, TriangleAlert } from '../components/icons.js';
import { HardwareFields } from './hardware-config/HardwareFields.jsx';
import { HardwareResources } from './hardware-config/HardwareResources.jsx';
import { HardwareLeaveDialog } from './hardware-config/HardwareLeaveDialog.jsx';
import { HardwareRecommendationDialog } from './hardware-config/HardwareRecommendationDialog.jsx';
import { useHardwareConfig } from './hardware-config/use-hardware-config.js';
import { useHardwareLayout } from './hardware-config/use-hardware-layout.js';
import '../../styles/hardware-config.css';

/** 渲染模块导航、资源概况及配置表单；全部模块的编辑统一保存并明确提示重启生效。 */
export function HardwareConfigPage() {
  const state = useHardwareConfig();
  const [selected, setSelected] = useState('shared');
  const snapshot = state.snapshot;
  const scrollRef = useHardwareLayout(Boolean(snapshot));
  const module = snapshot?.modules.find((item) => item.id === selected);
  const fields = snapshot?.fields.filter((field) => field.module === selected) || [];
  const busy = state.status !== 'ready';
  const changedCount = Object.keys(state.changes).length;

  /** 阻止浏览器原生表单导航，保存所有模块的配置增量。 */
  function handleSubmit(event) { event.preventDefault(); state.save(); }

  return (
    <AppShell className="hardware-shell" pageTitle="硬件设置" status={state.status === 'saving' ? '正在保存配置' : '系统就绪'}>
      <div className="hardware-scroll" ref={scrollRef} data-scroll-position-key="hardware-content">
      <main className="hardware-page" aria-label="硬件设置">
        <header className="hardware-heading"><div><span className="hardware-eyebrow">性能与资源</span><h1>硬件设置</h1></div>
          <div className="hardware-heading-actions">
            <button className="hardware-button" type="button" disabled={busy || state.dirty} onClick={state.reload}><RefreshCw aria-hidden="true" />重新读取</button>
            <button className="hardware-button primary" type="button" disabled={busy || !snapshot} onClick={state.loadRecommendation}>
              {state.recommendationStatus === 'loading' ? '正在生成推荐…' : '生成推荐参数'}
            </button>
          </div>
        </header>
        {snapshot && <HardwareResources hardware={snapshot.hardware} />}
        {state.error && <div className="hardware-notice error" role="alert"><TriangleAlert aria-hidden="true" /><div>{state.error}
          {state.conflict && <button type="button" disabled={busy} onClick={state.reload}>重新读取并放弃本地修改</button>}
          {!snapshot && <button type="button" disabled={busy} onClick={state.reload}>重试</button>}</div></div>}
        {state.message && <div className="hardware-notice success" role="status">{state.message}</div>}
        {!snapshot && state.status === 'loading' && <p className="hardware-loading" role="status">正在读取配置和硬件信息…</p>}
        {snapshot && <>
          <div className={`hardware-notice ${snapshot.restart_required ? 'pending' : ''}`}>
            <span className="hardware-status-dot" /><div><strong>{snapshot.restart_required ? `${snapshot.pending_keys.length} 项配置待重启生效` : '配置与当前运行值一致'}</strong></div>
          </div>
          {snapshot.warnings.length > 0 && <div className="hardware-notice pending"><TriangleAlert aria-hidden="true" /><div><strong>资源调配提示</strong>
            <ul>{snapshot.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div></div>}
          <form id="hardware-config-form" className="hardware-workspace" onSubmit={handleSubmit} noValidate>
            <aside className="hardware-sidebar"><div className="hardware-sidebar-content"><h2>处理模块</h2><nav aria-label="硬件设置模块">{snapshot.modules.map((item, index) => {
              const edits = snapshot.fields.filter((field) => field.module === item.id && Object.hasOwn(state.changes, field.key)).length;
              return <button type="button" key={item.id} className={selected === item.id ? 'active' : ''}
                aria-current={selected === item.id ? 'true' : undefined} onClick={() => setSelected(item.id)}>
                <span className="hardware-module-number">{String(index + 1).padStart(2, '0')}</span><span>{item.label}</span>{edits > 0 && <b aria-label={`${edits} 项未保存`}>{edits}</b>}
              </button>;
            })}</nav><p>所有模块共享全局 CPU 与内存预算，实际并发可能低于设定上限。</p></div></aside>
            <section className="hardware-panel" aria-labelledby="hardware-module-title" key={selected}>
              <header><span className="hardware-eyebrow">模块设置</span><h2 id="hardware-module-title">{module.label}</h2><p>{module.description}</p></header>
              <div className="hardware-module-note">{module.note}</div>
              <HardwareFields fields={fields} state={state} />
            </section>
          </form>
        </>}
      </main>
      </div>
      {snapshot && <div className="hardware-savebar-area">
        <footer className="hardware-savebar"><div><strong>{state.dirty ? `${changedCount} 项未保存修改` : '所有修改已保存'}</strong><small>保存范围：全部模块 · 重启后统一生效</small></div>
          <div><button className="hardware-button" type="button" disabled={busy || !state.dirty} onClick={state.discard}>撤销未保存修改</button>
            <button className="hardware-button primary" type="submit" form="hardware-config-form" disabled={busy || !state.dirty}>{state.status === 'saving' ? '保存中…' : '保存配置'}</button></div>
        </footer>
      </div>}
      <HardwareLeaveDialog state={state} />
      <HardwareRecommendationDialog recommendation={state.recommendation} onClose={state.closeRecommendation} onApply={state.applyRecommendation} />
    </AppShell>
  );
}
