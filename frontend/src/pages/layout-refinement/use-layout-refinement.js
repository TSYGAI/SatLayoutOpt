/** 文件说明：管理微调来源、即时显示和正式历史；连续改动立即替代旧校验，最新累计状态经后端接受后写入历史，迟到响应不污染草稿。 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { cancelRefinementValidation, getRefinement, previewRefinement, saveRefinement } from '../../api/layout-refinement-api.js';
import { getLayoutJob } from '../../api/layout-optimization-api.js';
import { useLayoutMeshes } from '../layout-optimization/use-layout-meshes.js';
import { appendCommand, limitTransient, previewCommands, previewPendingMotions, restoreDraft } from './refinement-state.js';
import { createRefinementValidation } from './refinement-validation.js';

/** 返回来源专属草稿键，避免不同任务、候选和快照之间串用。 */
function draftKey(jobId, candidateId) { return `sat-layout-refinement:${jobId}:${candidateId}`; }

/** 读取结构合法的本地日志；恢复后仍须正式重放，旧指纹或损坏日志直接忽略。 */
function readDraft(key, context) {
  try { return restoreDraft(JSON.parse(localStorage.getItem(key)), context) ?? { commands: [], cursor: 0 }; }
  catch { return { commands: [], cursor: 0 }; }
}

