/**
 * 文件说明：保留布局参数、历史与微调版本选择及管理；普通导航检测配置变化，显式历史保持任务快照。
 * 通过布局 API 执行业务操作；完整接收 Excel 后交给浏览器下载，并使用公共 toast 提示项目与方案。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { readPageSession, usePageSessionState } from '../../app/page-session-state.js';
import { showToast } from '../../components/toast.js';
import { getBackgroundTaskPollingConfig } from '../../api/model-upload-api.js';
import {
  cancelLayoutJob, deleteLayoutJob, exportLayoutCandidate, getLayoutConfig, getLayoutHistory, getLayoutJob,
  renameLayoutJob, startLayoutJob,
} from '../../api/layout-optimization-api.js';
import { deleteRefinementVersion, renameRefinementVersion } from '../../api/layout-refinement-api.js';
import {
  buildLayoutPayload, canRestoreLayoutSession, createLayoutForm, isLayoutRunning, readLayoutFormDraft, restoreTaskForm, writeLayoutFormDraft,
} from './layout-state.js';
import { useLayoutMeshes } from './use-layout-meshes.js';

/** 使用服务端最新配置创建表单，同时恢复当前标签页中尚未提交的用户输入。 */
function createCurrentLayoutForm(config) {
  return createLayoutForm(config, readLayoutFormDraft());
}

