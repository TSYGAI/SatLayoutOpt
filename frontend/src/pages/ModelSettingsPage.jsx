/**
 * 文件说明：卫星设置功能页，复用模型上传页的三维预览并提供独立的左侧设置栏边界。
 * 本页保存含曲面点击点、固定/自由向上轴的模型设置和六向包络增量，并通过 API 生成包络。
 */

import { useEffect, useRef, useState } from 'react';
import { Box, Boxes, ChevronDown, Crosshair, Database, LoaderCircle } from 'lucide-react';

import { AppShell } from '../app/AppShell.jsx';
import { ModelPreviewPanel } from '../components/ModelPreviewPanel.jsx';
import { SettingsSelect } from '../components/SettingsSelect.jsx';
import { showToast } from '../components/toast.js';
import {
  getBackgroundTaskPollingConfig,
  getLatestEnvelopeGenerationTask,
  getModelStorageState,
  saveModelSnapshot,
  startAllModelEnvelopeGeneration,
  startModelEnvelopeGeneration,
  updateModelSettings,
} from '../api/model-upload-api.js';
import {
  applyCurrentModelPreviewSettings,
  mountModelSettingsPage,
  setInstallationFacePicking,
} from './model-upload/model-upload-page.js';
import {
  INSTALLATION_FACE_SELECTED_EVENT,
  INSTALLATION_PICKER_STATE_EVENT,
} from './model-settings/model-setting-preview-tools.js';
import {
  areModelSettingsEqual,
  buildModelSettingsPayload,
  MODEL_SETTINGS_SELECTION_EVENT,
  normalizeModelSettings,
  UP_ORIENTATIONS,
} from './model-settings/model-settings-state.js';
import '../../styles/model-upload.css';
import '../../styles/model-settings.css';
import { useModelEnvelopePreview } from './model-settings/use-model-envelope-preview.js';
import { ModelSafetyClearanceSection } from './model-settings/ModelSafetyClearanceSection.jsx';
import {
  getEnvelopeTaskAction,
  getEnvelopeTaskModelStatus,
} from './model-settings/model-envelope-task-state.js';

const EMPTY_SETTINGS = Object.freeze(normalizeModelSettings());
const EMPTY_STORE_STATE = Object.freeze({ loading: false, record: null, record_count: 0 });
const UNIT_OPTIONS = Object.freeze([{ value: 'mm', label: 'mm' }, { value: 'cm', label: 'cm' }, { value: 'm', label: 'm' }]);
const ROTATION_OPTIONS = Object.freeze([0, 90, 180, 270].map((value) => ({ value, label: `${value}°` })));
const UP_ORIENTATION_OPTIONS = Object.freeze(UP_ORIENTATIONS.map((value) => ({ value, label: value === 'free' ? '自由' : value })));

/** 把 UTC ISO-8601 时间戳格式化为本地可读时间，无效输入返回占位符。 */
function formatStoreTimestamp(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString('zh-CN', { hour12: false });
}

/** 格式化安装面的变换后面积和当前模型单位。 */
function formatInstallationArea(face, settings) {
  const area = Number(face?.area);
  const scale = Number(settings.model_scale);
  if (!Number.isFinite(area) || !Number.isFinite(scale)) return '--';
  const transformedArea = area * scale * scale;
  const text = transformedArea === 0
    ? '0'
    : transformedArea.toLocaleString('zh-CN', { maximumSignificantDigits: 6 });
  return `${text} ${settings.model_unit}²`;
}

/** 将 STEP 几何类型转换为安装摘要中的中文名称，未知类型保留原始标识便于排障。 */
function formatInstallationSurfaceType(value) {
  const labels = { PLANE: '平面', CYLINDER: '圆柱面', CONE: '圆锥面', SPHERE: '球面', TORUS: '环面', BSPLINE: '自由曲面' };
  return labels[value] || value || '曲面';
}

