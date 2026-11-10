/** 文件说明：将任务状态、实际候选和累计预算转换为阶段路径及运行记录，失败原因仅归入对应阶段并过滤旧调用栈；不推断求解可行性或剩余耗时。 */

import { JOB_LABELS } from './layout-state.js';
import { formatErrorMessage } from '../../utils/error-message.js';

/** 读取可靠的非负整数；旧记录缺失或异常时返回空，避免将未知计数显示为零。 */
function knownCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** 读取当前快照的验收数量；完整候选列表优先于历史摘要及进度字段，不包含人工微调版本。 */
function acceptedCount(job) {
  if (Array.isArray(job?.candidates)) return job.candidates.length;
  return knownCount(job?.candidate_count) ?? knownCount(job?.progress?.returned_count)
    ?? knownCount(job?.progress?.valid_count);
}

/** 格式化任务状态；详情以实际候选列表计数，历史摘要使用服务端数量，缺失时不虚构数字。 */
export function layoutJobStatusLabel(job) {
  const label = JOB_LABELS[job?.status] ?? '任务状态未知';
  if (job?.status !== 'completed') return label;
  const count = Array.isArray(job.candidates) ? job.candidates.length : job.candidate_count;
  return Number.isSafeInteger(count) && count >= 0 ? `${count} 组布局已验收` : label;
}

/** 生成当前任务展示状态；兼容旧任务缺少阶段或摘要，只在有搜索证据时展示尝试数与运行记录。 */
export function layoutJobPresentation(job) {
  const progress = job?.progress ?? {};
  const searched = progress.phase === 'search' || progress.attempts > 0 || progress.radius_count > 0
    || job?.candidates?.length > 0;
  const validating = ['queued', 'running'].includes(job?.status)
    && (['prepare', 'validate', 'validation_failed'].includes(progress.phase) || !searched);
  const validationFailed = job?.status === 'infeasible'
    && (progress.phase === 'validation_failed' || !searched);
  let title = layoutJobStatusLabel(job);
  let message = progress.message || '';
  if (validating) {
    title = '正在校验数据';
    message = progress.phase === 'validation_failed' ? '正在检查其余允许的设置' : message || '正在读取锁定模型和配置';
  } else if (validationFailed) {
    title = formatErrorMessage(progress.validation_summary || job.error, '数据校验未通过，请查看运行日志。');
    message = searched ? '数据校验未通过，请根据具体原因调整设置。' : '数据校验未通过，尚未开始布局搜索。';
  } else if (job?.status === 'infeasible') {
    title = progress.termination_reason === 'attempt_limit' ? '达到尝试上限，未找到布局' : '搜索结束，未找到可行布局';
  }
  const events = (job?.events ?? []).filter((event) => typeof event.message === 'string' && event.message.trim())
    .map((event) => ({ ...event, message: event.message.trim(),
      timeLabel: Number.isFinite(Date.parse(event.time)) ? new Date(event.time).toLocaleTimeString() : '' }));
  return { title, message, showSearchDetails: searched && !validating, events, searched, validating, validationFailed };
}

/** 生成任务的阶段路径；完成和取消不强制补满预算，只有后端明确结束搜索时才进入结果整理。 */
export function layoutJobProgressView(job) {
  const presentation = layoutJobPresentation(job);
  const { searched, validating, validationFailed } = presentation;
  const progress = job?.progress ?? {};
  const status = job?.status;
  const attempts = knownCount(progress.attempts);
  const recordedTotal = knownCount(progress.round_attempt_limit);
  const total = recordedTotal > 0 ? recordedTotal : null;
  const percent = attempts !== null && total !== null
    ? attempts >= total ? 100 : Math.min(99.9, Math.round(attempts / total * 1000) / 10)
    : null;
  const count = acceptedCount(job);
  const stopped = ['cancelled', 'interrupted'].includes(status);
  const failed = status === 'failed';
  const terminal = stopped || failed || ['completed', 'infeasible'].includes(status);
  const settling = status === 'running' && !validating && progress.search_stage === 'complete';
  const validation = { id: 'validation', label: '配置校验', state: 'pending', status: '待开始', message: '' };
  const search = { id: 'search', label: '布局搜索', state: 'pending', status: '待开始', message: '' };
  const result = { id: 'result', label: '结果整理', state: 'pending', status: '待开始', message: '' };

  if (validationFailed) {
    Object.assign(validation, { state: 'error', status: '未通过', message: presentation.title });
  } else if (validating) {
    Object.assign(validation, { state: 'active', status: searched ? '重新校验' : '进行中', message: presentation.message });
  } else if (['prepare', 'validate', 'validation_failed'].includes(progress.phase) && (stopped || failed || status === 'cancelling')) {
    Object.assign(validation, { state: failed ? 'error' : 'stopped', status: failed ? '失败' : status === 'cancelling' ? '正在停止' : '已停止' });
  } else if (searched || status === 'completed') {
    Object.assign(validation, { state: 'done', status: '已通过' });
  } else if (stopped || failed || status === 'cancelling') {
    Object.assign(validation, { state: failed ? 'error' : 'stopped', status: failed ? '失败' : '已停止' });
  }

  const validationError = failed && validation.state === 'error';
  if (validationError) validation.message = formatErrorMessage(job.error || presentation.message, '配置校验异常结束，请查看运行日志。');

  if (searched) {
    if (validating) Object.assign(search, { state: 'pending', status: '等待校验' });
    else if (validationFailed || validationError || stopped) Object.assign(search, { state: 'stopped', status: '已停止' });
    else if (failed) Object.assign(search, { state: 'error', status: '异常结束', message: formatErrorMessage(job.error || presentation.message, '布局搜索异常结束，请查看运行日志。') });
    else if (terminal || settling) Object.assign(search, { state: 'done', status: '已结束', message: status === 'infeasible' ? presentation.title : '' });
    else Object.assign(search, { state: 'active', status: status === 'cancelling' ? '正在停止' : '进行中', message: status === 'cancelling' ? '' : presentation.message });
  }

  if (status === 'completed' || (terminal && count > 0)) {
    Object.assign(result, { state: 'done', status: status === 'completed' ? '已整理' : '已保留' });
  } else if (terminal) {
    Object.assign(result, { state: 'stopped', status: count === 0 ? '无验收布局' : '已结束' });
  } else if (settling || status === 'cancelling') {
    Object.assign(result, { state: 'active', status: status === 'cancelling' ? '正在保留' : '整理中' });
  } else if (searched) result.status = '待整理';

  const statusLabel = status === 'cancelling' ? '正在取消' : validating ? '校验中' : validationFailed ? '校验未通过'
    : settling ? '整理中' : ({ running: '优化中', completed: '已完成', cancelled: '已取消',
      interrupted: '已中断', failed: '任务失败', infeasible: '搜索结束' }[status] ?? '状态未知');
  const tone = validationFailed || failed || status === 'infeasible' ? 'error'
    : stopped ? 'stopped' : status === 'completed' ? 'done' : 'active';
  return { ...presentation, attempts, total, percent, count, statusLabel, tone, steps: [validation, search, result] };
}