/** 返回布局表单、任务状态与用户操作；错误以可显示的字符串暴露，卸载时停止轮询。 */
export function useLayoutOptimization() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [config, setConfig] = usePageSessionState('layout', 'config', null);
  const [form, setForm] = usePageSessionState('layout', 'form', null);
  const [job, setJob] = usePageSessionState('layout', 'job', null);
  const [history, setHistory] = usePageSessionState('layout', 'history', []);
  const [historyTotal, setHistoryTotal] = usePageSessionState('layout', 'historyTotal', 0);
  const [historyNameMaxLength, setHistoryNameMaxLength] = usePageSessionState('layout', 'historyNameMaxLength', undefined);
  const [selectedId, setSelectedId] = usePageSessionState('layout', 'selectedId', null);
  const [error, setError] = usePageSessionState('layout', 'error', '');
  const [busy, setBusy] = usePageSessionState('layout', 'busy', false);
  const [viewingHistory, setViewingHistory] = usePageSessionState('layout', 'viewingHistory', false);
  const [currentFingerprint, setCurrentFingerprint] = useState(null);
  const actionPending = useRef(false);
  const historyVersion = useRef(0);
  const mounted = useRef(true);
  const allCandidates = [...(job?.candidates ?? []), ...(job?.refinements ?? [])];
  const candidateJson = JSON.stringify(allCandidates.find((item) => item.candidate_id === selectedId) ?? job?.candidates?.[0] ?? null);
  const candidateIds = JSON.stringify(allCandidates.map((item) => item.candidate_id));
  const candidate = useMemo(() => JSON.parse(candidateJson), [candidateJson]);
  const meshState = useLayoutMeshes(job?.job_id, candidate);

  /** 用最新任务详情同步已加载的历史摘要，切换项目后仍保留实际候选数和最新状态。 */
  function syncHistoryJob(latest) {
    setHistory((current) => current.map((item) => item.job_id === latest.job_id
      ? { ...item, name: latest.name ?? item.name, status: latest.status, error: latest.error, candidate_count: latest.candidates.length }
      : item));
  }

  /** 离页后仍保存已确认的操作结果，但不允许旧操作把用户导航回原页面。 */
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  /** 初始化左栏并恢复最近的活动任务，读取失败时保留明确错误。 */
  useEffect(() => {
    if (busy) return undefined;
    const controller = new AbortController();
    const version = historyVersion.current;
    Promise.all([getLayoutConfig(controller.signal), getLayoutHistory(controller.signal)])
      .then(async ([settings, previous]) => {
        if (controller.signal.aborted || version !== historyVersion.current) return;
        const currentForm = createCurrentLayoutForm(settings);
        const explicitProject = searchParams.get('project');
        const restoreSession = canRestoreLayoutSession(job, settings, explicitProject);
        const previousJob = restoreSession ? job : null;
        setCurrentFingerprint(settings.config_fingerprint);
        setConfig((current) => previousJob ? current : settings);
        setForm((current) => previousJob ? current ?? currentForm : createLayoutForm(settings, current ?? readLayoutFormDraft()));
        if (!restoreSession) {
          historyVersion.current += 1;
          setJob(null); setSelectedId(null); setViewingHistory(false); setError('');
        }
        setHistory((current) => previous.total <= previous.jobs.length ? previous.jobs
          : [...previous.jobs, ...current.filter((item) => !previous.jobs.some((next) => next.job_id === item.job_id))].slice(0, previous.total));
        setHistoryTotal(previous.total);
        setHistoryNameMaxLength(settings.history_name_max_length);
        const requested = explicitProject || previousJob?.job_id;
        if (requested) {
          let current;
          try { current = await getLayoutJob(requested, controller.signal); }
          catch (failure) {
            if (controller.signal.aborted || version !== historyVersion.current) return;
            if (failure.status !== 404) throw failure;
            setJob(null); setSelectedId(null); setViewingHistory(false);
            setConfig(settings); setForm(currentForm);
            setError('原历史项目已删除，已恢复当前配置');
            if (mounted.current) setSearchParams({}, { replace: true });
            return;
          }
          if (!controller.signal.aborted && version === historyVersion.current && canRestoreLayoutSession(current, settings, explicitProject)) {
            setJob(current); setConfig(current.locked_config ?? settings);
            syncHistoryJob(current);
            if (requested !== job?.job_id) setForm(restoreTaskForm(current.locked_config ?? settings, current.options));
            setViewingHistory(!isLayoutRunning(current));
            const requestedCandidate = searchParams.get('candidate');
            if (requestedCandidate && [...(current.candidates ?? []), ...(current.refinements ?? [])].some((item) => item.candidate_id === requestedCandidate)) setSelectedId(requestedCandidate);
          }
          return;
        }
        if (!restoreSession) return;
        const active = previous.jobs.find(isLayoutRunning);
        if (active) {
          const current = await getLayoutJob(active.job_id, controller.signal);
          if (!controller.signal.aborted && version === historyVersion.current && canRestoreLayoutSession(current, settings)) {
            setJob(current); setConfig(current.locked_config ?? settings);
            syncHistoryJob(current);
            setForm(restoreTaskForm(current.locked_config ?? settings, current.options));
          }
        }
      }).catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, []);

  /** 使用统一轮询间隔持续读取任务，网络错误会重试；没有前端截止时间。 */
  useEffect(() => {
    if (!isLayoutRunning(job)) return undefined;
    const controller = new AbortController();
    let timer;
    /** 在当前任务的轮询周期中读取状态；后续周期只在任务仍活动时安排。 */
    async function poll() {
      let timing;
      try {
        timing = await getBackgroundTaskPollingConfig();
        if (controller.signal.aborted) return;
        const version = historyVersion.current;
        const latest = await getLayoutJob(job.job_id, controller.signal);
        if (controller.signal.aborted) return;
        if (version === historyVersion.current && !actionPending.current) {
          setJob(latest);
          setError((current) => current.startsWith('读取进度失败，将自动重试：') ? '' : current);
          syncHistoryJob(latest);
          if (!isLayoutRunning(latest)) return;
        }
      } catch (failure) {
        if (!controller.signal.aborted) setError(`读取进度失败，将自动重试：${failure.message}`);
      }
      if (!controller.signal.aborted && timing) timer = window.setTimeout(poll, timing.runningPollIntervalMs);
    }
    void poll();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [job?.job_id, job?.status]);

  /** 首个候选出现或已选候选被移除时恢复有效选择；普通进度与新增候选保留用户当前选择。 */
  useEffect(() => {
    const ids = JSON.parse(candidateIds);
    setSelectedId((current) => ids.includes(current) ? current : ids[0] ?? null);
  }, [job?.job_id, candidateIds]);

  /** 串行执行用户操作并返回是否成功；用版本号拒绝操作前发出的过期轮询结果。 */
  async function execute(action) {
    if (actionPending.current || busy) return false;
    actionPending.current = true;
    historyVersion.current += 1;
    setBusy(true); setError('');
    try { await action(); return true; }
    catch (failure) { setError(failure.message); return false; }
    finally { actionPending.current = false; historyVersion.current += 1; setBusy(false); }
  }

  /** 合并用户输入并立即保存会话草稿；历史或运行中任务的锁定选项不可写入。 */
  function changeForm(changes) {
    if (!form || viewingHistory || isLayoutRunning(job)) return;
    const next = { ...form, ...changes };
    writeLayoutFormDraft(next);
    setForm(next);
  }

  /** 保存独立的项目名称，同步当前任务和已加载历史；失败返回 false 以保留编辑内容。 */
  async function renameHistory(id, name) {
    return execute(async () => {
      const updated = await renameLayoutJob(id, name);
      setHistory((current) => current.map((item) => item.job_id === id ? { ...item, name: updated.name } : item));
      setJob((current) => current?.job_id === id ? { ...current, name: updated.name } : current);
    });
  }

  /** 删除已确认的历史；删除当前项目时恢复现行配置并清空候选、快照和项目链接。 */
  async function deleteHistory(id) {
    return execute(async () => {
      const settings = job?.job_id === id ? await getLayoutConfig() : null;
      await deleteLayoutJob(id);
      setHistory((current) => current.filter((item) => item.job_id !== id));
      setHistoryTotal((current) => Math.max(0, current - 1));
      if (settings) {
        setCurrentFingerprint(settings.config_fingerprint);
        setJob(null); setSelectedId(null);
        setViewingHistory(false); setConfig(settings); setForm(createCurrentLayoutForm(settings));
        setHistoryNameMaxLength(settings.history_name_max_length);
        if (mounted.current) setSearchParams({}, { replace: true });
      }
    });
  }

  /** 切换候选并同步当前项目链接，刷新页面时仍显示用户选中的版本。 */
  function selectCandidate(id) {
    setSelectedId(id);
    if (job && mounted.current) setSearchParams({ project: job.job_id, candidate: id }, { replace: true });
  }

  /** 保存版本名称后合并当前任务；只更新相同项目，失败保留列表和弹窗输入。 */
  async function renameRefinement(jobId, id, name) {
    return execute(async () => {
      const updated = await renameRefinementVersion(jobId, id, name);
      setJob((current) => current?.job_id === jobId ? { ...current,
        refinements: current.refinements.map((item) => item.candidate_id === id ? updated : item) } : current);
    });
  }

  /** 删除成功后移除单个版本；当前选择失效时回退有效方案并更新链接，离页后不发起导航。 */
  async function deleteRefinement(jobId, id) {
    return execute(async () => {
      await deleteRefinementVersion(jobId, id);
      const current = readPageSession('layout', 'job');
      if (current?.job_id !== jobId) return;
      const refinements = current.refinements.filter((item) => item.candidate_id !== id);
      const fallback = current.candidates?.[0]?.candidate_id ?? refinements[0]?.candidate_id ?? null;
      setJob({ ...current, refinements });
      setSelectedId((selected) => selected === id ? fallback : selected);
      if (mounted.current) {
        const selected = readPageSession('layout', 'selectedId');
        setSearchParams({ project: jobId, ...(selected ? { candidate: selected } : {}) }, { replace: true });
      }
    });
  }

  /** 按当前表单提交任务，保留本次独立参数，不更改前置配置。 */
  async function start() {
    await execute(async () => {
      const next = await startLayoutJob(buildLayoutPayload(form));
      setJob(next); setSelectedId(null);
      if (mounted.current) setSearchParams({ project: next.job_id }, { replace: true });
      const previous = await getLayoutHistory();
      setHistory(previous.jobs); setHistoryTotal(previous.total);
    });
  }

  /** 取消当前任务，服务完成协作取消前按钮保持运行态。 */
  async function cancel() {
    await execute(async () => {
      const latest = await cancelLayoutJob(job.job_id);
      setJob(latest); syncHistoryJob(latest);
    });
  }

  /** 读取历史任务及其锁定快照；刷新当前配置前禁止由历史输入创建任务。 */
  async function restore(id) {
    await execute(async () => {
      const previous = await getLayoutJob(id);
      setJob(previous); setViewingHistory(true); setConfig(previous.locked_config ?? config);
      syncHistoryJob(previous);
      if (mounted.current) setSearchParams({ project: previous.job_id }, { replace: true });
      setForm(restoreTaskForm(previous.locked_config ?? config, previous.options));
      setSelectedId(previous.candidates?.[0]?.candidate_id ?? null);
    });
  }

  /** 刷新锁定配置并保留人工选项；缺项读取当前默认值，清除历史视图后可建立新任务。 */
  async function refreshConfig() {
    await execute(async () => {
      const current = await getLayoutConfig();
      setCurrentFingerprint(current.config_fingerprint);
      setConfig(current); setViewingHistory(false); setJob(null);
      setHistoryNameMaxLength(current.history_name_max_length);
      if (mounted.current) setSearchParams({}, { replace: true });
      setForm((previous) => createLayoutForm(current, previous));
    });
  }

  /** 下载点击时正在查看的方案；成功后在本页右下角提示项目与方案，失败显示左栏错误并释放临时地址。 */
  async function exportCurrentCandidate() {
    if (!job || !candidate || busy) return;
    const id = job.job_id, candidateId = candidate.candidate_id;
    const projectName = job.name || job.notes || id.slice(0, 8);
    await execute(async () => {
      const file = await exportLayoutCandidate(id, candidateId);
      const url = URL.createObjectURL(file);
      const link = document.createElement('a');
      try {
        link.href = url;
        link.download = `layout-${id}-${candidateId}.xlsx`;
        document.body.appendChild(link);
        link.click();
      } finally {
        link.remove();
        URL.revokeObjectURL(url);
      }
      if (mounted.current) showToast(`${projectName} · ${candidate.refinement?.name || `布局方案 ${candidateId.split('-').at(-1)}`} Excel 下载成功`);
    });
  }

  /** 读取下一页历史并合并到左栏，不改变当前任务。 */
  async function loadMoreHistory() {
    await execute(async () => {
      const previous = await getLayoutHistory(undefined, history.length);
      setHistory((current) => [...current, ...previous.jobs]); setHistoryTotal(previous.total);
    });
  }

  return { config, form, changeForm, job, history, historyTotal, historyNameMaxLength,
    ...meshState,
    selectedId, setSelectedId: selectCandidate,
    candidate,
    error: error || meshState.meshError, busy, start, cancel, restore, renameHistory, deleteHistory, renameRefinement, deleteRefinement, exportCurrentCandidate,
    loadMoreHistory, refreshConfig, viewingHistory, currentFingerprint };
}
