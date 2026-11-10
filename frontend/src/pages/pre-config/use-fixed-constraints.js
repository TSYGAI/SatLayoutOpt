/** 文件说明：固定组草稿和逐组发布；空模型时恢复含基座的前置预览，异步验收不覆盖其他组草稿；异常统一转换为中文展示。 */
import { useEffect, useRef, useState } from 'react';
import { readPageSession, writePageSession } from '../../app/page-session-state.js';
import { readFixedView, writeFixedView } from './fixed-view-cache.js';
import { useFixedDraft } from './use-fixed-draft.js';
import { fixedDraftSignature, replaceFixedGroup } from './fixed-draft.js';
import { calculateFixedConstraints, getFixedConstraints } from '../../api/fixed-constraints-api.js';
import { loadFixedMeshes, warmFixedMeshes } from '../../api/fixed-mesh-loader.js';
import { streamFixedPreview } from '../../api/fixed-preview-stream.js';
import { getEnvelopePreviewConfig, getFixedInteractionConfig } from '../../api/model-upload-api.js';
import { previewFixedGroupChanges, makeFixedNudgeAction } from './fixed-placement-live-preview.js';
import { fixedNudgeGroups, fixedMountRotationGroups } from './fixed-placement-rigid-preview.js';
import { fixedWorldPoseGroups } from './fixed-world-pose.js';
import { fixedPosePositionChange } from './fixed-pose-reference.js';
import { markFixedSpaceWarnings, markFixedValidationFailure } from './fixed-space-preview.js';
import { limitFixedInstallationHeight } from './fixed-installation-preview.js';
import { formatPreConfigError } from './pre-config-errors.js';

