/**
 * 文件说明：卫星设置页的生成、存储和共享范围切换，以及全部存储结果展示。
 * 保留原有三列操作样式，范围由开关和按钮提示表达；仅接收状态与回调，不请求接口或复制后端准入规则。
 */
import { Box, Boxes, Database, LoaderCircle } from '../../components/icons.js';
import '../../../styles/model-settings-actions.css';

/** 渲染两个功能按钮与右侧共享范围切换；disabled 统一阻止任务期间改变范围或重复提交。 */
export function ModelSettingsActions({ scope, onScopeChange, onGenerate, onStore, disabled,
  generating = false, preparing = false, storing = false }) {
  const all = scope === 'all';
  /** 点击明确的范围选项直接选中，键盘或控件空白区域点击则切换；不触发生成或存储。 */
  function handleScopeClick(event) {
    const value = event.target.closest('[data-scope-value]')?.dataset.scopeValue;
    onScopeChange(value || (all ? 'single' : 'all'));
  }
  return (
    <div className="model-settings-envelope-actions" aria-label="包络生成与数据库存储操作">
      <button type="button" data-action="generate" disabled={disabled} aria-busy={generating}
        title={`生成${all ? '全部模型' : '当前模型'}的包络`} onClick={onGenerate}>
        {generating ? <LoaderCircle className="spinning" aria-hidden="true" /> : <Box aria-hidden="true" />}
        <span>{preparing ? '正在准备' : generating ? '正在生成' : '生成包络'}</span>
      </button>
      <button type="button" data-action="store" disabled={disabled} aria-busy={storing}
        title={`检查各项设置后将${all ? '全部模型' : '当前模型'}存储到数据库`} onClick={onStore}>
        {storing ? <LoaderCircle className="spinning" aria-hidden="true" /> : <Database aria-hidden="true" />}
        <span>{storing ? '正在存储' : '存储到数据库'}</span>
      </button>
      <button type="button" role="switch" className="model-settings-scope-switch" disabled={disabled}
        aria-checked={all} aria-label="生成与存储的操作范围"
        onClick={handleScopeClick}>
        <span data-scope-value="single"><Box aria-hidden="true" /><span>单个</span></span>
        <span data-scope-value="all"><Boxes aria-hidden="true" /><span>全部</span></span>
      </button>
    </div>
  );
}

/** 展示全部存储的成功与失败数量；失败项按来源模型列明原因，成功记录不会因其他模型失败而回滚。 */
export function ModelStorageBatchResult({ result }) {
  if (!result) return null;
  const failures = result.results.filter((item) => item.status === 'failed');
  return (
    <div className="model-settings-store-batch-result" aria-label="全部存储结果">
      <p role="status" aria-live="polite">全部存储完成：{result.stored} 个成功，{result.failed} 个失败</p>
      {failures.length > 0 && (
        <details open>
          <summary>查看失败模型及原因</summary>
          <ul>{failures.map((item) => <li key={item.id}><strong>{item.filename || item.id}</strong>：{item.error}</li>)}</ul>
        </details>
      )}
    </div>
  );
}
