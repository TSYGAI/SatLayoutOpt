/**
 * 文件说明：前置配置功能页，左侧配置卫星数量、整流舱段尺寸区间和整流罩半径，右侧按区间最小值预览。
 * 卫星数量和几何参数写入前置配置数据库；整流舱段由后端按最小半径与最小高度构建 STEP。
 * 本页不提供构件下载入口，STEP 仅作为后续布局阶段的内部产物。
 */

import { useEffect, useRef, useState } from 'react';
import { Box, GitBranch, LoaderCircle, Maximize } from 'lucide-react';

import { AppShell } from '../app/AppShell.jsx';
import {
  getPreConfig,
  saveCustomFairingSegment,
  saveSatelliteCount,
} from '../api/pre-config-api.js';
import { showToast } from '../components/toast.js';
import {
  buildFairingSegmentPayload,
  buildSatelliteCountPayload,
  clearFairingDraft,
  formatMillimeters,
  formatTimestamp,
  formatVolume,
  normalizeLimits,
  normalizePreConfig,
  readFairingDraft,
  restoreSavedFairingGeometry,
  SATELLITE_COUNT_EVENT,
  writeFairingDraft,
} from './pre-config/pre-config-state.js';
import '../../styles/model-upload.css';
import '../../styles/model-settings.css';
import '../../styles/pre-config.css';

const EMPTY_LIMITS = Object.freeze(normalizeLimits({}));
const EMPTY_DRAFT = Object.freeze({
  min_radius_mm: '',
  max_radius_mm: '',
  min_height_mm: '',
  max_height_mm: '',
  axis_radius_mm: '',
  fairing_radius_mm: '',
  radial_segments: 96,
  limits: EMPTY_LIMITS,
});
const EMPTY_SAVED = Object.freeze({ fairing: null, satellites: Object.freeze([]) });
/** 中轴方向向量的分量容差，小于该值时按 0 显示。 */
const AXIS_COMPONENT_EPSILON = 1e-6;

/**
 * 把中轴方向向量格式化为带符号的轴向文本。
 * @param {unknown} direction 形如 `[0, 0, 1]` 的方向向量。
 * @returns {string} 例如 `+Z`、`-Y` 或 `(0.6, 0, 0.8)` 的紧凑描述。
 */
function formatAxisDirection(direction) {
  if (!Array.isArray(direction) || direction.length !== 3) return '--';
  const components = direction.map((value) => Number(value));
  if (!components.every(Number.isFinite)) return '--';
  const axes = ['X', 'Y', 'Z'];
  const single = components.findIndex((value) => Math.abs(value) > 1 - AXIS_COMPONENT_EPSILON);
  if (single >= 0) return `${components[single] > 0 ? '+' : '-'}${axes[single]}`;
  return `(${components.map((value) => (Math.abs(value) < AXIS_COMPONENT_EPSILON ? '0' : value.toFixed(2))).join(', ')})`;
}