/** 管理固定组的即时显示与正式校验；后端仍唯一负责模型、安全包络、业务可行性和持久化。 */
export function useFixedConstraints({ active, geometry, satellites, previewRef, previewReady, radialSegments }) {
  const draft = useFixedDraft();
  const { groups, setGroups } = draft;
  const [selected, setSelected] = useState(null), [selectedInstance, setSelectedInstance] = useState(null);
  const [poseOpen, setPoseOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [mode, setMode] = useState('numeric'), [fingerprint, setFingerprint] = useState(null);
  const [snapshot, setSnapshot] = useState(null), [status, setStatus] = useState('idle');
  const [entryLoading, setEntryLoading] = useState(true);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [interactionConfig, setInteractionConfig] = useState(null), [nudgeStep, setNudgeStep] = useState('');
  const [validationTick, setValidationTick] = useState(0);
  const latest = useRef({});
  latest.current = { groups, selected, selectedInstance, detailsOpen, mode, nudgeStep, active };
  const revision = useRef(0), running = useRef(false), desired = useRef(null), dragging = useRef(false);
  const meshes = useRef(null), displayed = useRef(null), opacity = useRef(null), mounted = useRef(true), saving = useRef(false);
  const controller = useRef(null);
  const configKey = JSON.stringify([geometry, satellites.map((item) => [item.recordId, item.count, item.symmetryEnabled, item.symmetryMode])]);
  const modelKey = JSON.stringify(satellites.filter((item) => item.count > 0).map((item) => item.recordId));

  /** 前置配置型号确定后即预读有界二进制资源，不等用户第一次点击固定组，也不执行正式布局校验。 */
  useEffect(() => {
    const abort = new AbortController();
    void warmFixedMeshes(JSON.parse(modelKey), abort.signal).catch(() => {});
    return () => abort.abort();
  }, [modelKey]);

  /** 页面卸载时使所有请求失效，结束画布手势并取消网络发布。 */
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; revision.current += 1; desired.current = null;
      controller.current?.abort(); previewRef.current?.setFixedInteraction(null, null);
    };
  }, []);

  /** 读取指纹与交互配置；模型/尺寸变化后旧显示边界不能用于新的即时变换。 */
  useEffect(() => {
    if (!active) return undefined;
    if (!geometry) return undefined;
    const abort = new AbortController();
    revision.current += 1; desired.current = null; meshes.current = null; displayed.current = null;
    dragging.current = false; controller.current?.abort(); setFingerprint(null);
    setEntryLoading(false); setStatus('loading'); setError(''); setNotice('');
    let configurationReady = false;
    // 缓存先取得画布所有权，配置请求在后台复核；复核前不开放编辑或保存。
    void readFixedView(configKey, null, latest.current.groups).then((cached) => {
      if (abort.signal.aborted || configurationReady || !cached) return;
      meshes.current = cached.meshes; opacity.current = cached.opacity;
      const candidate = { ...cached.candidate, validation_pending: true };
      displayed.current = { candidate, groups: cached.groups }; setSnapshot(candidate);
      previewRef.current?.showFixed(candidate, cached.meshes, radialSegments, cached.opacity);
    });
    Promise.all([getFixedConstraints(abort.signal), getEnvelopePreviewConfig(), getFixedInteractionConfig()])
      .then(async ([response, style, interaction]) => {
        if (abort.signal.aborted) return;
        configurationReady = true;
        opacity.current = style.opacity; setInteractionConfig(interaction);
        setNudgeStep((current) => current === '' ? String(interaction.nudgeStepMm) : current);
        draft.initialize(response);
        const currentGroups = readPageSession('pre-config', 'fixedDraft').groups;
        const restored = await readFixedView(configKey, response.config_fingerprint, currentGroups);
        if (abort.signal.aborted) return;
        if (restored) {
          meshes.current = restored.meshes;
          const candidate = { ...restored.candidate, validation_pending: true };
          displayed.current = { candidate, groups: currentGroups };
          setSnapshot(candidate);
          previewRef.current?.showFixed(candidate, restored.meshes, radialSegments, style.opacity);
        } else {
          meshes.current = null; displayed.current = null; setSnapshot(null);
          previewRef.current?.show({ radius: geometry.radius_mm, height: geometry.height_mm,
            installationRadius: geometry.installation_tube?.min_radius_mm ?? geometry.radius_mm,
            installationHeight: geometry.installation_tube?.min_height_mm ?? geometry.height_mm,
            installationBase: geometry.installation_tube?.base,
            axisRadius: geometry.axis_radius_mm, fairingRadius: geometry.fairing_radius_mm,
            profile: geometry.fairing_profile || geometry.profile, radialSegments });
        }
        setFingerprint(response.config_fingerprint); setStatus('idle');
      }).catch((reason) => {
        if (!abort.signal.aborted) { setError(formatPreConfigError(reason, '固定约束读取失败，请重新读取配置后重试。')); setStatus('error'); setEntryLoading(false); }
      });
    return () => abort.abort();
  }, [active, configKey]);

  /** 串行校验最新草稿，仅当前版本允许发布正式位姿；实时交互不等待该队列。 */
  async function drain() {
    if (running.current || saving.current || dragging.current || !mounted.current) return;
    running.current = true;
    try {
      while (desired.current && mounted.current && !saving.current && !dragging.current) {
        const request = desired.current; desired.current = null;
        const abort = new AbortController(); controller.current = abort;
        try {
          const needsInitialDisplay = request.groups.some((group) => !displayed.current?.candidate.placements
            .some((placement) => placement.fixed_group_id === group.group_id && placement.record_id === group.record_id));
          const resources = loadFixedMeshes(request.groups.map((group) => group.record_id), meshes.current, abort.signal,
            { groups: request.groups, fingerprint: request.fingerprint });
          const [prepared, response] = await Promise.all([resources,
            streamFixedPreview(request.groups, request.fingerprint, abort.signal, async (partial) => {
              if (!needsInitialDisplay) return;
              const ready = await resources;
              if (!mounted.current || request.revision !== revision.current || dragging.current || abort.signal.aborted) return;
              // 初始矩阵由服务端统一计算；不写正式缓存，完整验收返回前不能保存或编辑尚未规范化的组。
              const candidate = { ...partial.candidate, initial_display: true };
              meshes.current = ready; displayed.current = { candidate, groups: request.groups };
              setSnapshot(candidate); setEntryLoading(false);
              previewRef.current?.showFixed(candidate, ready, radialSegments, opacity.current);
            })]);
          if (!mounted.current || request.revision !== revision.current || dragging.current) continue;
          meshes.current = prepared;
          latest.current.groups = response.groups;
          setGroups(response.groups);
          displayed.current = { candidate: response.candidate, groups: response.groups };
          setSnapshot(response.candidate); setStatus('ready'); setError('');
          setEntryLoading(false);
          setNotice(response.candidate.validation.valid ? '' : '约束违规卫星已标红，请按下方原因调整后再保存。');
          previewRef.current?.showFixed(response.candidate, meshes.current, radialSegments, opacity.current);
          writeFixedView(configKey, request.fingerprint, response.groups, response.candidate, meshes.current, opacity.current);
        } catch (reason) {
          abort.abort();
          if (mounted.current && request.revision === revision.current && reason.name !== 'AbortError') {
            const message = formatPreConfigError(reason, '固定约束校验失败，请保留当前草稿并重试。');
            // 后台失败只报告错误并禁止保存，绝不能用旧草稿覆盖用户已经看见的位姿。
            if (displayed.current?.groups === latest.current.groups) {
              const retained = markFixedValidationFailure({ ...displayed.current.candidate, initial_display: false }, `正式校验失败，当前位姿已保留：${message}`);
              displayed.current = { ...displayed.current, candidate: retained }; setSnapshot(retained);
              previewRef.current?.showFixed(retained, meshes.current, radialSegments, opacity.current);
            }
            setError(message); setStatus('error');
            setEntryLoading(false);
          }
        }
      }
    } finally { running.current = false; }
  }

  /** 新组立即开始首次显示；连续编辑仍防抖，拖动期间暂停请求，松开后只验收最后位置。 */
  useEffect(() => {
    if (displayed.current && groups === displayed.current.groups && !displayed.current.candidate.validation_pending) return undefined;
    revision.current += 1;
    if (!active || !fingerprint || groups === null || saving.current || dragging.current || !interactionConfig) {
      desired.current = null; return undefined;
    }
    setStatus('calculating');
    const request = { groups, fingerprint, revision: revision.current };
    const firstDisplay = groups.some((group) => !displayed.current?.candidate.placements
      .some((placement) => placement.fixed_group_id === group.group_id && placement.record_id === group.record_id));
    const timer = window.setTimeout(() => {
      if (request.revision !== revision.current || dragging.current) return;
      desired.current = request; void drain();
    }, firstDisplay ? 0 : interactionConfig.validationDebounceMs);
    return () => window.clearTimeout(timer);
  }, [groups, fingerprint, active, interactionConfig, validationTick]);

  /** 发布一次草稿改动；成员未变时即刻更新缓存矩阵、包络及同快照质心。 */
  function replace(next) {
    setEntryLoading(false);
    revision.current += 1; desired.current = null;
    controller.current?.abort();
    const cache = displayed.current;
    let live = cache && previewFixedGroupChanges(cache.candidate, cache.groups, next, meshes.current);
    let limited = false;
    if (live) {
      const result = limitFixedInstallationHeight(live, next);
      limited = result.limited; next = result.groups;
      if (limited) live = previewFixedGroupChanges(cache.candidate, cache.groups, next, meshes.current);
    }
    latest.current.groups = next; setGroups(next); setError(''); setNotice('');
    if (live && meshes.current) {
      live = markFixedSpaceWarnings(live, meshes.current);
      if (!live.boundary_validation.valid) setNotice('当前位姿不符合空间约束，已保留操作并标红，请调整后再保存。');
      if (limited) setNotice('共面安装区域已到达直筒高度边界，不能继续越界移动。');
      displayed.current = { candidate: live, groups: next }; setSnapshot(live);
      previewRef.current?.showFixed(live, meshes.current, radialSegments, opacity.current);
    }
    setStatus(dragging.current ? 'dragging' : 'calculating');
  }

  /** 选择一个完整组及点击的具体副本；列表选择时控件定位到该组第一颗。 */
  function selectGroup(groupId, instanceId = null, openPose = true) {
    if (!groupId || groupId !== latest.current.selected) setDetailsOpen(Boolean(groupId));
    latest.current.selected = groupId || null; latest.current.selectedInstance = instanceId;
    setSelected(groupId || null); setSelectedInstance(instanceId); setNotice('');
    if (openPose || !groupId) setPoseOpen(Boolean(groupId));
  }

  /** 只有再次点击当前组标题才收起参数；切换组时展开目标，画布调整及异步验收不改变展开状态。 */
  function toggleGroup(groupId) {
    const collapse = groupId === latest.current.selected && latest.current.detailsOpen;
    selectGroup(groupId);
    setDetailsOpen(!collapse);
  }

  /** 关闭信息浮窗但保留当前选择和六向控件；再次点击包络或选择组会重新打开。 */
  function closePose() { setPoseOpen(false); }

  /** 添加固化类型的默认侧挂组；正式几何是否合法由后端验收。 */
  function add(recordId) {
    const group = { ...draft.defaults, hard_constraint: true, auto_place: true, group_id: crypto.randomUUID(), record_id: recordId, mount: 'side', copies: 1,
      angle_deg: 0, height_mm: geometry.height_mm / 2, suspension_mm: 0, roll_quarters: 0 };
    replace([...(latest.current.groups || []), group]); selectGroup(group.group_id);
  }

  /** 更新指定组或当前组输入；行内软硬约束选择不改变展开状态，切换安装方式时恢复对应安装基准。 */
  function patch(update, groupId = latest.current.selected) {
    replace((latest.current.groups || []).map((group) => group.group_id === groupId
      ? { ...group, ...update, ...(Object.hasOwn(update, 'suspension_mm') ? { manual_suspension_mm: null } : {}),
        ...((update.mount || Object.hasOwn(update, 'suspension_mm'))
          ? { reference_radius_mm: geometry.radius_mm, reference_height_mm: geometry.height_mm } : {}),
        ...(update.mount && update.mount !== group.mount ? { attitude_quaternion: [0, 0, 0, 1], manual_suspension_mm: null } : {}),
        ...(update.mount === 'top' ? { copies: 1, symmetry_mode: 'ring', angle_deg: 0, height_mm: 0 } : {}) } : group));
  }

  /** 用共面安装区域最低点换算安装点的同量 Z 位移；输入为距直筒下沿的高度，统一经过交互限位。 */
  function editInstallationHeight(value) {
    const cache = displayed.current;
    if (!Number.isFinite(value) || !cache || cache.groups !== latest.current.groups
        || !latest.current.active || !fingerprint || saving.current || dragging.current) return;
    const group = latest.current.groups.find((item) => item.group_id === latest.current.selected);
    const placement = cache.candidate.placements.find((item) => item.fixed_group_id === group?.group_id);
    if (group?.mount !== 'side' || !Number.isFinite(placement?.installation_region_bottom_mm)) return;
    patch({ height_mm: group.height_mm + value - (placement.installation_region_bottom_mm - cache.candidate.installation_base.height_mm) });
  }

  /** 对已加载包络立即执行世界轴平移；安装区域在直筒两端限位，其他违规标红并由后台验收。 */
  function nudge(action) {
    if (action.kind && action.kind !== 'translate') return;
    if (action.disabled) { setNotice('顶部仅支持居中放置，横向箭头不可移动；可用±Z调整悬高。'); return; }
    if (!displayed.current || !meshes.current || saving.current || dragging.current || !fingerprint
        || !latest.current.active || displayed.current.groups !== latest.current.groups) {
      setNotice('请等待型号或安装方式更新后再微调。'); return;
    }
    const request = makeFixedNudgeAction('translate', action.groupId, action.instanceId, action.axis, action.sign,
      Number(latest.current.nudgeStep));
    if (!request) { setNotice('请设置大于0的微调步长。'); return; }
    const next = fixedNudgeGroups(displayed.current.candidate, latest.current.groups || [], request);
    if (!next) { setNotice('微调目标不属于当前固定组或安装方式不支持该动作。'); return; }
    selectGroup(action.groupId, action.instanceId, false); replace(next);
  }

  /** 按控件依据当前视角换算后的安装轴符号旋转；同组联动与镜像手性由坐标换算保留，正式约束仍由后端验收。 */
  function rotateMount(action) {
    const cache = displayed.current;
    if (!cache || !meshes.current || cache.groups !== latest.current.groups || saving.current || dragging.current
        || !fingerprint || !latest.current.active || !interactionConfig || ![-1, 1].includes(action.sign)) return;
    const next = fixedMountRotationGroups(cache.candidate, latest.current.groups, action.instanceId,
      action.sign * interactionConfig.mountRotationStepDeg);
    if (!next) return;
    selectGroup(action.groupId, action.instanceId, false); replace(next);
  }

  /** 右侧信息窗提交一个绝对世界分量；读取最新快照并即时显示，同组副本保持关系。 */
  function editWorldPose(instanceId, changes) {
    const cache = displayed.current;
    if (!cache || !meshes.current || saving.current || dragging.current || !fingerprint || !latest.current.active
        || cache.groups !== latest.current.groups) return '请等待型号或安装方式更新后再编辑';
    const selectedPlacement = cache.candidate.placements.find((item) => item.instance_id === latest.current.selectedInstance
      && item.fixed_group_id === latest.current.selected)
      || cache.candidate.placements.find((item) => item.fixed_group_id === latest.current.selected);
    if (!selectedPlacement || selectedPlacement.instance_id !== instanceId) return '当前选择已改变，请重新编辑';
    const request = {};
    if (changes.position) {
      request.position_mm = fixedPosePositionChange(selectedPlacement, changes.position);
      if (!request.position_mm) return '当前基准点数据或输入数值无效';
    }
    const next = fixedWorldPoseGroups(cache.candidate, latest.current.groups, instanceId, request);
    if (!next) return '该数值或安装方式不支持当前修改';
    replace(next);
    return '';
  }

  /** 拖动每帧本地反馈，结束后正式验收最终草稿；点选与安装面旋转共享当前选择。 */
  function gesture(phase, update) {
    if (!mounted.current) return;
    if (phase === 'select') {
      if (update.groupId) selectGroup(update.groupId, update.instanceId);
      return;
    }
    if (phase === 'nudge') { nudge(update); return; }
    if (phase === 'mount-rotate') { rotateMount(update); return; }
    if (phase === 'start') {
      dragging.current = true; revision.current += 1; desired.current = null; controller.current?.abort();
      setStatus('dragging'); setNotice('');
    }
    if (phase === 'move') patch(update);
    if (phase === 'end') {
      dragging.current = false; setStatus('calculating'); setValidationTick((value) => value + 1);
    }
  }

  /** 发布当前组或明确选择的全部草稿；逐组提交以服务端已保存列表为基线，失败不改变草稿及正式版本。 */
  async function publish(groupId = null, deleting = false) {
    if (!fingerprint || saving.current || dragging.current || !latest.current.active) return false;
    if (!deleting && (status !== 'ready' || displayed.current?.candidate.validation_pending
        || displayed.current?.candidate.validation.valid !== true)) return false;
    const selectedGroup = latest.current.groups?.find((group) => group.group_id === groupId);
    if (groupId && !selectedGroup) return false;
    const previousStatus = status;
    saving.current = true; revision.current += 1; desired.current = null; controller.current?.abort(); setStatus('saving'); setError('');
    try {
      const saved = groupId ? await getFixedConstraints() : null;
      if (saved && saved.config_fingerprint !== fingerprint) throw new Error('配置已变化，请刷新页面后重新校验；当前草稿已保留。');
      // 未发布的新组删除只影响本地；已发布组的删除即时提交，最后一组也不依赖全局保存按钮。
      if (deleting && !saved.groups.some((group) => group.group_id === groupId)) {
        replace(replaceFixedGroup(latest.current.groups, groupId, null));
        selectGroup(null);
        return true;
      }
      const submitted = groupId ? replaceFixedGroup(saved.groups, groupId, deleting ? null : selectedGroup) : latest.current.groups || [];
      const response = await calculateFixedConstraints(submitted, fingerprint, { save: true });
      const next = draft.commit(response.groups, groupId);
      latest.current.groups = next;
      let publishedMeshes;
      try { publishedMeshes = await loadFixedMeshes(response.groups.map((group) => group.record_id), meshes.current,
        new AbortController().signal, { groups: response.groups, fingerprint: response.config_fingerprint }); }
      catch {
        // PUT 已成功，显示缓存失败不能伪装成保存失败或恢复旧基线；下一次正式预览重新加载网格。
        writePageSession('layout', 'savedFixedPreview', null);
        if (mounted.current) {
          meshes.current = null; displayed.current = null; setFingerprint(response.config_fingerprint);
          setStatus('calculating');
          setNotice('固定约束已更新，正在重新加载预览。');
          if (deleting) selectGroup(null);
        }
        return true;
      }
      writePageSession('layout', 'savedFixedPreview', {
        fingerprint: response.config_fingerprint, candidate: response.candidate, meshes: publishedMeshes,
      });
      if (!mounted.current) return true;
      meshes.current = { ...meshes.current, ...publishedMeshes };
      setFingerprint(response.config_fingerprint);
      if (fixedDraftSignature(next, draft.defaults) === fixedDraftSignature(response.groups, draft.defaults)) {
        displayed.current = { candidate: response.candidate, groups: next };
        setSnapshot(response.candidate); setStatus('ready'); setError(''); setNotice('');
        previewRef.current?.showFixed(response.candidate, meshes.current, radialSegments, opacity.current);
        writeFixedView(configKey, response.config_fingerprint, next, response.candidate, meshes.current, opacity.current);
      } else replace(next);
      if (deleting) selectGroup(null);
      return true;
    } catch (reason) {
      if (mounted.current) {
        setError(formatPreConfigError(reason, '固定约束保存失败，当前草稿已保留，请重试。')); setStatus(previousStatus);
      }
      return false;
    }
    finally {
      saving.current = false;
      // 保存期间草稿订阅可能已触发过校验 effect；即使指纹未变，也必须重新验收其余未发布草稿。
      if (mounted.current && (displayed.current?.groups !== latest.current.groups || displayed.current?.candidate.validation_pending)) {
        setValidationTick((value) => value + 1);
      }
    }
  }

  /** 组内保存只发布当前组，其他组的未保存输入继续留在草稿中。 */
  async function save() { return latest.current.selected ? publish(latest.current.selected) : false; }

  /** 离页弹窗明确选择全部保存时发布全部草稿，成功才允许导航。 */
  async function saveAll() { return publish(); }

  /** 删除仅作用于当前组；持久化失败仍保留组和输入以便重试。 */
  async function remove() { return latest.current.selected ? publish(latest.current.selected, true) : false; }

  /** 不保存离开时取消旧预览并丢弃未发布草稿；已完成的逐组保存和删除仍保留。 */
  function discard() {
    revision.current += 1; desired.current = null; controller.current?.abort(); dragging.current = false;
    displayed.current = null;
    latest.current.groups = draft.discard();
    setSnapshot(null);
    selectGroup(null); setError(''); setNotice(''); setStatus('idle');
  }

  /** Three.js 晚于缓存响应初始化时补画同一完整快照。 */
  useEffect(() => {
    if (active && previewReady && snapshot && meshes.current) {
      previewRef.current?.showFixed(snapshot, meshes.current, radialSegments, opacity.current);
    }
  }, [active, previewReady]);

  /** 任意放置模式均允许点击包络选择；画布回调通过最新引用避免闭包中的旧选择覆盖当前手势。 */
  useEffect(() => {
    const enabled = active && geometry && interactionConfig && status !== 'saving' && status !== 'loading' && !snapshot?.initial_display;
    previewRef.current?.setFixedInteraction(enabled ? {
      groups: groups || [], placements: snapshot?.placements || [], groupId: selected, instanceId: selectedInstance,
      mode,
      rotationStepDeg: interactionConfig.mountRotationStepDeg,
      rotationEnabled: Boolean(fingerprint && meshes.current && displayed.current?.groups === groups) && !dragging.current,
      radius: geometry.radius_mm, height: geometry.height_mm,
      tubeBottom: geometry.installation_tube.base.height_mm, gizmoSizePx: interactionConfig.gizmoSizePx,
    } : null, gesture);
  }, [active, groups, selected, selectedInstance, mode, status, snapshot, geometry, previewReady, interactionConfig]);

  return { groups: groups || [], entryLoading, dirty: draft.dirty, storageError: draft.storageError, defaults: draft.defaults,
    selected, selectedInstance, detailsOpen, toggleGroup, mode, setMode, snapshot, status, error, notice,
    nudgeStep, setNudgeStep, add, patch, editInstallationHeight, remove, save, saveAll, discard,
    editWorldPose, poseOpen, closePose, poseEditable: active && Boolean(fingerprint && meshes.current && displayed.current?.groups === groups)
      && !saving.current && !dragging.current && status !== 'loading' && !snapshot?.initial_display };
}
