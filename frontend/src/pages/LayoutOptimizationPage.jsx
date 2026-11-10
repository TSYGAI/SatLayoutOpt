/**
 * 文件说明：布局优化功能页，展示正式候选和微调版本；画布右上角呈现卫星图例，以统一工具栏按钮进入人工微调子页。
 * 独立Hook管理后台任务；锁定配置预览包含基座，颜色来自统一配置，预览下方由独立组件展示参数卡片和当前方案装载明细，不计算安装或碰撞约束。
 * 提供公共 toast 占位节点，在右下角反馈布局文件下载结果。
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Download, GitBranch, Maximize, Pencil } from '../components/icons.js';

import { AppShell } from '../app/AppShell.jsx';
import { usePageSessionState } from '../app/page-session-state.js';
import { LayoutSidebar } from './layout-optimization/LayoutSidebar.jsx';
import { LayoutPreviewMetrics } from './layout-optimization/LayoutPreviewMetrics.jsx';
import { LayoutPlacementDetails } from './layout-optimization/LayoutPlacementDetails.jsx';
import { useLayoutOptimization } from './layout-optimization/use-layout-optimization.js';
import { useSavedFixedPreview } from './layout-optimization/use-saved-fixed-preview.js';
import { getLayoutPreviewConfig } from '../api/model-upload-api.js';
import '../../styles/model-upload.css';
import '../../styles/model-settings.css';
import '../../styles/layout-optimization.css';

/** 布局优化页尚未读取到有效参数时的空状态。 */
const EMPTY_LAYOUT_STATE = Object.freeze({ config: null, geometry: null, error: '' });

