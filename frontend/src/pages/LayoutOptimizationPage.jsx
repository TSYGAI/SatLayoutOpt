/**
 * 文件说明：布局优化功能页，左栏填写任务参数与记录，右栏按服务结果预览五组正式安全包络布局。
 * 后台任务、导出和状态由独立 Hook 管理；页面不计算约束，卫星包络由位姿矩阵映射到全局坐标。
 */

import { useEffect, useRef, useState } from 'react';
import { Box, Download, GitBranch, Maximize } from 'lucide-react';

import { AppShell } from '../app/AppShell.jsx';
import { LayoutSidebar } from './layout-optimization/LayoutSidebar.jsx';
import { useLayoutOptimization } from './layout-optimization/use-layout-optimization.js';
import {
  formatMillimeters,
  formatVolume,
} from './pre-config/pre-config-state.js';
import '../../styles/model-upload.css';
import '../../styles/model-settings.css';
import '../../styles/layout-optimization.css';

/** 布局优化页尚未读取到有效参数时的空状态。 */
const EMPTY_LAYOUT_STATE = Object.freeze({ config: null, geometry: null, error: '' });

/** 把中轴方向格式化为紧凑的坐标轴文本。 */
function formatAxisDirection(direction) {
  if (!Array.isArray(direction) || direction.length !== 3) return '--';
  const [x, y, z] = direction.map(Number);
  if (![x, y, z].every(Number.isFinite)) return '--';
  if (Math.abs(x) < 1e-6 && Math.abs(y) < 1e-6 && Math.abs(z - 1) < 1e-6) return '+Z';
  return `[${x}, ${y}, ${z}]`;
}