/** 渲染卫星设置页面。 */
export function ModelSettingsPage() {
  const [selectedModel, setSelectedModel] = useState(null);
  const [settings, setSettings] = useState({ ...EMPTY_SETTINGS });
  const [savedSettings, setSavedSettings] = useState(null);
  const [pickerState, setPickerState] = useState({ status: 'unavailable', message: '等待高清预览与 STEP 面映射', invalidSelection: false });
  const [installationFace, setInstallationFace] = useState(null);
  const [envelopeState, setEnvelopeState] = useState({ state: 'pending' });
  const [envelopeAction, setEnvelopeAction] = useState(null);
  const [storeState, setStoreState] = useState({ ...EMPTY_STORE_STATE });
  const [storeAction, setStoreAction] = useState(null);
  const saveControllerRef = useRef(null);
  const storeControllerRef = useRef(null);
  const envelopeTaskRef = useRef(null);
  const envelopeTaskRefreshRef = useRef(null);
  const envelopeTaskNoticeRef = useRef(null);
  const mountedRef = useRef(true);
  const saveQueueRef = useRef(Promise.resolve());
  const saveVersionRef = useRef(0);
  const envelopeStatusesRef = useRef(new Map());
  const selectedModelRef = useRef(null);
  const savedSettingsRef = useRef(null);
  const selectedModelIdRef = useRef(null);
  const latestSettingsRef = useRef({ ...EMPTY_SETTINGS });
  const envelopePreview = useModelEnvelopePreview({
    modelId: selectedModel?.id, envelope: envelopeState, settings,
    hasDraft: !savedSettings || !areModelSettingsEqual(settings, savedSettings),
  });

  useEffect(() => {
    mountedRef.current = true;
    /** 接收预览控制器发出的当前模型及后端设置。 */
    function handleModelSelection(event) {
      saveControllerRef.current?.abort();
      saveControllerRef.current = null;
      saveVersionRef.current += 1;
      const model = event.detail?.model || null;
      const nextSettings = normalizeModelSettings(model?.settings);
      selectedModelRef.current = model;
      savedSettingsRef.current = model ? nextSettings : null;
      selectedModelIdRef.current = model?.id || null;
      latestSettingsRef.current = nextSettings;
      setSelectedModel(model);
      setSettings(nextSettings);
      setSavedSettings(model ? nextSettings : null);
      setInstallationFace(null);
      const task = envelopeTaskRef.current;
      setEnvelopeAction(getEnvelopeTaskAction(task));
      const taskStatus = getEnvelopeTaskModelStatus(task, model?.id);
      setEnvelopeState(taskStatus || envelopeStatusesRef.current.get(model?.id) || model?.derivatives?.envelope || { state: 'pending' });
      setPickerState({ status: 'unavailable', message: '等待高清预览与 STEP 面映射', invalidSelection: false });
    }

    /** 接收预览控制器的安装面拾取准备状态和当前面摘要。 */
    function handlePickerState(event) {
      const detail = event.detail || {};
      if (detail.modelId !== selectedModelIdRef.current) return;
      setPickerState({
        status: detail.status || 'unavailable',
        message: detail.message || '',
        invalidSelection: Boolean(detail.invalidSelection),
      });
      setInstallationFace(detail.selectedFace || null);
    }
    /** 把画布选中的 STEP 面及源坐标点击点写入当前模型草稿并立即保存。 */
    function handleInstallationFaceSelected(event) {
      const detail = event.detail || {};
      if (detail.modelId !== selectedModelIdRef.current || !detail.face?.step_face_id || !detail.point) return;
      const nextSettings = {
        ...latestSettingsRef.current,
        installation_face_id: detail.face.step_face_id,
        installation_point: detail.point,
      };
      latestSettingsRef.current = nextSettings;
      setSettings(nextSettings);
      setInstallationFace(detail.face);
      requestSave(nextSettings);
    }

    window.addEventListener(MODEL_SETTINGS_SELECTION_EVENT, handleModelSelection);
    window.addEventListener(INSTALLATION_PICKER_STATE_EVENT, handlePickerState);
    window.addEventListener(INSTALLATION_FACE_SELECTED_EVENT, handleInstallationFaceSelected);
    const unmountPreview = mountModelSettingsPage();
    return () => {
      saveControllerRef.current?.abort();
      mountedRef.current = false;
      saveVersionRef.current += 1;
      selectedModelRef.current = null;
      savedSettingsRef.current = null;
      window.removeEventListener(MODEL_SETTINGS_SELECTION_EVENT, handleModelSelection);
      window.removeEventListener(INSTALLATION_PICKER_STATE_EVENT, handlePickerState);
      window.removeEventListener(INSTALLATION_FACE_SELECTED_EVENT, handleInstallationFaceSelected);
      unmountPreview();
    };
  }, []);

  /** 把后端最新任务快照应用到当前页面，不影响正在执行的后端任务。 */
  function applyEnvelopeTask(task, { notify = false } = {}) {
    envelopeTaskRef.current = task;
    const action = getEnvelopeTaskAction(task);
    setEnvelopeAction(action);
    if (task?.state === 'running' && task.id) envelopeTaskNoticeRef.current = task.id;
    if (task?.state === 'succeeded' && task.kind === 'single' && task.model_id) {
      const completed = getEnvelopeTaskModelStatus(task, task.model_id);
      if (completed) envelopeStatusesRef.current.set(task.model_id, completed);
    }
    if (task?.state === 'succeeded' && task.kind === 'all') {
      task.result?.results?.forEach((item) => {
        const completed = getEnvelopeTaskModelStatus(task, item.id);
        if (completed) envelopeStatusesRef.current.set(item.id, completed);
      });
    }
    const currentModelId = selectedModelIdRef.current;
    const status = getEnvelopeTaskModelStatus(task, currentModelId)
      || envelopeStatusesRef.current.get(currentModelId);
    if (status) {
      setEnvelopeState(status);
      if (status.state === 'ready' && currentModelId) {
        envelopeStatusesRef.current.set(currentModelId, status);
        if (selectedModelRef.current?.derivatives) selectedModelRef.current.derivatives.envelope = status;
      }
    }
    if (notify && task?.state !== 'running' && task?.id && envelopeTaskNoticeRef.current === task.id) {
      envelopeTaskNoticeRef.current = `${task.id}:${task.state}`;
      if (task.state === 'succeeded' && task.kind === 'all' && task.result?.failed) {
        showToast(`包络后台任务已完成，${task.result.failed} 个模型失败`, true);
      } else if (task.state === 'succeeded') showToast('包络后台任务已完成');
      if (task.state === 'failed') showToast(`包络后台任务失败：${task.error}`, true);
    }
  }

  useEffect(() => {
    let disposed = false;
    let timer = null;
    let runningPollIntervalMs = 1000;
    let idlePollIntervalMs = 5000;
    /** 查询一次后端最新任务；组件卸载只停止查询，不发送取消请求。 */
    async function refreshEnvelopeTask() {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      let nextDelay = idlePollIntervalMs;
      try {
        const [task, polling] = await Promise.all([
          getLatestEnvelopeGenerationTask(),
          getBackgroundTaskPollingConfig(),
        ]);
        runningPollIntervalMs = polling.runningPollIntervalMs;
        idlePollIntervalMs = polling.idlePollIntervalMs;
        nextDelay = task?.state === 'running' ? runningPollIntervalMs : idlePollIntervalMs;
        if (!disposed && mountedRef.current) applyEnvelopeTask(task, { notify: true });
      } catch (error) {
        if (!disposed && error.name !== 'AbortError') showToast(`包络任务状态读取失败：${error.message}`, true);
      } finally {
        if (!disposed) timer = window.setTimeout(refreshEnvelopeTask, nextDelay);
      }
    }
    envelopeTaskRefreshRef.current = refreshEnvelopeTask;
    void refreshEnvelopeTask();
    return () => {
      disposed = true;
      envelopeTaskRefreshRef.current = null;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  /** 切换模型或包络生成完成后刷新该模型在固化数据库中的存储状态。 */
  useEffect(() => {
    const modelId = selectedModel?.id;
    storeControllerRef.current?.abort();
    storeControllerRef.current = null;
    if (!modelId) {
      setStoreState({ ...EMPTY_STORE_STATE });
      return undefined;
    }
    const controller = new AbortController();
    storeControllerRef.current = controller;
    setStoreState((current) => ({ ...current, loading: true }));
    getModelStorageState(modelId, controller.signal)
      .then((state) => {
        if (controller.signal.aborted || selectedModelIdRef.current !== modelId) return;
        setStoreState({ loading: false, record: state.latest || null, record_count: state.record_count || 0 });
      })
      .catch((error) => {
        if (controller.signal.aborted || error.name === 'AbortError') return;
        setStoreState({ loading: false, record: null, record_count: 0 });
      });
    return () => controller.abort();
  }, [selectedModel?.id, envelopeState.state, envelopeState.generated_at]);

  /** 在输入失焦或即时选择后串行保存当前完整设置，避免旧请求覆盖新草稿。 */
  function requestSave(nextSettings = latestSettingsRef.current, options = {}) {
    const model = selectedModelRef.current;
    if (!model) return Promise.resolve(false);
    let payload;
    try {
      payload = buildModelSettingsPayload(nextSettings);
    } catch (error) {
      if (!options.silentInvalid) showToast(error.message, true);
      return Promise.resolve(false);
    }
    const saved = savedSettingsRef.current;
    if (saved && areModelSettingsEqual(payload, saved)) return Promise.resolve(true);
    const savingModelId = model.id;
    const version = saveVersionRef.current + 1;
    saveVersionRef.current = version;
    saveControllerRef.current?.abort();
    saveQueueRef.current = saveQueueRef.current.catch(() => {}).then(async () => {
      if (selectedModelIdRef.current !== savingModelId || version !== saveVersionRef.current) return false;
      const controller = new AbortController();
      saveControllerRef.current = controller;
      try {
        const response = await updateModelSettings(savingModelId, payload, controller.signal);
        const saved = normalizeModelSettings(response.settings);
        if (controller.signal.aborted || selectedModelIdRef.current !== savingModelId
          || version !== saveVersionRef.current || !areModelSettingsEqual(latestSettingsRef.current, payload)) return false;
        latestSettingsRef.current = saved;
        setSettings(saved);
        setSavedSettings(saved);
        savedSettingsRef.current = saved;
        applyCurrentModelPreviewSettings(saved, { commit: true });
        if (response.envelope) {
          setEnvelopeState(response.envelope);
          envelopeStatusesRef.current.set(savingModelId, response.envelope);
          if (selectedModelRef.current?.derivatives) selectedModelRef.current.derivatives.envelope = response.envelope;
        }
        return true;
      } catch (error) {
        if (error.name !== 'AbortError') showToast(`自动保存失败：${error.message}`, true);
        return false;
      } finally {
        if (saveControllerRef.current === controller) saveControllerRef.current = null;
      }
    });
    return saveQueueRef.current;
  }

  useEffect(() => {
    if (selectedModel) applyCurrentModelPreviewSettings(settings);
  }, [
    selectedModel?.id,
    settings.model_scale,
    settings.model_unit,
    settings.rotation_x,
    settings.rotation_y,
    settings.rotation_z,
    settings.center_of_mass?.x,
    settings.center_of_mass?.y,
    settings.center_of_mass?.z,
    settings.installation_face_id,
    settings.installation_point?.x,
    settings.installation_point?.y,
    settings.installation_point?.z,
  ]);

  /** 更新一个受控字段；合法变换由副作用立即同步到预览。 */
  function updateField(field, value) {
    const nextSettings = { ...latestSettingsRef.current, [field]: value };
    latestSettingsRef.current = nextSettings;
    setSettings(nextSettings);
  }

  /** 更新单个方向的距离草稿，保留其余五向数值，保存由失焦事件触发。 */
  function updateSafetyClearance(direction, value) {
    updateField('safety_clearance_mm', { ...latestSettingsRef.current.safety_clearance_mm, [direction]: value });
  }

  /** 更新一个质心坐标，并在三轴全部清空时恢复未设置状态。 */
  function updateCenterOfMass(axis, value) {
    const nextCenter = { x: '', y: '', z: '', ...(latestSettingsRef.current.center_of_mass || {}), [axis]: value };
    const centerOfMass = Object.values(nextCenter).every((coordinate) => coordinate === '') ? null : nextCenter;
    const nextSettings = { ...latestSettingsRef.current, center_of_mass: centerOfMass };
    latestSettingsRef.current = nextSettings;
    setSettings(nextSettings);
  }

  /** 切换安装面拾取状态，首次开启时等待后台 BVH 构建完成。 */
  async function toggleInstallationPicking() {
    await setInstallationFacePicking(!['active', 'building'].includes(pickerState.status));
  }

  /** 清除安装面草稿并退出拾取状态。 */
  function clearInstallationFace() {
    void setInstallationFacePicking(false);
    setInstallationFace(null);
    const nextSettings = { ...latestSettingsRef.current, installation_face_id: null, installation_point: null };
    latestSettingsRef.current = nextSettings;
    setSettings(nextSettings);
    requestSave(nextSettings);
  }

  /** 保存当前草稿后生成所选模型唯一的 0 度基础正式包络。 */
  async function handleGenerateEnvelope() {
    const modelId = selectedModelIdRef.current;
    if (!modelId || envelopeAction) return;
    if (!await requestSave()) return;
    setEnvelopeAction('single');
    setEnvelopeState({ state: 'generating' });
    try {
      const task = await startModelEnvelopeGeneration(modelId);
      if (mountedRef.current) {
        applyEnvelopeTask(task);
        void envelopeTaskRefreshRef.current?.();
      }
    } catch (error) {
      if (!mountedRef.current) return;
      setEnvelopeAction(null);
      setEnvelopeState({ state: 'error', message: error.message });
      showToast(`包络生成失败：${error.message}`, true);
    }
  }

  /** 保存当前草稿后生成模型库全部包络，并同步所选模型的结果状态。 */
  async function handleGenerateAllEnvelopes() {
    if (envelopeAction || !selectedModelIdRef.current) return;
    if (!await requestSave()) return;
    setEnvelopeAction('all');
    setEnvelopeState({ state: 'generating-all' });
    try {
      const task = await startAllModelEnvelopeGeneration();
      if (mountedRef.current) {
        applyEnvelopeTask(task);
        void envelopeTaskRefreshRef.current?.();
      }
    } catch (error) {
      if (!mountedRef.current) return;
      setEnvelopeAction(null);
      setEnvelopeState({ state: 'error', message: error.message });
      showToast(`全部包络生成失败：${error.message}`, true);
    }
  }

  /** 保存当前草稿后，把模型、STEP 原件与正式包络固化到本地 SQLite 数据库。 */
  async function handleStoreModel() {
    const modelId = selectedModelIdRef.current;
    if (!modelId || storeAction || envelopeAction) return;
    if (!await requestSave()) return;
    setStoreAction('saving');
    try {
      const record = await saveModelSnapshot(modelId, latestSettingsRef.current.device_name);
      if (!mountedRef.current) return;
      setStoreState({ loading: false, record, record_count: (storeState.record_count || 0) + 1 });
      showToast(`已存储到数据库 · ${record.device_name} · 基础包络`);
    } catch (error) {
      if (mountedRef.current) showToast(`存储到数据库失败：${error.message}`, true);
    } finally {
      if (mountedRef.current) setStoreAction(null);
    }
  }

  return (
    <AppShell className="model-page-shell model-settings-page-shell" pageTitle="卫星设置" status="连接检查中" statusId="model-connection">
      <main className="model-workspace model-settings-workspace">
        <aside className="model-sidebar model-settings-sidebar" aria-label="卫星设置">
          <div className="model-settings-sidebar-body">
            <section className="model-settings-model-section" aria-labelledby="model-settings-model-title">
              <div className="section-heading">
                <div>
                  <p>预览对象</p>
                  <h2 id="model-settings-model-title">选择模型</h2>
                </div>
              </div>
              <div className="model-settings-select-field">
                <span id="model-settings-model-select-label">已上传模型</span>
                <span className="model-settings-select-control">
                  <button
                    id="model-settings-model-select"
                    className="model-settings-select-trigger"
                    type="button"
                    aria-labelledby="model-settings-model-select-label model-settings-model-select-value"
                    aria-haspopup="listbox"
                    aria-expanded="false"
                    aria-controls="model-settings-model-options"
                    disabled
                  >
                    <span aria-hidden="true" />
                    <span id="model-settings-model-select-value">正在读取模型库</span>
                    <ChevronDown aria-hidden="true" />
                  </button>
                  <div id="model-settings-model-options" className="model-settings-model-options" role="listbox" aria-label="已上传模型" hidden />
                </span>
              </div>
            </section>

            <div className="model-settings-form" aria-label="模型参数表单">
              <section className="model-settings-form-section" aria-labelledby="device-parameters-title">
                <div className="model-settings-section-heading">
                  <h2 id="device-parameters-title">设备参数</h2>
                </div>
                <div className="model-settings-field-grid">
                  <label className="model-settings-field" htmlFor="device-name">
                    <span>设备名称</span>
                    <input
                      id="device-name"
                      type="text"
                      value={settings.device_name}
                      maxLength="200"
                      required
                      disabled={!selectedModel}
                      placeholder="请输入设备名称"
                      onChange={(event) => updateField('device_name', event.target.value)}
                      onBlur={() => requestSave()}
                    />
                  </label>
                  <label className="model-settings-field" htmlFor="device-mass">
                    <span>质量 <small>kg</small></span>
                    <input
                      id="device-mass"
                      type="number"
                      min="0"
                      max="1000000000000"
                      step="any"
                      value={settings.mass}
                      disabled={!selectedModel}
                      placeholder="可选，不填则不提交质量"
                      onChange={(event) => updateField('mass', event.target.value)}
                      onBlur={() => requestSave()}
                    />
                  </label>
                </div>
              </section>

              <section className="model-settings-form-section" aria-labelledby="model-parameters-title">
                <div className="model-settings-section-heading">
                  <h2 id="model-parameters-title">模型设置</h2>
                </div>
                <div className="model-settings-field-grid">
                  <label className="model-settings-field" htmlFor="model-scale">
                    <span>模型比例</span>
                    <input
                      id="model-scale"
                      type="number"
                      min="0.0001"
                      max="1000000"
                      step="any"
                      value={settings.model_scale}
                      required
                      disabled={!selectedModel}
                      onChange={(event) => updateField('model_scale', event.target.value)}
                      onBlur={() => requestSave()}
                    />
                  </label>
                  <div className="model-settings-field">
                    <span>模型单位</span>
                    <SettingsSelect id="model-unit" label="模型单位" value={settings.model_unit} options={UNIT_OPTIONS} disabled={!selectedModel} onChange={(value) => { updateField('model_unit', value); requestSave({ ...latestSettingsRef.current, model_unit: value }); }} />
                  </div>
                  <div className="model-settings-field">
                    <span>X 轴旋转</span>
                    <SettingsSelect id="rotation-x" label="X 轴旋转" value={settings.rotation_x} options={ROTATION_OPTIONS} disabled={!selectedModel} onChange={(value) => { updateField('rotation_x', value); requestSave({ ...latestSettingsRef.current, rotation_x: value }); }} />
                  </div>
                  <div className="model-settings-field">
                    <span>Y 轴旋转</span>
                    <SettingsSelect id="rotation-y" label="Y 轴旋转" value={settings.rotation_y} options={ROTATION_OPTIONS} disabled={!selectedModel} onChange={(value) => { updateField('rotation_y', value); requestSave({ ...latestSettingsRef.current, rotation_y: value }); }} />
                  </div>
                  <div className="model-settings-field">
                    <span>Z 轴旋转</span>
                    <SettingsSelect id="rotation-z" label="Z 轴旋转" value={settings.rotation_z} options={ROTATION_OPTIONS} disabled={!selectedModel} onChange={(value) => { updateField('rotation_z', value); requestSave({ ...latestSettingsRef.current, rotation_z: value }); }} />
                  </div>
                  <div className="model-settings-field">
                    <span>向上轴向</span>
                    <SettingsSelect id="up-orientation" label="向上轴向" value={settings.front_orientation} options={UP_ORIENTATION_OPTIONS} disabled={!selectedModel} onChange={(value) => { updateField('front_orientation', value); requestSave({ ...latestSettingsRef.current, front_orientation: value }); }} />
                  </div>
                </div>
              </section>

              <section className="model-settings-form-section" aria-labelledby="center-of-mass-title">
                <div className="model-settings-section-heading">
                  <h2 id="center-of-mass-title">质心设置 <small className="model-settings-unit-hint">({settings.model_unit})</small></h2>
                </div>
                <div className="model-settings-vector-grid">
                  {['x', 'y', 'z'].map((axis) => (
                    <label key={axis} className="model-settings-center-input" htmlFor={`center-of-mass-${axis}`}>
                      <span className="model-settings-center-axis" aria-hidden="true">{axis.toUpperCase()}</span>
                      <input
                        id={`center-of-mass-${axis}`}
                        type="number"
                        step="any"
                        value={settings.center_of_mass?.[axis] ?? ''}
                        disabled={!selectedModel}
                        placeholder="--"
                        onChange={(event) => updateCenterOfMass(axis, event.target.value)}
                        onBlur={() => requestSave(undefined, { silentInvalid: true })}
                      />
                    </label>
                  ))}
                </div>
              </section>

              <ModelSafetyClearanceSection
                values={settings.safety_clearance_mm}
                disabled={!selectedModel}
                onChange={updateSafetyClearance}
                onBlur={() => requestSave()}
              />

              <section className="model-settings-form-section" aria-labelledby="installation-settings-title">
                <div className="model-settings-section-heading model-settings-installation-heading">
                  <h2 id="installation-settings-title">安装设置</h2>
                  <div className="model-settings-installation-actions">
                    <button
                      className={`model-settings-pick-button${pickerState.status === 'active' ? ' active' : ''}`}
                      type="button"
                      disabled={!selectedModel || ['unavailable', 'error'].includes(pickerState.status)}
                      onClick={toggleInstallationPicking}
                    >
                      {pickerState.status === 'building'
                        ? <LoaderCircle className="spinning" aria-hidden="true" />
                        : <Crosshair aria-hidden="true" />}
                      <span>{['active', 'building'].includes(pickerState.status) ? '取消选择' : '选择安装面'}</span>
                    </button>
                    <button
                      className="model-settings-clear-face-button"
                      type="button"
                      disabled={!selectedModel || !settings.installation_face_id}
                      onClick={clearInstallationFace}
                    >
                      清除安装面
                    </button>
                  </div>
                </div>
                <div className={`model-settings-installation-summary${pickerState.status === 'error' || pickerState.invalidSelection ? ' error' : ''}`} aria-live="polite">
                  <span aria-hidden="true" />
                  <div>
                    <strong>{settings.installation_face_id || '未选择安装面'}</strong>
                    <small>
                      {installationFace
                        ? `STEP ${formatInstallationSurfaceType(installationFace.surface_type)} · ${formatInstallationArea(installationFace, settings)}`
                      : settings.installation_face_id
                          ? pickerState.invalidSelection ? '安装面已失效，请清除后重新选择' : '等待高清面映射确认'
                          : pickerState.message}
                    </small>
                  </div>
                </div>
                <div className="model-settings-envelope-actions" aria-label="包络生成操作">
                  <button
                    type="button"
                    disabled={!selectedModel || envelopeAction !== null}
                    onClick={handleGenerateEnvelope}
                  >
                    {envelopeAction === 'single'
                      ? <LoaderCircle className="spinning" aria-hidden="true" />
                      : <Box aria-hidden="true" />}
                    <span>{envelopeAction === 'single' ? '正在生成' : '生成包络'}</span>
                  </button>
                  <button
                    type="button"
                    disabled={!selectedModel || envelopeAction !== null}
                    onClick={handleGenerateAllEnvelopes}
                  >
                    {envelopeAction === 'all'
                      ? <LoaderCircle className="spinning" aria-hidden="true" />
                      : <Boxes aria-hidden="true" />}
                    <span>{envelopeAction === 'all' ? '正在生成全部' : '全部生成包络'}</span>
                  </button>
                  <button
                    type="button"
                    disabled={!selectedModel || envelopeAction !== null || storeAction !== null}
                    title={envelopeState.state === 'ready' ? '把当前模型与包络固化保存到本地 SQLite 数据库' : '请先生成包络再存储'}
                    onClick={handleStoreModel}
                  >
                    {storeAction === 'saving'
                      ? <LoaderCircle className="spinning" aria-hidden="true" />
                      : <Database aria-hidden="true" />}
                    <span>{storeAction === 'saving' ? '正在存储' : '存储到数据库'}</span>
                  </button>
                </div>
                <p className={`model-settings-envelope-status ${envelopeState.state}`} aria-live="polite">
                  {envelopeState.state === 'ready'
                    ? '基础包络已生成'
                    : envelopeState.state === 'generating'
                      ? '正在生成当前模型包络'
                      : envelopeState.state === 'generating-all'
                        ? '正在依次生成全部模型包络'
                        : envelopeState.state === 'error'
                          ? `包络生成失败：${envelopeState.message}`
                          : '当前模型尚未生成包络'}
                </p>
                <p className="model-settings-store-status" aria-live="polite">
                  {storeState.loading
                    ? '正在读取存储状态'
                    : storeState.record
                      ? `已存储 ${storeState.record_count} 次 · 最近 ${formatStoreTimestamp(storeState.record.created_at)}`
                      : selectedModel
                        ? '尚未存储到数据库'
                        : '请先选择模型'}
                </p>
                {envelopePreview.display.state === 'error' && (
                  <p className="model-settings-envelope-preview-error" role="alert">
                    包络预览加载失败：{envelopePreview.display.message}，可关闭后重新打开。
                  </p>
                )}
              </section>
            </div>
          </div>
        </aside>
        <ModelPreviewPanel
          emptyDetail="当前没有可预览的模型"
          extraActions={(
            <button
              id="toggle-envelope-preview"
              className={`icon-button envelope-preview-toggle${envelopePreview.available && envelopePreview.visible ? ' active' : ''}`}
              type="button"
              disabled={!envelopePreview.available}
              aria-pressed={envelopePreview.available && envelopePreview.visible}
              aria-label={envelopePreview.available && envelopePreview.visible ? '隐藏安全包络' : '显示安全包络'}
              title={envelopePreview.available ? '显示或隐藏安全包络（青色半透明）' : '请先保存设置并生成包络'}
              onClick={envelopePreview.toggle}
            >
              {envelopePreview.display.state === 'loading' ? <LoaderCircle className="spinning" /> : <Box />}
              <span>包络</span>
            </button>
          )}
        />
      </main>
      <div id="toast" className="toast" role="status" aria-live="polite" hidden />
    </AppShell>
  );
}