/** 渲染布局优化的参数栏与整流舱三维预览。 */
export function LayoutOptimizationPage() {
  const navigate = useNavigate();
  const optimization = useLayoutOptimization();
  const fixedPreview = useSavedFixedPreview(optimization.config, !optimization.candidate && !optimization.viewingHistory
    && (!optimization.job || optimization.config?.config_fingerprint === optimization.currentFingerprint));
  const [previewStyle, setPreviewStyle] = useState(null);
  const [styleError, setStyleError] = useState('');
  const [layoutState, setLayoutState] = useState(EMPTY_LAYOUT_STATE);
  const [topologyEdgesVisible, setTopologyEdgesVisible] = usePageSessionState('layout', 'edges', true);
  const viewportRef = useRef(null);
  const orientationGizmoRef = useRef(null);
  const previewRef = useRef(null);
  const geometryRef = useRef(null);
  const resultRef = useRef(null);
  resultRef.current = { candidate: optimization.candidate || fixedPreview.candidate,
    meshes: optimization.candidate ? optimization.meshes : fixedPreview.meshes, style: previewStyle };

  /** 读取统一配色；离页后不发布配置，错误在预览区明确显示。 */
  useEffect(() => {
    let disposed = false;
    getLayoutPreviewConfig().then((style) => { if (!disposed) setPreviewStyle(style); })
      .catch((failure) => { if (!disposed) setStyleError(failure.message); });
    return () => { disposed = true; };
  }, []);

  /** 使用当前配置在已经初始化的控制器中展示整流舱布局空间。 */
  function showGeometry(preview, geometry, config) {
    if (!preview || !geometry) return;
    preview.show({
      radius: geometry.radius_mm,
      height: geometry.height_mm,
      installationRadius: geometry.installation_tube?.min_radius_mm ?? geometry.radius_mm,
      installationHeight: geometry.installation_tube?.min_height_mm ?? geometry.height_mm,
      installationBase: geometry.installation_tube?.base,
      radialSegments: config?.radial_segments || 96,
      axisRadius: geometry.axis_radius_mm,
      fairingRadius: geometry.fairing_radius_mm,
      profile: geometry.fairing_profile || geometry.profile,
    });
  }

  /** 原子显示候选快照；异常时恢复当前舱体空间并向页面暴露原因，避免场景停留在白板。 */
  function showCandidate(preview, candidate, meshes, config, style) {
    if (!preview || !candidate || !meshes || !style) return;
    try {
      // 展示名称不参与几何视角的缓存标识，重命名时继续恢复当前观察位置。
      const previewCandidate = candidate.refinement
        ? { ...candidate, refinement: { ...candidate.refinement, name: undefined } } : candidate;
      preview.showLayout(previewCandidate, meshes, config?.radial_segments || 96, style);
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
    geometry.fairing_profile = form.fairing_profile || form.profile;
    geometry.installation_tube = form.installation_tube;
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
          sessionKey: 'layout', edgesVisible: topologyEdgesVisible,
        });
        previewRef.current = preview;
        const result = resultRef.current;
        if (result?.candidate && result?.meshes && result?.style) {
          showCandidate(preview, result.candidate, result.meshes, geometryRef.current?.config, result.style);
        } else showGeometry(preview, geometryRef.current?.geometry, geometryRef.current?.config);
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
    const result = resultRef.current;
    if (result.candidate && result.meshes && result.style) {
      showCandidate(previewRef.current, result.candidate, result.meshes, layoutState.config, result.style);
    } else {
      showGeometry(previewRef.current, geometryRef.current?.geometry, geometryRef.current?.config);
    }
  }, [optimization.candidate, optimization.meshes, fixedPreview.candidate, fixedPreview.meshes, previewStyle, layoutState.config]);

  /** 切换构件表面边线并同步按钮状态。 */
  function toggleTopologyEdges() {
    const visible = previewRef.current?.toggleTopologyEdges();
    if (typeof visible === 'boolean') setTopologyEdgesVisible(visible);
  }

  const error = layoutState.error || optimization.meshError || fixedPreview.error || styleError;
  const candidate = optimization.candidate;
  const candidateName = candidate?.refinement ? candidate.refinement.name || '未命名微调版本'
    : `方案 ${(optimization.job?.candidates ?? []).findIndex((item) => item.candidate_id === candidate?.candidate_id) + 1}`;
  const fixedCandidate = fixedPreview.candidate;
  const previewLoading = optimization.meshLoading || fixedPreview.loading;
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
              <div className="preview-name-row"><h2 id="layout-preview-title">{candidate ? candidate.refinement?.name || `布局方案 ${candidate.candidate_id.split('-').at(-1)}` : fixedCandidate ? '已保存固定卫星' : geometry ? '整流舱布局空间' : '尚无布局参数'}</h2><span>3D</span></div>
            </div>
            <div className="preview-actions">
              <button className="icon-button layout-refinement-entry" type="button" disabled={!candidate || optimization.busy || !['completed', 'cancelled', 'interrupted', 'failed', 'infeasible'].includes(optimization.job?.status)}
                onClick={() => navigate(`/layout-refinement/${encodeURIComponent(optimization.job.job_id)}/${encodeURIComponent(candidate.candidate_id)}`)}><Pencil aria-hidden="true" /><span>人工微调</span></button>
              <span className={`status-badge ${error ? 'error' : previewLoading ? 'busy' : geometry ? 'ready' : 'busy'}`}><b />{error ? '预览失败' : previewLoading ? '正在加载布局' : candidate ? `${candidate.validation.loaded_count} 颗 · 约束通过` : fixedCandidate ? `${fixedCandidate.placements.length} 颗固定卫星` : geometry ? '输入空间' : '正在读取'}</span>
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
            {previewStyle && geometry && <div className="viewport-badge viewport-badge-right layout-placement-legend" aria-label="卫星颜色图例">
              <span><i style={{ backgroundColor: `#${previewStyle.fixedColor.toString(16).padStart(6, '0')}` }} />固定卫星</span>
              <span><i style={{ backgroundColor: `#${previewStyle.optimizedColor.toString(16).padStart(6, '0')}` }} />优化卫星</span>
            </div>}
          </div>
          <div className="preview-detail-band">
            {error && <p className="layout-preview-error" role="alert">{error}</p>}
            <LayoutPreviewMetrics geometry={geometry} candidate={candidate} />
            <LayoutPlacementDetails candidate={candidate} name={candidateName} />
          </div>
        </section>
      </main>
      <div id="toast" className="toast" role="status" aria-live="polite" hidden />
    </AppShell>
  );
}
