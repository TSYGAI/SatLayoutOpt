/** 文件说明：硬件设置页的读取、编辑与乐观并发保存；失败保留草稿，过期请求不覆盖当前状态。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getHardwareConfig, getHardwareRecommendation, saveHardwareConfig } from '../../api/hardware-config-api.js';
import { changesFromDraft, createDraft } from './hardware-config-state.js';
import { prepareRecommendation, applyRecommendationToDraft } from './hardware-recommendation-state.js';

/** 管理页面草稿及运行快照；返回读写动作与状态，保存不会自动重启服务。 */
export function useHardwareConfig() {
  const [snapshot, setSnapshot] = useState(null);
  const [draft, setDraft] = useState({});
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const [recommendation, setRecommendation] = useState(null);
  const [recommendationStatus, setRecommendationStatus] = useState('idle');
  const request = useRef(null);
  const alive = useRef(true);
  const saving = useRef(false);
  const recommendationRequest = useRef(null);
  const recommending = useRef(false);
  const changes = changesFromDraft(snapshot, draft);
  const dirty = Object.keys(changes).length > 0;

  /** 主动重新读取；仅成功响应才替换草稿，网络失败保留现有编辑。 */
  const reload = useCallback(async () => {
    if (saving.current || recommending.current) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setStatus('loading'); setError(''); setMessage('');
    try {
      const value = await getHardwareConfig(controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      setSnapshot(value); setDraft(createDraft(value)); setConflict(false);
    } catch (reason) {
      if (alive.current && !controller.signal.aborted) setError(reason.message);
    } finally {
      if (alive.current && !controller.signal.aborted) setStatus('ready');
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    reload();
    return () => {
      alive.current = false;
      request.current?.abort();
      recommendationRequest.current?.abort();
    };
  }, [reload]);

  /** 编辑单个输入，仅修改本地草稿，不自动写文件。 */
  function edit(key, value) {
    setDraft((current) => ({ ...current, [key]: value })); setMessage('');
  }

  /** 撤销未保存的编辑，恢复最近读取的磁盘值，不改变已保存配置。 */
  function discard() {
    if (snapshot) setDraft(createDraft(snapshot));
    setError(''); setMessage('');
  }

  /** 点击后读取硬件推荐；请求期间不修改当前草稿，失败保留用户编辑。 */
  async function loadRecommendation() {
    if (!snapshot || saving.current || recommending.current || status !== 'ready') return;
    recommending.current = true;
    recommendationRequest.current?.abort();
    const controller = new AbortController();
    recommendationRequest.current = controller;
    setRecommendationStatus('loading'); setStatus('recommending'); setError(''); setMessage('');
    try {
      const value = await getHardwareRecommendation(controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      setRecommendation(prepareRecommendation(snapshot, draft, value));
      setRecommendationStatus('ready');
    } catch (reason) {
      if (alive.current && !controller.signal.aborted) {
        setError(reason.message); setConflict(reason.status === 409); setRecommendationStatus('idle');
      }
    } finally {
      recommending.current = false;
      if (alive.current && !controller.signal.aborted) setStatus('ready');
    }
  }

  /** 关闭推荐预览，不改变当前草稿和配置文件。 */
  function closeRecommendation() {
    setRecommendation(null); setRecommendationStatus('idle');
  }

  /** 将用户确认的推荐合并到本地草稿；版本变化时拒绝覆盖并要求重新读取。 */
  function applyRecommendation(tierId) {
    if (!snapshot || !recommendation) return false;
    const tier = recommendation.tiers.find((item) => item.id === tierId);
    if (!tier?.available) return false;
    if (snapshot.revision !== recommendation.revision) {
      setError('配置在生成推荐后已发生变化，请重新读取后再生成推荐。');
      setConflict(true);
      closeRecommendation();
      return false;
    }
    setDraft((current) => applyRecommendationToDraft(current, tier));
    setMessage(`推荐已应用到未保存草稿（${tier.label} ${Math.round(tier.fraction * 100)}%），请检查差异后点击“保存配置”。`);
    closeRecommendation();
    return true;
  }

  /** 保存全部模块的增量；409 保留用户输入并要求明确重新读取，失败不标记已保存。 */
  async function save() {
    if (!snapshot || !dirty || saving.current || recommending.current) return false;
    saving.current = true; setStatus('saving'); setError(''); setMessage('');
    try {
      const value = await saveHardwareConfig(snapshot.revision, changes);
      if (!alive.current) return false;
      setSnapshot(value); setDraft(createDraft(value)); setConflict(false);
      setMessage(value.restart_required ? '配置已保存。请在任务结束后重启应用，使这些设置统一生效。' : '配置已保存，与当前运行值一致。');
      return true;
    } catch (reason) {
      if (alive.current) { setError(reason.message); setConflict(reason.status === 409); }
      return false;
    } finally {
      saving.current = false;
      if (alive.current) setStatus('ready');
    }
  }

  return {
    snapshot, draft, changes, dirty, status, error, message, conflict,
    recommendation, recommendationStatus, reload, edit, discard, save,
    loadRecommendation, closeRecommendation, applyRecommendation,
  };
}