/** 渲染前置配置页面。 */
export function PreConfigPage() {
  const [draft, setDraft] = useState({ ...EMPTY_DRAFT });
  const [saved, setSaved] = useState({ ...EMPTY_SAVED });
  const [satelliteCounts, setSatelliteCounts] = useState({});
  const [satelliteAction, setSatelliteAction] = useState(null);
  const [geometry, setGeometry] = useState(null);
  const [loadState, setLoadState] = useState('loading');
  const [fairingAction, setFairingAction] = useState(null);
  const [fairingState, setFairingState] = useState({ state: 'idle', message: '' });
  const [topologyEdgesVisible, setTopologyEdgesVisible] = useState(true);
  const viewportRef = useRef(null);
  const orientationGizmoRef = useRef(null);
  const previewRef = useRef(null);
  const geometryRef = useRef(null);
  const mountedRef = useRef(true);
  const draftRef = useRef({ ...EMPTY_DRAFT });
  const satelliteControllerRef = useRef(null);
  const fairingControllerRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      satelliteControllerRef.current?.abort();
      fairingControllerRef.current?.abort();
    };
  }, []);

  /** 按需加载 Three.js 预览控制器，避免前置配置页阻塞在三维依赖上。 */
  useEffect(() => {
    if (!viewportRef.current || previewRef.current) return undefined;
    let disposed = false;
    void import('./pre-config/cylinder-preview.js')
      .then((module) => {
        if (disposed || !viewportRef.current) return;
        previewRef.current = module.createCylinderPreview({
          container: viewportRef.current,
          orientationGizmoContainer: orientationGizmoRef.current,
        });
        showGeometryPreview(geometryRef.current);
        if (import.meta.env.DEV) {
          window.__preConfigPreviewTestApi = {
            /** 返回当前整流舱段的世界包围盒，供浏览器验收断言其位于 z ≥ 0 的上半空间。 */
            getCylinderWorldBounds: () => previewRef.current?.getCylinderWorldBounds() ?? null,
            /** 返回直接配置的同轴整流罩半径，供浏览器验收核对预览参数。 */
            getFairingInnerRadius: () => previewRef.current?.getFairingInnerRadius() ?? null,
            /** 返回相机、旋转中心、投影平移与边线状态，供浏览器回归测试验证统一交互。 */
            getInteractionSnapshot: () => previewRef.current?.getInteractionSnapshot() ?? null,
          };
        }
      })
      .catch((error) => {
        if (!disposed) setFairingState({ state: 'error', message: `三维预览初始化失败：${error.message}` });
      });
    return () => {
      disposed = true;
      if (import.meta.env.DEV) delete window.__preConfigPreviewTestApi;
      previewRef.current?.dispose();
      previewRef.current = null;
    };
  }, []);

  /** 读取前置配置：按类型的卫星数量与整流舱段参数。 */
  useEffect(() => {
    const controller = new AbortController();
    setLoadState('loading');
    getPreConfig(controller.signal)
      .then((config) => {
        if (controller.signal.aborted) return;
        const normalized = normalizePreConfig(config);
        // 页面草稿优先使用本次会话未保存的输入，其次才是后端参数。
        const sessionDraft = readFairingDraft();
        const nextDraft = {
          min_radius_mm: sessionDraft ? sessionDraft.min_radius_mm : String(normalized.min_radius_mm),
          max_radius_mm: sessionDraft ? sessionDraft.max_radius_mm : String(normalized.max_radius_mm),
          min_height_mm: sessionDraft ? sessionDraft.min_height_mm : String(normalized.min_height_mm),
          max_height_mm: sessionDraft ? sessionDraft.max_height_mm : String(normalized.max_height_mm),
          axis_radius_mm: sessionDraft ? sessionDraft.axis_radius_mm : String(normalized.axis_radius_mm),
          fairing_radius_mm: sessionDraft?.fairing_radius_mm !== undefined
            ? sessionDraft.fairing_radius_mm : String(normalized.fairing_radius_mm),
          radial_segments: normalized.radial_segments,
          limits: normalized.limits,
        };
        draftRef.current = nextDraft;
        setDraft(nextDraft);
        const restoredFairing = normalized.fairing_stored
          ? {
              min_radius_mm: normalized.min_radius_mm,
              max_radius_mm: normalized.max_radius_mm,
              min_height_mm: normalized.min_height_mm,
              max_height_mm: normalized.max_height_mm,
              axis_radius_mm: normalized.axis_radius_mm,
              fairing_radius_mm: normalized.fairing_radius_mm,
              radial_segments: normalized.radial_segments,
              updated_at: normalized.fairing_updated_at,
              stored: true,
            }
          : null;
        const restoredGeometry = restoreSavedFairingGeometry(normalized);
        geometryRef.current = restoredGeometry;
        setGeometry(restoredGeometry);
        setSaved({ fairing: restoredFairing, satellites: normalized.satellites });
        if (restoredGeometry) {
          setFairingState({ state: 'ready', message: '' });
          showGeometryPreview(restoredGeometry, normalized.radial_segments);
        }
        setSatelliteCounts(Object.fromEntries(
          normalized.satellites.map((item) => [item.recordId, String(item.count)]),
        ));
        setLoadState('ready');
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setLoadState('error');
        showToast(`前置配置读取失败：${error.message}`, true);
      });
    return () => controller.abort();
  }, []);

  /** 更新一个受控字段草稿，并写入会话缓存以便刷新后恢复。 */
  function updateField(field, value) {
    const nextDraft = { ...draftRef.current, [field]: value };
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    writeFairingDraft(nextDraft);
  }

  /** 更新单个受控输入中的一类卫星数量草稿。 */
  function updateSatelliteCount(recordId, value) {
    setSatelliteCounts((current) => ({ ...current, [recordId]: value }));
  }

  /** 按 Enter 时让数量输入框失焦，以复用统一的自动保存流程。 */
  function handleSatelliteCountKeyDown(event) {
    if (event.key === 'Enter') event.currentTarget.blur();
  }

  /** 切换构件表面边线，并同步工具栏按钮状态。 */
  function toggleTopologyEdges() {
    const visible = previewRef.current?.toggleTopologyEdges();
    if (typeof visible === 'boolean') setTopologyEdgesVisible(visible);
  }

  /** 在数量输入框失焦后保存对应卫星数量，并广播给其他功能页。 */
  async function submitSatelliteCount(recordId) {
    if (satelliteAction) return;
    let count;
    try {
      count = buildSatelliteCountPayload(satelliteCounts[recordId], draftRef.current.limits);
    } catch (error) {
      showToast(error.message, true);
      return;
    }
    satelliteControllerRef.current?.abort();
    const controller = new AbortController();
    satelliteControllerRef.current = controller;
    setSatelliteAction(recordId);
    try {
      const response = await saveSatelliteCount(recordId, count, controller.signal);
      if (!mountedRef.current || controller.signal.aborted) return;
      const satellite = response.satellite || null;
      setSaved((current) => ({
        ...current,
        satellites: current.satellites.map((item) => (
          item.recordId === recordId ? { ...item, count, updatedAt: satellite?.updated_at ?? item.updatedAt } : item
        )),
      }));
      updateSatelliteCount(recordId, String(satellite?.count ?? count));
      window.dispatchEvent(new CustomEvent(SATELLITE_COUNT_EVENT, {
        detail: { recordId, value: satellite?.count ?? count },
      }));
      showToast(`${satellite?.device_name || '卫星类型'} 数量已保存 · ${satellite?.count ?? count} 颗`);
    } catch (error) {
      if (error.name !== 'AbortError' && mountedRef.current) showToast(`卫星数量保存失败：${error.message}`, true);
    } finally {
      if (mountedRef.current) setSatelliteAction(null);
    }
  }

  /** 保存整流舱段尺寸区间与整流罩半径，并按最小值构建构件和刷新预览。 */
  async function submitFairingSegment() {
    if (fairingAction) return;
    let payload;
    try {
      payload = buildFairingSegmentPayload(draftRef.current, draftRef.current.limits);
    } catch (error) {
      showToast(error.message, true);
      return;
    }
    fairingControllerRef.current?.abort();
    const controller = new AbortController();
    fairingControllerRef.current = controller;
    setFairingAction('building');
    setFairingState({ state: 'building', message: '' });
    try {
      const response = await saveCustomFairingSegment(
        payload.minRadiusMm,
        payload.maxRadiusMm,
        payload.minHeightMm,
        payload.maxHeightMm,
        payload.axisRadiusMm,
        payload.fairingRadiusMm,
        controller.signal,
      );
      if (!mountedRef.current || controller.signal.aborted) return;
      applyGeneratedSegment(response, payload.fairingRadiusMm);
      // 保存成功后草稿与后端参数一致，清除会话缓存。
      clearFairingDraft();
      showToast(
        `整流舱段已生成 · 半径 ${payload.minRadiusMm}–${payload.maxRadiusMm} mm · `
        + `高度 ${payload.minHeightMm}–${payload.maxHeightMm} mm · `
        + `中轴 ${payload.axisRadiusMm} mm · 整流罩半径 ${payload.fairingRadiusMm} mm`,
      );
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (!mountedRef.current) return;
      setFairingState({ state: 'error', message: error.message });
      showToast(`整流舱段生成失败：${error.message}`, true);
    } finally {
      if (mountedRef.current) setFairingAction(null);
    }
  }

  /**
   * 把后端返回的构件描述写入状态并刷新三维预览。
   * @param {object} response 后端构建响应。
   * @param {number} fairingRadiusMm 本次请求使用的整流罩半径。
   */
  function applyGeneratedSegment(response, fairingRadiusMm) {
    const responseGeometry = response?.geometry || null;
    if (!responseGeometry) {
      setFairingState({ state: 'error', message: '后端未返回构件描述' });
      return;
    }
    const geometryFairingRadius = Number(responseGeometry.fairing_radius_mm);
    const nextGeometry = {
      ...responseGeometry,
      fairing_radius_mm: Number.isFinite(geometryFairingRadius) && geometryFairingRadius > 0
        ? geometryFairingRadius : fairingRadiusMm,
    };
    setSaved((current) => ({ ...current, fairing: response.fairing_segment || current.fairing }));
    geometryRef.current = nextGeometry;
    setGeometry(nextGeometry);
    setFairingState({ state: 'ready', message: '' });
    showGeometryPreview(nextGeometry);
  }

  /**
   * 把构件摘要同步到已初始化的 Three.js 控制器；控制器尚未就绪时由初始化回调补画。
   * @param {object|null} nextGeometry 待显示的整流舱段几何摘要。
   * @param {number} [radialSegments] 圆周分段数，缺省使用当前配置。
   */
  function showGeometryPreview(nextGeometry, radialSegments = draftRef.current.radial_segments) {
    if (!nextGeometry) return;
    previewRef.current?.show({
      radius: nextGeometry.radius_mm,
      height: nextGeometry.height_mm,
      axisRadius: Number(nextGeometry.axis_radius_mm) || 0,
      fairingRadius: Number(nextGeometry.fairing_radius_mm) || 0,
      radialSegments,
    });
  }

  const busy = fairingAction !== null;
  const satellites = saved.satellites;
  const connectionStatus = loadState === 'loading'
    ? '连接检查中'
    : loadState === 'error' ? '配置读取失败' : '系统就绪';

  return (
    <AppShell className="model-page-shell pre-config-page-shell" pageTitle="前置配置" status={connectionStatus} statusId="pre-config-connection">
      <main className="model-workspace pre-config-workspace">
        <aside className="model-sidebar pre-config-sidebar" aria-label="前置配置">
          <div className="model-settings-sidebar-body">
            <div className="model-settings-form" aria-label="前置配置表单">
              <section className="model-settings-form-section" aria-labelledby="satellite-count-title">
                <div className="model-settings-section-heading">
                  <h2 id="satellite-count-title">卫星数量</h2>
                </div>
                {loadState === 'loading' ? (
                  <p className="pre-config-hint">正在读取卫星类型</p>
                ) : satellites.length === 0 ? (
                  <p className="pre-config-hint">数据管理页还没有存储模型，请先固化卫星模型再设置数量</p>
                ) : (
                  <div className="pre-config-satellite-list">
                    {satellites.map((item) => (
                      <div key={item.recordId} className="pre-config-satellite-row">
                        <div className="pre-config-satellite-meta">
                          <strong title={item.deviceName}>{item.deviceName}</strong>
                          <small>
                            {item.updatedAt ? `上次保存 ${formatTimestamp(item.updatedAt)}` : '尚未设置数量'}
                          </small>
                        </div>
                        <div className="pre-config-satellite-control">
                          <input
                            type="number"
                            min={draft.limits.min_satellite_count}
                            max={draft.limits.max_satellite_count}
                            step="1"
                            aria-label={`${item.deviceName} 的卫星数量`}
                            value={satelliteCounts[item.recordId] ?? '0'}
                            disabled={loadState !== 'ready' || satelliteAction !== null}
                            onChange={(event) => updateSatelliteCount(item.recordId, event.target.value)}
                            onBlur={() => submitSatelliteCount(item.recordId)}
                            onKeyDown={handleSatelliteCountKeyDown}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <p className="pre-config-hint">
                  卫星类型来自数据管理页的固化记录，共 {satellites.length} 类。
                </p>
              </section>

              <section className="model-settings-form-section" aria-labelledby="custom-fairing-title">
                <div className="model-settings-section-heading">
                  <h2 id="custom-fairing-title">自定义整流舱段</h2>
                </div>
                <div className="model-settings-field-grid pre-config-fairing-fields">
                  <label className="model-settings-field" htmlFor="fairing-min-radius">
                    <span>安装筒半径最小值 <small>mm</small></span>
                    <input
                      id="fairing-min-radius"
                      type="number"
                      min={draft.limits.min_fairing_radius_mm}
                      max={draft.limits.max_fairing_size_mm}
                      step="any"
                      value={draft.min_radius_mm}
                      disabled={loadState !== 'ready' || busy}
                      placeholder="请输入最小半径"
                      onChange={(event) => updateField('min_radius_mm', event.target.value)}
                    />
                  </label>
                  <label className="model-settings-field" htmlFor="fairing-max-radius">
                    <span>安装筒半径最大值 <small>mm</small></span>
                    <input
                      id="fairing-max-radius"
                      type="number"
                      min={draft.limits.min_fairing_radius_mm}
                      max={draft.limits.max_fairing_size_mm}
                      step="any"
                      value={draft.max_radius_mm}
                      disabled={loadState !== 'ready' || busy}
                      placeholder="请输入最大半径"
                      onChange={(event) => updateField('max_radius_mm', event.target.value)}
                    />
                  </label>
                  <label className="model-settings-field" htmlFor="fairing-min-height">
                    <span>直筒高度最小值 <small>mm</small></span>
                    <input
                      id="fairing-min-height"
                      type="number"
                      min={draft.limits.min_fairing_height_mm}
                      max={draft.limits.max_fairing_size_mm}
                      step="any"
                      value={draft.min_height_mm}
                      disabled={loadState !== 'ready' || busy}
                      placeholder="请输入最小高度"
                      onChange={(event) => updateField('min_height_mm', event.target.value)}
                    />
                  </label>
                  <label className="model-settings-field" htmlFor="fairing-max-height">
                    <span>直筒高度最大值 <small>mm</small></span>
                    <input
                      id="fairing-max-height"
                      type="number"
                      min={draft.limits.min_fairing_height_mm}
                      max={draft.limits.max_fairing_size_mm}
                      step="any"
                      value={draft.max_height_mm}
                      disabled={loadState !== 'ready' || busy}
                      placeholder="请输入最大高度"
                      onChange={(event) => updateField('max_height_mm', event.target.value)}
                    />
                  </label>
                  <label className="model-settings-field" htmlFor="fairing-axis-radius">
                    <span>中轴半径 <small>mm</small></span>
                    <input
                      id="fairing-axis-radius"
                      type="number"
                      min={draft.limits.min_axis_radius_mm}
                      max={draft.limits.max_fairing_size_mm}
                      step="any"
                      value={draft.axis_radius_mm}
                      disabled={loadState !== 'ready' || busy}
                      placeholder="请输入中轴半径"
                      onChange={(event) => updateField('axis_radius_mm', event.target.value)}
                    />
                  </label>
                  <label
                    className="model-settings-field pre-config-fairing-radius-field"
                    htmlFor="fairing-shell-radius"
                  >
                    <span>整流罩半径 <small>mm</small></span>
                    <input
                      id="fairing-shell-radius"
                      type="number"
                      min={draft.limits.min_fairing_shell_radius_mm}
                      max={draft.limits.max_fairing_size_mm}
                      step="any"
                      value={draft.fairing_radius_mm}
                      disabled={loadState !== 'ready' || busy}
                      placeholder="请输入整流罩半径"
                      onChange={(event) => updateField('fairing_radius_mm', event.target.value)}
                    />
                  </label>
                </div>
                <div className="pre-config-action-row">
                  <button
                    className="pre-config-action-button primary"
                    type="button"
                    disabled={loadState !== 'ready' || busy}
                    onClick={submitFairingSegment}
                  >
                    {fairingAction === 'building' ? <LoaderCircle className="spinning" aria-hidden="true" /> : <Box aria-hidden="true" />}
                    <span>{fairingAction === 'building' ? '正在构建' : '生成整流舱段'}</span>
                  </button>
                </div>
                {(fairingState.state === 'building' || fairingState.state === 'error' || !geometry) && (
                  <p className={`pre-config-hint${fairingState.state === 'error' ? ' error' : ''}`} aria-live="polite">
                    {fairingState.state === 'building'
                      ? '正在以 B-Rep 方式构建构件并导出 STEP'
                      : fairingState.state === 'error'
                        ? `构件构建失败：${fairingState.message}`
                        : '请先输入尺寸、中轴半径与整流罩半径并生成构件'}
                  </p>
                )}
                <p className="pre-config-hint">
                  {saved.fairing
                    ? `已保存 · 半径 ${formatMillimeters(saved.fairing.min_radius_mm)}–${formatMillimeters(saved.fairing.max_radius_mm)} · 高度 ${formatMillimeters(saved.fairing.min_height_mm)}–${formatMillimeters(saved.fairing.max_height_mm)} · 整流罩半径 ${formatMillimeters(saved.fairing.fairing_radius_mm)} · ${formatTimestamp(saved.fairing.updated_at)}`
                    : '尚未保存构件参数；生成时会一并保存'}
                </p>
              </section>
            </div>
          </div>
        </aside>

        <section className="model-preview-panel" aria-labelledby="pre-config-preview-title">
          <header className="preview-header">
            <div className="preview-title-group">
              <p className="eyebrow">构件预览</p>
              <div className="preview-name-row">
                <h2 id="pre-config-preview-title">{geometry ? '自定义整流舱段' : '尚未生成构件'}</h2>
                <span>B-Rep</span>
              </div>
            </div>
            <div className="preview-actions">
              <span className={`status-badge ${geometry ? 'ready' : 'busy'}`}>
                <b />
                {geometry ? '已生成' : fairingAction ? '构建中' : '等待生成'}
              </span>
              <button
                className={`icon-button${topologyEdgesVisible ? ' active' : ''}`}
                type="button"
                title="切换表面边线"
                aria-label="切换表面边线"
                aria-pressed={topologyEdgesVisible}
                disabled={!geometry}
                onClick={toggleTopologyEdges}
              >
                <GitBranch />
              </button>
              <button
                className="icon-button"
                type="button"
                title="适配构件视图"
                aria-label="适配构件视图"
                disabled={!geometry}
                onClick={() => previewRef.current?.fitView()}
              >
                <Maximize />
              </button>
            </div>
          </header>

          <div id="pre-config-viewport-wrap" className="model-viewport-wrap">
            <div ref={viewportRef} className="model-viewport" aria-label="自定义整流舱段三维预览画布" />
            <div ref={orientationGizmoRef} className="orientation-gizmo" aria-label="构件预览方向立方体" />
            {!geometry && (
              <div className="preview-empty">
                <span><Box /></span>
                <strong>构件预览</strong>
                <small>输入底面半径与高度区间后，按最小值生成 B-Rep 整流舱段</small>
              </div>
            )}
            <div className="viewport-badge viewport-badge-right">
              <span className="axis-dot x" />X <span className="axis-dot y" />Y <span className="axis-dot z" />Z
            </div>
          </div>

          <div className="preview-detail-band">
            <div className="model-stats" aria-live="polite">
              <div><small>预览底面直径（最小值）</small><strong>{geometry ? formatMillimeters(geometry.diameter_mm) : '--'}</strong></div>
              <div><small>预览高度（最小值）</small><strong>{geometry ? formatMillimeters(geometry.height_mm) : '--'}</strong></div>
              <div><small>体积</small><strong>{geometry ? formatVolume(geometry.volume_mm3) : '--'}</strong></div>
              <div><small>中轴半径</small><strong>{geometry ? formatMillimeters(geometry.axis_radius_mm) : '--'}</strong></div>
              <div><small>整流罩半径</small><strong>{geometry ? formatMillimeters(geometry.fairing_radius_mm) : '--'}</strong></div>
              <div><small>中轴方向</small><strong>{geometry ? formatAxisDirection(geometry.axis?.direction) : '--'}</strong></div>
            </div>
          </div>
        </section>
      </main>
      <div id="toast" className="toast" role="status" aria-live="polite" hidden />
    </AppShell>
  );
}