/** 管理一个来源的编辑生命周期；仅服务端认可的操作进入历史和本地草稿，几何违规可继续编辑但不能保存。 */
export function useLayoutRefinement(jobId, candidateId) {
  const [source, setSource] = useState(null), [history, setHistory] = useState({ commands: [], cursor: 0 });
  const [verified, setVerified] = useState(null), [transient, updateTransient] = useState(null);
  const [previewQueue, setPreviewQueue] = useState([]), queuedCommands = useRef([]);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [storageError, setStorageError] = useState('');
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [pending, setPending] = useState(false);
  const [retryToken, setRetryToken] = useState(0), [retryable, setRetryable] = useState(false);
  const generation = useRef(0), session = useRef(0), savePending = useRef(false), alive = useRef(true);
  const historyRef = useRef(history), verifiedRef = useRef(null), validationClient = useRef(null);
  const pendingCount = useRef(0), failedCommands = useRef(null);
  const key = draftKey(jobId, candidateId);
  const context = source?.key === key ? source.context : null, job = source?.key === key ? source.job : null;
  const activeSource = useRef(null); activeSource.current = context ? source : null;
  const commands = useMemo(() => history.commands.slice(0, history.cursor), [history]);
  const commandKey = JSON.stringify(commands), dirty = history.cursor > 0;

  /** 同步引用和渲染状态，防止同一事件循环内的连续动作读取旧历史。 */
  function accept(nextHistory, result) {
    const checked = { key: JSON.stringify(nextHistory.commands.slice(0, nextHistory.cursor)), result };
    historyRef.current = nextHistory; verifiedRef.current = checked;
    setHistory(nextHistory); setVerified(checked);
  }
  /** 切源或重置时使全部在途动作失效，取消的响应不写入新来源历史。 */
  function cancelOperations() {
    session.current += 1; generation.current += 1;
    validationClient.current?.close().catch(() => {}); validationClient.current = null;
    for (const entry of queuedCommands.current) entry.resolve(false);
    pendingCount.current = 0;
    queuedCommands.current = []; setPreviewQueue([]);
    setPending(false); failedCommands.current = null; setRetryable(false);
  }
  useEffect(() => {
    alive.current = true; cancelOperations();
    const controller = new AbortController();
    setLoading(true); setSource(null); setVerified(null); updateTransient(null); setError(''); setNotice('');
    /** 项目信息先到时即可展示名称；正式上下文到齐前不开放任何编辑。 */
    const jobRequest = getLayoutJob(jobId, controller.signal).then((loadedJob) => {
      if (!controller.signal.aborted) setSource({ key, job: loadedJob, context: null });
      return loadedJob;
    });
    Promise.all([jobRequest, getRefinement(jobId, candidateId, controller.signal)])
      .then(([loadedJob, loaded]) => {
        if (controller.signal.aborted) return;
        const draft = readDraft(key, loaded);
        historyRef.current = draft; verifiedRef.current = { key: '[]', result: loaded };
        setSource({ key, job: loadedJob, context: loaded }); setHistory(draft); setVerified(verifiedRef.current);
      }).catch((failure) => { if (!controller.signal.aborted) setError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { alive.current = false; controller.abort(); session.current += 1; generation.current += 1;
      validationClient.current?.close().catch(() => {}); validationClient.current = null;
      for (const entry of queuedCommands.current) entry.resolve(false); };
  }, [jobId, candidateId]);

  /** 只持久化已接受的日志和撤销游标，尺寸及全部卫星随动由同一条命令重放。 */
  useEffect(() => {
    if (!context) return;
    try {
      if (dirty || history.commands.length) localStorage.setItem(key, JSON.stringify({ ...history, fingerprint: context.source_fingerprint }));
      else localStorage.removeItem(key);
      setStorageError('');
    } catch { setStorageError('浏览器未能保存草稿，请在离开前另存微调版本。'); }
  }, [context, history, key]);

  /** 恢复草稿或撤销重做立即验收；追加动作通过同一会话提交累计状态，不等待停止点击。 */
  useEffect(() => {
    if (!context || verifiedRef.current?.key === commandKey) return undefined;
    if (commandKey === '[]') { accept(historyRef.current, context); setError(''); return undefined; }
    validate(historyRef.current, []);
    return undefined;
  }, [context, commandKey, jobId, candidateId, retryToken]);

  const checked = Boolean(context && verified?.key === commandKey);
  const snapshot = useMemo(() => {
    if (!context) return null;
    const result = previewPendingMotions(verified?.result ?? context, previewQueue.map((entry) => entry.command));
    return transient ? previewCommands(result, [transient]) : result;
  }, [context, verified, transient, previewQueue]);
  const meshState = useLayoutMeshes(jobId, context?.candidate);
  const canSave = Boolean(dirty && checked && !pending && !transient && !error && snapshot?.candidate.validation.valid && !saving);

  /** 立即校核完整最新日志；取消旧请求并以代次保护结果，整个待接受批次只在最新结果到达后写入历史。 */
  async function validate(next, entries) {
    const epoch = session.current, version = ++generation.current, editingSource = source;
    if (!validationClient.current) validationClient.current = createRefinementValidation(
      (body, signal) => previewRefinement(jobId, candidateId, body, signal),
      (sessionId) => cancelRefinementValidation(jobId, candidateId, sessionId));
    pendingCount.current = Math.max(1, entries.length); setPending(true);
    try {
      const result = await validationClient.current.request({ commands: next.commands.slice(0, next.cursor), source_fingerprint: context.source_fingerprint });
      if (epoch !== session.current || version !== generation.current || activeSource.current !== editingSource) return;
      accept(next, result); setError(''); failedCommands.current = null; setRetryable(false);
      const motions = entries.map((entry) => entry.command).filter((command) => command.kind === 'transform');
      const applied = result.applied.slice(-motions.length);
      if (motions.some((command, index) => applied[index] && ['angle', 'height', 'suspension', 'x', 'y'].some((field) => Math.abs((command[field] ?? 0) - (applied[index][field] ?? 0)) > 1e-8)))
        setNotice('已按完整安装区域和来源悬高范围限位；各成员使用同一增量。');
      for (const entry of entries) entry.resolve(true);
    } catch (failure) {
      if (epoch !== session.current || version !== generation.current || failure.name === 'AbortError') return;
      setError(failure.message);
      failedCommands.current = entries.length && (failure.status >= 500 || !failure.status) ? entries.map((entry) => entry.command) : null;
      setRetryable(Boolean(failedCommands.current) || !entries.length);
      for (const entry of entries) entry.resolve(false);
    } finally {
      if (epoch === session.current && version === generation.current) {
        queuedCommands.current = []; setPreviewQueue([]); pendingCount.current = 0; setPending(false);
      }
    }
  }
  /** 将累计普通微调立即提交为最新版本；保留每次动作的撤销边界，尺寸及结构操作仍原子接受。 */
  function executeCommands(additions) {
    if (!context || savePending.current || verifiedRef.current?.key !== JSON.stringify(historyRef.current.commands.slice(0, historyRef.current.cursor))) return Promise.resolve(false);
    const existing = queuedCommands.current;
    if (existing.length && [...existing.map((entry) => entry.command), ...additions].some((command) => command.kind !== 'transform')) return Promise.resolve(false);
    if (historyRef.current.cursor + existing.length + additions.length > context.settings.command_limit) {
      setError('操作数量已达上限，请先保存新版本。'); return Promise.resolve(false);
    }
    const promises = additions.map((command) => new Promise((resolve) => { existing.push({ command, resolve }); }));
    const entries = [...existing]; queuedCommands.current = entries; setPreviewQueue(entries);
    updateTransient(null); setError(''); setNotice('');
    const next = entries.reduce((current, entry) => appendCommand(current, entry.command), historyRef.current);
    validate(next, entries);
    return Promise.all(promises).then((accepted) => accepted.every(Boolean));
  }
  /** 提交一次用户动作；若旧校验在途，新动作立即使其过期并提交所有累计改动。 */
  function execute(command) { return executeCommands([command]); }
  /** 即时拖动使用服务端许可区间，释放后的完整动作仍需正式验收。 */
  function setTransient(command) {
    if (!command) { updateTransient(null); return; }
    if (pendingCount.current || savePending.current || !checked) return;
    updateTransient(limitTransient(verifiedRef.current.result, command));
  }
  /** 撤销或重做完整动作；重新校核期间禁止保存和追加动作。 */
  function travel(delta) {
    if (savePending.current || pendingCount.current) return;
    failedCommands.current = null; setRetryable(false);
    updateTransient(null); setError(''); setNotice('');
    const current = historyRef.current;
    const next = { ...current, cursor: Math.max(0, Math.min(current.commands.length, current.cursor + delta)) };
    historyRef.current = next; setHistory(next);
  }
  /** 恢复来源并清除日志，立即使在途尺寸修改与校核失效，保留相机状态。 */
  function reset() {
    if (!context || savePending.current) return;
    cancelOperations(); updateTransient(null); setError(''); setNotice(''); accept({ commands: [], cursor: 0 }, context);
  }
  /** 网络恢复后重试未接受的动作，或重新校核当前恢复日志。 */
  function retry() {
    const batch = failedCommands.current;
    setError(''); setRetryable(false);
    if (batch) { failedCommands.current = null; executeCommands(batch); }
    else setRetryToken((current) => current + 1);
  }
  /** 保存前再次正式验收；失败保留草稿，成功清除当前来源草稿并返回新版本。 */
  async function save(name) {
    if (!canSave || savePending.current || pendingCount.current) return null;
    const savingSource = source;
    savePending.current = true; setSaving(true); setError('');
    try {
      const result = await saveRefinement(jobId, candidateId, { commands, source_fingerprint: context.source_fingerprint, name });
      try { localStorage.removeItem(key); } catch { /* 已保存成功，清理失败不影响新版本。 */ }
      if (alive.current && activeSource.current === savingSource) { historyRef.current = { commands: [], cursor: 0 }; setHistory(historyRef.current); }
      return result.candidate;
    } catch (failure) { if (alive.current && activeSource.current === savingSource) setError(failure.message); return null; }
    finally { savePending.current = false; if (alive.current) setSaving(false); }
  }
  return { context, job, snapshot, history, execute, travel, reset, transient, setTransient, dirty,
    checked: checked && !transient && !pending, loading, saving, pending, error, notice, storageError, retryable, canSave, save, retry, ...meshState };
}
