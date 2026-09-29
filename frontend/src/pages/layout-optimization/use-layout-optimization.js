/** 文件说明：管理布局参数、历史恢复/重命名/删除及任务轮询；通过 API 保存数据，卸载不取消计算。 */

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getBackgroundTaskPollingConfig } from '../../api/model-upload-api.js';
import {
  cancelLayoutJob, deleteLayoutJob, exportLayoutCandidate, getLayoutConfig, getLayoutHistory, getLayoutJob, getLayoutMeshes,
  renameLayoutJob, startLayoutJob,
} from '../../api/layout-optimization-api.js';
import {
  buildLayoutPayload, createLayoutForm, isLayoutRunning, readLayoutFormDraft, writeLayoutFormDraft,
} from './layout-state.js';

/** 使用服务端最新配置创建表单，同时恢复当前标签页中尚未提交的用户输入。 */
function createCurrentLayoutForm(config) {
  return createLayoutForm(config, readLayoutFormDraft());
}

/** 将历史任务选项补齐为当前表单结构，兼容新增半径步长前保存的任务。 */
function restoreTaskForm(config, options) {
  return { ...createLayoutForm(config), ...(options ?? {}) };
}

/** 返回布局表单、任务状态与用户操作；错误以可显示的字符串暴露，卸载时停止轮询。 */
export function useLayoutOptimization() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState(null);
  const [job, setJob] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyNameMaxLength, setHistoryNameMaxLength] = useState(undefined);
  const [meshSnapshot, setMeshSnapshot] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [viewingHistory, setViewingHistory] = useState(false);
  const actionPending = useRef(false);
  const historyVersion = useRef(0);

  /** 初始化左栏并恢复最近的活动任务，读取失败时保留明确错误。 */
  useEffect(() => {
    const controller = new AbortController();
    const version = historyVersion.current;
    Promise.all([getLayoutConfig(controller.signal), getLayoutHistory(controller.signal)])
      .then(async ([settings, previous]) => {
        if (controller.signal.aborted) return;
        const currentForm = createCurrentLayoutForm(settings);
        setConfig(settings);
        setForm(currentForm);
        setHistory(previous.jobs);
        setHistoryTotal(previous.total);
        setHistoryNameMaxLength(settings.history_name_max_length);
        const requested = searchParams.get('project');
        if (requested) {
          const current = await getLayoutJob(requested, controller.signal);
          if (!controller.signal.aborted && version === historyVersion.current) {
            setJob(current); setConfig(current.locked_config ?? settings);
            setForm(restoreTaskForm(current.locked_config ?? settings, current.options)); setViewingHistory(!isLayoutRunning(current));
          }
          return;
        }
        const active = previous.jobs.find(isLayoutRunning);
        if (active) {
          const current = await getLayoutJob(active.job_id, controller.signal);
          if (!controller.signal.aborted && version === historyVersion.current) {
            setJob(current); setConfig(current.locked_config ?? settings);
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
          setHistory((current) => current.map((item) => item.job_id === latest.job_id
            ? { ...item, name: latest.name, status: latest.status, error: latest.error, candidate_count: latest.candidates.length } : item));
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

  /** 结果完成时加载独立的正式包络快照，切换历史任务会取消过期请求。 */
  useEffect(() => {
    setMeshSnapshot(null);
    setSelectedId(job?.candidates?.[0]?.candidate_id ?? null);
    if (!job?.candidates?.length) return undefined;
    const controller = new AbortController();
    const jobId = job.job_id;
    getLayoutMeshes(job.job_id, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) setMeshSnapshot({ jobId, meshes: response.meshes });
      })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [job?.job_id, job?.status]);

  /** 串行执行用户操作并返回是否成功；用版本号拒绝操作前发出的过期轮询结果。 */
  async function execute(action) {
    if (actionPending.current) return false;
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
        setJob(null); setMeshSnapshot(null); setSelectedId(null);
        setViewingHistory(false); setConfig(settings); setForm(createCurrentLayoutForm(settings));
        setHistoryNameMaxLength(settings.history_name_max_length);
        setSearchParams({}, { replace: true });
      }
    });
  }

  /** 按当前表单提交任务，保留本次独立参数，不更改前置配置。 */
  async function start() {
    await execute(async () => {
      const next = await startLayoutJob(buildLayoutPayload(form));
      setJob(next); setMeshSnapshot(null); setSelectedId(null);
      setSearchParams({ project: next.job_id }, { replace: true });
      const previous = await getLayoutHistory();
      setHistory(previous.jobs); setHistoryTotal(previous.total);
    });
  }

  /** 取消当前任务，服务完成协作取消前按钮保持运行态。 */
  async function cancel() { await execute(async () => setJob(await cancelLayoutJob(job.job_id))); }

  /** 读取历史任务及其锁定快照；刷新当前配置前禁止由历史输入创建任务。 */
  async function restore(id) {
    await execute(async () => {
      const previous = await getLayoutJob(id);
      setJob(previous); setViewingHistory(true); setConfig(previous.locked_config ?? config);
      setSearchParams({ project: previous.job_id }, { replace: true });
      setForm(restoreTaskForm(previous.locked_config ?? config, previous.options));
      setSelectedId(previous.candidates?.[0]?.candidate_id ?? null);
    });
  }

  /** 从设置源刷新锁定参数，保持允许填写的选项，清除历史视图后可建立新任务。 */
  async function refreshConfig() {
    await execute(async () => {
      const current = await getLayoutConfig();
      setConfig(current); setViewingHistory(false); setJob(null);
      setHistoryNameMaxLength(current.history_name_max_length);
      setSearchParams({}, { replace: true });
      setForm((previous) => ({ ...createLayoutForm(current), ...previous, config_fingerprint: current.config_fingerprint }));
    });
  }

  /** 下载点击时正在查看的方案，不改变已选方案；错误显示在左栏，完成后释放临时下载地址。 */
  async function exportCurrentCandidate() {
    if (!job || !selectedId || busy) return;
    const id = job.job_id, candidateId = selectedId;
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
    meshes: meshSnapshot && meshSnapshot.jobId === job?.job_id ? meshSnapshot.meshes : null,
    selectedId, setSelectedId,
    candidate: job?.candidates?.find((item) => item.candidate_id === selectedId),
    error, busy, start, cancel, restore, renameHistory, deleteHistory, exportCurrentCandidate,
    loadMoreHistory, refreshConfig, viewingHistory };
}