/** 渲染布局优化的参数栏与整流舱三维预览。 */
export function LayoutOptimizationPage() {
  const optimization = useLayoutOptimization();
  const [layoutState, setLayoutState] = useState(EMPTY_LAYOUT_STATE);
  const [topologyEdgesVisible, setTopologyEdgesVisible] = useState(true);
  const viewportRef = useRef(null);
  const orientationGizmoRef = useRef(null);
  const previewRef = useRef(null);
  const geometryRef = useRef(null);
  const resultRef = useRef(null);
  resultRef.current = { candidate: optimization.candidate, meshes: optimization.meshes };

  /** 使用当前配置在已经初始化的控制器中展示整流舱布局空间。 */
  function showGeometry(preview, geometry, config) {
    if (!preview || !geometry) return;
    preview.show({
      radius: geometry.radius_mm,
      height: geometry.height_mm,
      radialSegments: config?.radial_segments || 96,
      axisRadius: geometry.axis_radius_mm,
      fairingRadius: geometry.fairing_radius_mm,
    });
  }

  /** 原子显示候选快照；异常时恢复当前舱体空间并向页面暴露原因，避免场景停留在白板。 */
  function showCandidate(preview, candidate, meshes, config) {
    if (!preview || !candidate || !meshes) return;
    try {
      preview.showLayout(candidate, meshes, config?.radial_segments || 96);
      setLayoutState((current) => current.error ? { ...current, error: '' } : current);
    } catch (failure) {
      showGeometry(preview, geometryRef.current?.geometry, geometryRef.current?.config);
      setLayoutState((current) => ({ ...current, error: `布局预览加载失败：${failure.message}` }));
    }
  }

  /** 将服务端锁定前置配置的区间最小值映射为预览空间；左栏不提供尺寸覆盖。 */
  useEffect(() => {
    const form = optimization.config?.geometry;
    if (!form) return;
    const radius = Number(form.min_radius_mm), height = Number(form.min_height_mm);
    const fairingRadius = Number(form.fairing_radius_mm), axisRadius = Number(form.axis_radius_mm);
    if (![radius, height, fairingRadius, axisRadius].every((value) => Number.isFinite(value) && value > 0)) return;
    const config = optimization.config?.geometry;
    const geometry = { radius_mm: radius, diameter_mm: radius * 2, height_mm: height,
      volume_mm3: Math.PI * radius ** 2 * height, axis_radius_mm: axisRadius,
      fairing_radius_mm: fairingRadius, axis: { direction: [0, 0, 1] } };
    geometryRef.current = { geometry, config };
    setLayoutState({ config, geometry, error: '' });
    if (!optimization.candidate) showGeometry(previewRef.current, geometry, config);
  }, [optimization.config]);

  /** 按需加载共享圆柱预览控制器，避免布局页之外的入口下载 Three.js。 */
  useEffect(() => {
    if (!viewportRef.current || previewRef.current) return undefined;
    let disposed = false;
    void import('./pre-config/cylinder-preview.js')
      .then((module) => {
        if (disposed || !viewportRef.current) return;
        const preview = module.createCylinderPreview({
          container: viewportRef.current,
          orientationGizmoContainer: orientationGizmoRef.current,
        });
        previewRef.current = preview;
        showGeometry(preview, geometryRef.current?.geometry, geometryRef.current?.config);
        const result = resultRef.current;
        if (result?.candidate && result?.meshes) {
          showCandidate(preview, result.candidate, result.meshes, geometryRef.current?.config);
        }
        if (import.meta.env.DEV) {
          window.__layoutOptimizationPreviewTestApi = {
            /** 返回布局预览交互状态，供浏览器回归测试核对统一操作。 */
            getInteractionSnapshot: () => previewRef.current?.getInteractionSnapshot() ?? null,
            /** 返回布局预览的整流罩半径，供验收核对直接半径契约。 */
            getFairingRadius: () => previewRef.current?.getFairingInnerRadius() ?? null,
            /** 返回当前后端候选标识，不暴露渲染器或可写场景状态。 */
            getCandidateId: () => resultRef.current?.candidate?.candidate_id ?? null,
          };
        }
      })
      .catch((error) => {
        if (!disposed) setLayoutState((current) => ({ ...current, error: `三维预览初始化失败：${error.message}` }));
      });
    return () => {
      disposed = true;
      if (import.meta.env.DEV) delete window.__layoutOptimizationPreviewTestApi;
      previewRef.current?.dispose();
      previewRef.current = null;
    };
  }, []);

  /** 切换候选或历史任务时显示其独立几何快照；未完成任务恢复输入空间。 */
  useEffect(() => {
    if (optimization.candidate && optimization.meshes) {
      showCandidate(previewRef.current, optimization.candidate, optimization.meshes, layoutState.config);
    } else {
      showGeometry(previewRef.current, geometryRef.current?.geometry, geometryRef.current?.config);
    }
  }, [optimization.candidate, optimization.meshes, layoutState.config]);

  /** 切换构件表面边线并同步按钮状态。 */
  function toggleTopologyEdges() {
    const visible = previewRef.current?.toggleTopologyEdges();
    if (typeof visible === 'boolean') setTopologyEdgesVisible(visible);
  }

  const { error } = layoutState;
  const candidate = optimization.candidate;
  const geometry = candidate ? {
    radius_mm: candidate.radius_mm, diameter_mm: candidate.radius_mm * 2, height_mm: candidate.height_mm,
    fairing_radius_mm: candidate.fairing_radius_mm, volume_mm3: Math.PI * candidate.radius_mm ** 2 * candidate.height_mm,
    axis: { direction: [0, 0, 1] },
  } : layoutState.geometry;
  return (
    <AppShell className="model-page-shell layout-optimization-page-shell" pageTitle="布局优化">
      <main className="model-workspace layout-optimization-workspace">
        <LayoutSidebar state={optimization} />

        <section className="model-preview-panel layout-optimization-preview" aria-labelledby="layout-preview-title">
          <header className="preview-header">
            <div className="preview-title-group">
              <p className="eyebrow">布局预览</p>
              <div className="preview-name-row"><h2 id="layout-preview-title">{candidate ? `布局方案 ${candidate.candidate_id.split('-').at(-1)}` : geometry ? '整流舱布局空间' : '尚无布局参数'}</h2><span>3D</span></div>
            </div>
            <div className="preview-actions">
              <span className={`status-badge ${error ? 'error' : geometry ? 'ready' : 'busy'}`}><b />{error ? '预览失败' : candidate ? `${candidate.validation.loaded_count} 颗 · 约束通过` : geometry ? '输入空间' : '正在读取'}</span>
              <button className="icon-button" type="button" title="导出当前方案 Excel" aria-label="导出当前方案 Excel" disabled={!candidate || optimization.busy} onClick={optimization.exportCurrentCandidate}><Download /></button>
              <button className={`icon-button${topologyEdgesVisible ? ' active' : ''}`} type="button" title="切换表面边线" aria-label="切换表面边线" aria-pressed={topologyEdgesVisible} disabled={!geometry} onClick={toggleTopologyEdges}><GitBranch /></button>
              <button className="icon-button" type="button" title="适配布局视图" aria-label="适配布局视图" disabled={!geometry} onClick={() => previewRef.current?.fitView()}><Maximize /></button>
            </div>
          </header>
          <div id="layout-optimization-viewport-wrap" className="model-viewport-wrap">
            <div ref={viewportRef} className="model-viewport" aria-label="布局优化三维预览画布" />
            <div ref={orientationGizmoRef} className="orientation-gizmo" aria-label="布局优化预览方向立方体" />
            {!geometry && <div className="preview-empty"><span><Box /></span><strong>布局预览</strong><small>请先完成并保存前置配置</small></div>}
            <div className="viewport-badge viewport-badge-right"><span className="axis-dot x" />X <span className="axis-dot y" />Y <span className="axis-dot z" />Z</div>
          </div>
          <div className="preview-detail-band">
            <p className="layout-preview-caption">全局坐标：舱段底面中心为原点，+Z 向上。{error || (candidate ? '显示正式安全包络；红色点为整体卫星质心。' : '请在左栏填写参数并开始优化。')}</p>
            <div className="model-stats layout-optimization-stats" aria-live="polite">
              <div><small>预览底面直径</small><strong>{geometry ? formatMillimeters(geometry.diameter_mm) : '--'}</strong></div>
              <div><small>预览高度</small><strong>{geometry ? formatMillimeters(geometry.height_mm) : '--'}</strong></div>
              <div><small>体积</small><strong>{geometry ? formatVolume(geometry.volume_mm3) : '--'}</strong></div>
              <div><small>整流罩半径</small><strong>{geometry ? formatMillimeters(geometry.fairing_radius_mm) : '--'}</strong></div>
              <div><small>中轴方向</small><strong>{geometry ? formatAxisDirection(geometry.axis?.direction) : '--'}</strong></div>
            </div>
          </div>
        </section>
      </main>
    </AppShell>
  );
}
