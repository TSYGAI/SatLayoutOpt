/**
 * 文件说明：共享三维模型预览面板，统一模型上传页与模型设置页的画布、状态和统计 DOM 契约。
 * Three.js 场景由控制器挂载，本组件提供稳定 DOM 和页面专属工具栏插槽。
 */

import { Box, GitBranch, Maximize } from 'lucide-react';

/**
 * 渲染可被模型预览控制器挂载的共享面板。
 * @param {{ emptyDetail?: string, extraActions?: import('react').ReactNode }} props 空状态说明及可选工具栏内容。
 */
export function ModelPreviewPanel({ emptyDetail = '从左侧模型库选择 STEP 模型', extraActions = null }) {
  return (
    <section className="model-preview-panel" aria-labelledby="preview-title">
      <header className="preview-header">
        <div className="preview-title-group">
          <p className="eyebrow">模型预览</p>
          <div className="preview-name-row"><h2 id="preview-title">尚未选择模型</h2><span id="preview-format">GLB</span></div>
        </div>
        <div className="preview-actions">
          <span id="preview-status" className="status-badge"><b />等待选择</span>
          {extraActions}
          <button id="toggle-topology-edges" className="icon-button active" type="button" title="切换表面边线" aria-label="切换表面边线" disabled><GitBranch /></button>
          <button id="fit-model-view" className="icon-button" type="button" title="适配模型视图" aria-label="适配模型视图" disabled><Maximize /></button>
        </div>
      </header>

      <div id="model-viewport-wrap" className="model-viewport-wrap">
        <div id="model-viewport" className="model-viewport" aria-label="三维模型预览画布" />
        <div id="orientation-gizmo" className="orientation-gizmo" aria-label="模型预览方向立方体" />
        <div id="preview-empty" className="preview-empty">
          <span><Box /></span>
          <strong>模型预览</strong>
          <small>{emptyDetail}</small>
        </div>
        <div id="model-loading" className="model-loading" hidden aria-live="polite">
          <span className="loading-spinner" />
          <strong>正在生成浏览网格</strong>
          <small>STEP 面正在离散为 GLB 并建立映射</small>
        </div>
        <div className="viewport-badge viewport-badge-right"><span className="axis-dot x" />X <span className="axis-dot y" />Y <span className="axis-dot z" />Z</div>
      </div>

      <div className="preview-detail-band">
        <div className="model-stats" aria-live="polite">
          <div><small>实体</small><strong id="stat-bodies">--</strong></div>
          <div><small>STEP 面</small><strong id="stat-faces">--</strong></div>
          <div><small>三角形</small><strong id="stat-triangles">--</strong></div>
          <div><small>包围尺寸</small><strong id="stat-bounds">--</strong></div>
        </div>
      </div>
    </section>
  );
}
