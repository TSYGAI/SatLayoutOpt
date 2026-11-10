/**
 * 文件说明：前置配置页展示整流罩形态、安装筒及基座设置，表单共用相接半径并直接提交统一请求。
 * 关系约束仅显示已保存数量大于零的类型；数量、软硬对称和几何参数经 API 持久化。
 * 数量区底部支持全部清零，复用单类保存接口并按实际成功结果同步数量及关系约束。
 * 草稿、数量和预览保留于会话；右侧位姿浮窗由固定约束单一状态经Portal展示，STEP用于后续布局。
 * 读取、保存和预览异常统一转换为中文展示；本地校验和生成请求失败同步替换本次行内提示及提示条。
 */

import { useEffect, useRef, useState } from 'react';
import { formatParameterNumber } from '../utils/number-format.js';
import { Box, GitBranch, LoaderCircle, Maximize } from '../components/icons.js';

import { AppShell } from '../app/AppShell.jsx';
import { usePageSessionState } from '../app/page-session-state.js';
import {
  getPreConfig,
  saveCustomFairingSegment,
  saveSatelliteCount,
} from '../api/pre-config-api.js';
import { showToast } from '../components/toast.js';
import { formatPreConfigError } from './pre-config/pre-config-errors.js';
import { SettingsSelect } from '../components/SettingsSelect.jsx';
import { PreConfigSidebar } from './pre-config/PreConfigSidebar.jsx';
import { FairingShapeFields } from './pre-config/FairingShapeFields.jsx';
import { InstallationTubeFields } from './pre-config/InstallationTubeFields.jsx';
import { RelationConstraintsPanel } from './pre-config/RelationConstraintsPanel.jsx';
import { FixedConstraintsPanel } from './pre-config/FixedConstraintsPanel.jsx';
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
  FAIRING_FORM_OPTIONS,
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
  centroid_max_offset_mm: '',
  base_lower_radius_mm: '',
  base_height_mm: '',
  fairing_form: 'cylinder',
  fairing_cylinder_radius_mm: '',
  fairing_cylinder_height_mm: '',
  lower_cone_lower_radius_mm: '',
  lower_cone_height_mm: '',
  upper_cone_upper_radius_mm: '',
  upper_cone_height_mm: '',
  radial_segments: 96,
  limits: EMPTY_LIMITS,
});
const EMPTY_SAVED = Object.freeze({ fairing: null, satellites: Object.freeze([]) });
/** 渲染前置配置页面。 */
export function PreConfigPage() {
  const [draft, setDraft] = usePageSessionState('pre-config', 'draft', { ...EMPTY_DRAFT });
  const [saved, setSaved] = usePageSessionState('pre-config', 'saved', { ...EMPTY_SAVED });
  const [satelliteCounts, setSatelliteCounts] = usePageSessionState('pre-config', 'satelliteCounts', {});
  const [satelliteAction, setSatelliteAction] = useState(null);
  const [satelliteResetDone, setSatelliteResetDone] = useState(false);
  const [geometry, setGeometry] = usePageSessionState('pre-config', 'geometry', null);
  const [loadState, setLoadState] = usePageSessionState('pre-config', 'loadState', 'loading');
  const [fairingAction, setFairingAction] = useState(null);
  const [activeSection, setActiveSection] = useState('model-settings');
  const [previewReady, setPreviewReady] = useState(false);
  const [poseContainer, setPoseContainer] = useState(null);
  const [fairingState, setFairingState] = useState({ state: 'idle', message: '' });
  const [topologyEdgesVisible, setTopologyEdgesVisible] = usePageSessionState('pre-config', 'edges', true);
  const viewportRef = useRef(null);
  const orientationGizmoRef = useRef(null);
  const previewRef = useRef(null);
  const fixedNavigationRef = useRef(null);
  const geometryRef = useRef(geometry);
  const mountedRef = useRef(true);
  const draftRef = useRef(draft);
  const satelliteControllerRef = useRef(null);
  const satelliteResetButtonRef = useRef(null);
  const pendingSatelliteCountRef = useRef(null);
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
          sessionKey: 'pre-config', edgesVisible: topologyEdgesVisible,
        });
        showGeometryPreview(geometryRef.current);
        setPreviewReady(true);
        if (import.meta.env.DEV) {
          window.__preConfigPreviewTestApi = {
            /** 返回当前整流舱段的世界包围盒，供浏览器验收断言其位于 z ≥ 0 的上半空间。 */
            getCylinderWorldBounds: () => previewRef.current?.getCylinderWorldBounds() ?? null,
            /** 返回整流罩外形的最大半径，供浏览器验收核对预览参数。 */
            getFairingInnerRadius: () => previewRef.current?.getFairingInnerRadius() ?? null,
            /** 返回整流罩与安装筒的独立实体边界，供浏览器回归检查参数归属。 */
            getGeometrySnapshot: () => previewRef.current?.getGeometrySnapshot() ?? [],
            /** 返回相机、旋转中心、投影平移与边线状态，供浏览器回归测试验证统一交互。 */
            getInteractionSnapshot: () => previewRef.current?.getInteractionSnapshot() ?? null,
            /** 把世界毫米点投影到浏览器坐标，测试只读取当前预览相机，不修改模型。 */
            projectWorldPoint: (point) => previewRef.current?.projectWorldPoint(point) ?? null,
          };
        }
      })
      .catch((error) => {
        if (!disposed) setFairingState({ state: 'error', message: `三维预览初始化失败：${formatPreConfigError(error, '预览加载失败，请刷新页面后重试。')}` });
      });
    return () => {
      disposed = true;
      if (import.meta.env.DEV) delete window.__preConfigPreviewTestApi;
      previewRef.current?.dispose();
      previewRef.current = null;
    };
  }, []);

  /** 离开固定约束后恢复舱体预览，避免卫星拾取影响其他配置分组。 */
  useEffect(() => {
    if (activeSection !== 'fixed-constraints' && previewReady) {
      previewRef.current?.setFixedInteraction(null, null);
      showGeometryPreview(geometryRef.current);
    }
  }, [activeSection, previewReady]);

  /** 读取前置配置：按类型的卫星数量与整流舱段参数。 */
  useEffect(() => {
    const controller = new AbortController();
    const hasSession = loadState === 'ready';
    if (!hasSession) setLoadState('loading');
    getPreConfig(controller.signal)
      .then((config) => {
        if (controller.signal.aborted) return;
        const normalized = normalizePreConfig(config);
        // 页面草稿优先使用本次会话未保存的输入，其次才是后端参数。
        const sessionDraft = readFairingDraft();
        const savedSegments = normalized.fairing_profile?.segments || [];
        const savedLowerCone = savedSegments.find((item) => item.kind === 'lower_cone');
        const savedUpperCone = savedSegments.find((item) => item.kind === 'upper_cone');
        const nextDraft = {
          min_radius_mm: sessionDraft?.min_radius_mm ?? String(normalized.min_radius_mm),
          max_radius_mm: sessionDraft?.max_radius_mm ?? String(normalized.max_radius_mm),
          min_height_mm: sessionDraft?.min_height_mm ?? String(normalized.min_height_mm),
          max_height_mm: sessionDraft?.max_height_mm ?? String(normalized.max_height_mm),
          centroid_max_offset_mm: sessionDraft?.centroid_max_offset_mm ?? String(normalized.centroid_max_offset_mm),
          base_lower_radius_mm: sessionDraft?.base_lower_radius_mm ?? String(normalized.base_lower_radius_mm),
          base_height_mm: sessionDraft?.base_height_mm ?? String(normalized.base_height_mm),
          fairing_form: sessionDraft?.fairing_form || normalized.fairing_form,
          fairing_cylinder_radius_mm: sessionDraft?.fairing_cylinder_radius_mm
            ?? String(normalized.fairing_cylinder_radius_mm),
          fairing_cylinder_height_mm: sessionDraft?.fairing_cylinder_height_mm
            ?? String(normalized.fairing_cylinder_height_mm),
          lower_cone_lower_radius_mm: sessionDraft?.lower_cone_lower_radius_mm
            ?? (savedLowerCone ? String(savedLowerCone.lower_radius_mm) : ''),
          lower_cone_height_mm: sessionDraft?.lower_cone_height_mm
            ?? (savedLowerCone ? String(savedLowerCone.height_mm) : ''),
          upper_cone_upper_radius_mm: sessionDraft?.upper_cone_upper_radius_mm
            ?? (savedUpperCone ? String(savedUpperCone.upper_radius_mm) : ''),
          upper_cone_height_mm: sessionDraft?.upper_cone_height_mm
            ?? (savedUpperCone ? String(savedUpperCone.height_mm) : ''),
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
              centroid_max_offset_mm: normalized.centroid_max_offset_mm,
              fairing_radius_mm: normalized.fairing_radius_mm,
              fairing_form: normalized.fairing_form,
              fairing_profile: normalized.fairing_profile,
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
        setSatelliteCounts((current) => Object.fromEntries(normalized.satellites.map((item) => {
          const previous = saved.satellites.find((entry) => entry.recordId === item.recordId);
          const dirty = Object.hasOwn(current, item.recordId) && current[item.recordId] !== String(previous?.count ?? item.count);
          return [item.recordId, dirty ? current[item.recordId] : String(item.count)];
        })));
        setLoadState('ready');
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (!hasSession) setLoadState('error');
        showToast(`前置配置读取失败：${formatPreConfigError(error, '配置读取失败，请刷新页面后重试。')}`, true);
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
    setSatelliteResetDone(false);
    setSatelliteCounts((current) => ({ ...current, [recordId]: value }));
  }

  /**
   * 输入框转向清零按钮时暂存待保存类型，避免失焦保存抢先禁用按钮；其他失焦仍自动保存。
   * @param {object} event React 失焦事件，通过后续焦点识别清零操作。
   * @param {string} recordId 当前数量草稿所属的固化记录标识。
   */
  function handleSatelliteCountBlur(event, recordId) {
    if (event.relatedTarget === satelliteResetButtonRef.current) {
      pendingSatelliteCountRef.current = recordId;
      return;
    }
    void submitSatelliteCount(recordId);
  }

  /** 焦点离开清零按钮但未执行清零时，补存输入草稿，保持键盘导航的自动保存行为。 */
  function handleSatelliteResetBlur() {
    const recordId = pendingSatelliteCountRef.current;
    pendingSatelliteCountRef.current = null;
    if (recordId) void submitSatelliteCount(recordId);
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

  /**
   * 合并服务端确认的单类数量、保存时间和输入值，并向其他功能页广播该类的新数量。
   * @param {string} recordId 本次保存的固化记录标识。
   * @param {number} count 已提交的数量，在响应未携带数量时使用。
   * @param {object} [satellite] 服务端返回的卫星记录，包含确认数量及保存时间。
   */
  function applySavedSatelliteCount(recordId, count, satellite) {
    const savedCount = satellite?.count ?? count;
    setSaved((current) => ({
      ...current,
      satellites: current.satellites.map((item) => (
        item.recordId === recordId ? { ...item, count: savedCount, updatedAt: satellite?.updated_at ?? item.updatedAt } : item
      )),
    }));
    updateSatelliteCount(recordId, String(savedCount));
    window.dispatchEvent(new CustomEvent(SATELLITE_COUNT_EVENT, {
      detail: { recordId, value: savedCount },
    }));
  }

  /** 在数量输入框失焦后保存对应卫星数量，并广播给其他功能页。 */
  async function submitSatelliteCount(recordId) {
    if (satelliteAction) return;
    let count;
    try {
      count = buildSatelliteCountPayload(satelliteCounts[recordId], draftRef.current.limits);
    } catch (error) {
      showToast(formatPreConfigError(error), true);
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
      applySavedSatelliteCount(recordId, count, satellite);
      showToast(`${satellite?.device_name || '卫星类型'} 数量已保存 · ${satellite?.count ?? count} 颗`);
    } catch (error) {
      if (error.name !== 'AbortError' && mountedRef.current) showToast(`卫星数量保存失败：${formatPreConfigError(error)}`, true);
    } finally {
      if (mountedRef.current) setSatelliteAction(null);
    }
  }

  /**
   * 将所有非零数量及未保存草稿逐类保存为零；失败项保留原值，成功项立即同步，离页时取消后续请求。
   * @returns {Promise<void>} 请求完成后更新按钮及汇总提示；校验和保存错误在页面内处理。
   */
  async function resetSatelliteCounts() {
    if (loadState !== 'ready' || satelliteAction || saved.satellites.length === 0) return;
    pendingSatelliteCountRef.current = null;
    let count;
    try {
      count = buildSatelliteCountPayload('0', draftRef.current.limits);
    } catch (error) {
      showToast(`卫星数量清零失败：${formatPreConfigError(error)}`, true);
      return;
    }
    const targets = saved.satellites.filter((item) => (
      item.count !== 0 || (satelliteCounts[item.recordId] ?? '0') !== '0'
    ));
    satelliteControllerRef.current?.abort();
    const controller = new AbortController();
    satelliteControllerRef.current = controller;
    setSatelliteAction('reset-all');
    setSatelliteResetDone(false);
    const failures = [];
    try {
      for (const item of targets) {
        if (!mountedRef.current || controller.signal.aborted) return;
        try {
          const response = await saveSatelliteCount(item.recordId, count, controller.signal);
          if (!mountedRef.current || controller.signal.aborted) return;
          applySavedSatelliteCount(item.recordId, count, response.satellite);
        } catch (error) {
          if (!mountedRef.current || controller.signal.aborted) return;
          failures.push({ name: item.deviceName, error });
        }
      }
      if (failures.length) {
        showToast(`卫星数量清零未全部完成：${failures.length} 类保存失败，其他类型已清零；`
          + `${failures[0].name}：${formatPreConfigError(failures[0].error)}。请重试。`, true);
      } else {
        setSatelliteResetDone(true);
        showToast(`已将全部 ${saved.satellites.length} 类卫星数量清零`);
      }
    } finally {
      if (mountedRef.current) setSatelliteAction(null);
    }
  }

  /** 校验并保存罩体与安装筒参数；统一处理本地及请求错误，提示同步到本次生成，失败保留草稿和已有预览。 */
  async function submitFairingSegment() {
    if (fairingAction) return;
    fairingControllerRef.current?.abort();
    const controller = new AbortController();
    fairingControllerRef.current = controller;
    try {
      const payload = buildFairingSegmentPayload(draftRef.current, draftRef.current.limits);
      setFairingAction('building');
      setFairingState({ state: 'building', message: '' });
      const response = await saveCustomFairingSegment(payload, controller.signal);
      if (!mountedRef.current || controller.signal.aborted) return;
      applyGeneratedSegment(response);
      // 保存成功后草稿与后端参数一致，清除会话缓存。
      clearFairingDraft();
      const tube = payload.installation_tube;
      showToast(
        `整流舱段已生成 · 半径 ${formatParameterNumber(tube.min_radius_mm)}–${formatParameterNumber(tube.max_radius_mm)} mm · `
        + `高度 ${formatParameterNumber(tube.min_height_mm)}–${formatParameterNumber(tube.max_height_mm)} mm · `
        + `质心最大偏移 ${formatParameterNumber(tube.centroid_max_offset_mm)} mm`,
      );
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (!mountedRef.current) return;
      const message = formatPreConfigError(error, '构件生成失败，请检查参数后重新生成。');
      setFairingState({ state: 'error', message });
      showToast(`整流舱段生成失败：${message}`, true);
    } finally {
      if (mountedRef.current) setFairingAction(null);
    }
  }

  /**
   * 把后端返回的构件描述写入状态并刷新三维预览。
   * @param {object} response 后端构建响应。
   */
  function applyGeneratedSegment(response) {
    const nextGeometry = response?.geometry;
    if (!nextGeometry) {
      setFairingState({ state: 'error', message: '后端未返回构件描述' });
      return;
    }
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
      installationRadius: nextGeometry.installation_tube?.min_radius_mm ?? nextGeometry.radius_mm,
      installationHeight: nextGeometry.installation_tube?.min_height_mm ?? nextGeometry.height_mm,
      installationBase: nextGeometry.installation_tube?.base,
      axisRadius: Number(nextGeometry.centroid_max_offset_mm ?? nextGeometry.axis_radius_mm) || 0,
      fairingRadius: Number(nextGeometry.fairing_radius_mm) || 0,
      profile: nextGeometry.profile || nextGeometry.fairing_profile,
      radialSegments,
    });
  }

  /** 合并后端确认的类型对称开关和模式，保留数量和预览状态。 */
  function applySavedSymmetry(recordId, enabled, mode) {
    setSaved((current) => ({
      ...current,
      satellites: current.satellites.map((item) => (
        item.recordId === recordId ? { ...item, symmetryEnabled: enabled, symmetryMode: mode } : item
      )),
    }));
  }

  const busy = fairingAction !== null;
  const satellites = saved.satellites;
  const selectedSatellites = satellites.filter((item) => item.count > 0);
  const connectionStatus = loadState === 'loading'
    ? '连接检查中'
    : loadState === 'error' ? '配置读取失败' : '系统就绪';

  return (
    <AppShell className="model-page-shell pre-config-page-shell" pageTitle="前置配置" status={connectionStatus} statusId="pre-config-connection">
      <main className="model-workspace pre-config-workspace">
        <PreConfigSidebar navigationRef={fixedNavigationRef} relationConstraints={(
          <RelationConstraintsPanel satellites={selectedSatellites} loadState={loadState}
            disabled={satelliteAction !== null} onSaved={applySavedSymmetry} />
        )} onSectionChange={setActiveSection} fixedConstraints={(
          <FixedConstraintsPanel navigationRef={fixedNavigationRef} active={activeSection === 'fixed-constraints'} geometry={geometry}
            satellites={selectedSatellites} previewRef={previewRef} previewReady={previewReady} radialSegments={draft.radial_segments} poseContainer={poseContainer} />
        )}>
          <div className="model-settings-form" aria-label="前置配置表单">
            <section className="model-settings-form-section pre-config-satellite-section" aria-labelledby="satellite-count-title">
              <div className="model-settings-section-heading">
                <h2 id="satellite-count-title">卫星数量</h2>
              </div>
              {loadState === 'loading' ? (
                <p className="pre-config-hint">正在读取卫星类型</p>
              ) : satellites.length === 0 ? (
                <p className="pre-config-hint">数据管理页还没有存储模型，请先固化卫星模型再设置数量</p>
              ) : (
                <div className="pre-config-satellite-list" role="region" aria-label="卫星数量列表" tabIndex={0}>
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
                          onBlur={(event) => handleSatelliteCountBlur(event, item.recordId)}
                          onKeyDown={handleSatelliteCountKeyDown}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="pre-config-satellite-footer">
                <p className="pre-config-hint">
                  卫星类型来自数据管理页的固化记录，共 {satellites.length} 类。
                </p>
                <button
                  ref={satelliteResetButtonRef}
                  className={`pre-config-action-button pre-config-satellite-reset${satelliteResetDone ? ' is-complete' : ''}`}
                  type="button"
                  disabled={loadState !== 'ready' || satelliteAction !== null || satellites.length === 0}
                  aria-busy={satelliteAction === 'reset-all'}
                  onClick={resetSatelliteCounts}
                  onBlur={handleSatelliteResetBlur}
                >
                  {satelliteAction === 'reset-all' && <LoaderCircle className="spinning" aria-hidden="true" />}
                  <span aria-live="polite">{satelliteAction === 'reset-all' ? '正在清零' : satelliteResetDone ? '已全部清零' : '数量清零'}</span>
                </button>
              </div>
            </section>

            <section className="model-settings-form-section" aria-labelledby="custom-fairing-title">
              <div className="model-settings-section-heading">
                <h2 id="custom-fairing-title">整流罩形态设置</h2>
              </div>
              <div className="model-settings-field">
                <span>整流罩形态</span>
                <SettingsSelect
                  id="fairing-form"
                  label="整流罩形态"
                  value={draft.fairing_form}
                  options={FAIRING_FORM_OPTIONS}
                  disabled={loadState !== 'ready' || busy}
                  onChange={(value) => updateField('fairing_form', value)}
                />
              </div>
              <FairingShapeFields draft={draft} disabled={loadState !== 'ready' || busy} onChange={updateField} />
            </section>

            <section className="model-settings-form-section" aria-labelledby="installation-tube-title">
              <div className="model-settings-section-heading">
                <h2 id="installation-tube-title">安装筒设置</h2>
              </div>
              <InstallationTubeFields draft={draft} disabled={loadState !== 'ready' || busy} onChange={updateField} />
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
                      : '请分别填写整流罩各段尺寸与安装筒参数，再生成构件'}
                </p>
              )}
              <p className="pre-config-hint">
                {saved.fairing
                  ? `已保存 · 半径 ${formatMillimeters(saved.fairing.min_radius_mm)}–${formatMillimeters(saved.fairing.max_radius_mm)} · 高度 ${formatMillimeters(saved.fairing.min_height_mm)}–${formatMillimeters(saved.fairing.max_height_mm)} · ${formatTimestamp(saved.fairing.updated_at)}`
                  : '尚未保存构件参数；生成时会一并保存'}
              </p>
            </section>
          </div>
        </PreConfigSidebar>

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
            <div ref={setPoseContainer} className="fixed-pose-overlay" />
            {!geometry && (
              <div className="preview-empty">
                <span><Box /></span>
                <strong>构件预览</strong>
                <small>分别填写整流罩各段尺寸与安装筒区间后生成构件</small>
              </div>
            )}
            <div className="viewport-badge viewport-badge-right">
              <span className="axis-dot x" />X <span className="axis-dot y" />Y <span className="axis-dot z" />Z
            </div>
          </div>

          <div className="preview-detail-band">
            <div className="model-stats" aria-live="polite">
              <div><small>安装筒直径（最小值）</small><strong>{geometry ? formatMillimeters(geometry.diameter_mm) : '--'}</strong></div>
              <div><small>安装筒高度（最小值）</small><strong>{geometry ? formatMillimeters(geometry.height_mm) : '--'}</strong></div>
              {geometry?.installation_tube?.base && <div><small>安装筒与基座总高（最小值）</small>
                <strong>{formatMillimeters(geometry.height_mm + geometry.installation_tube.base.height_mm)}</strong></div>}
              <div><small>整流罩体积</small><strong>{geometry ? formatVolume(geometry.volume_mm3) : '--'}</strong></div>
              <div><small>质心最大偏移</small><strong>{geometry ? formatMillimeters(geometry.centroid_max_offset_mm ?? geometry.axis_radius_mm) : '--'}</strong></div>
              <div><small>整流罩总高度</small><strong>{geometry ? formatMillimeters((geometry.fairing_profile || geometry.profile)?.total_height_mm) : '--'}</strong></div>
            </div>
          </div>
        </section>
      </main>
      <div id="toast" className="toast" role="status" aria-live="polite" hidden />
    </AppShell>
  );
}
