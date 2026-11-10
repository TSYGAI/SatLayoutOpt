/**
 * 文件说明：把后端最新包络任务转换为操作状态、模型显示状态及紧凑进度，批量任务按实际模型 ID 匹配名称。
 * 本模块不启动任务、不轮询网络，也不保存任务历史；后端任务快照是唯一状态来源。
 */

/** 将完整包络生成结果压缩为模型列表和设置页使用的状态。 */
export function compactEnvelopeStatus(envelope) {
  if (!envelope || envelope.state !== 'ready') return null;
  return {
    state: 'ready',
    generated_at: envelope.generated_at,
    algorithm: envelope.algorithm,
    variant_count: envelope.variants?.length ?? envelope.variant_count ?? 0,
  };
}

/** 返回运行中任务对应的按钮操作类型，终态和空闲态返回 null。 */
export function getEnvelopeTaskAction(task) {
  return task?.state === 'running' && ['single', 'all'].includes(task.kind) ? task.kind : null;
}

/** 按任务范围提取当前页进度；models 为可选名称摘要，批量任务只按 current_model_id 匹配，不使用当前选择代替。 */
export function getEnvelopeTaskProgress(task, modelId, submission = null, models = []) {
  if (!modelId) return null;
  if (submission && (submission.kind === 'all' || submission.modelId === modelId)) {
    return { kind: submission.kind, message: '正在保存参数并准备生成包络', percent: 0 };
  }
  if (task?.state !== 'running' || !['single', 'all'].includes(task.kind)
      || task.kind === 'single' && task.model_id !== modelId) return null;
  const value = task.progress?.percent;
  const filename = task.kind === 'all' && task.progress?.current_model_id
    ? models.find((model) => model.id === task.progress.current_model_id)?.filename : null;
  return {
    kind: task.kind,
    message: task.progress?.message || (task.kind === 'all' ? '正在生成全部模型包络' : '正在生成当前模型包络'),
    percent: typeof value === 'number' && Number.isFinite(value) ? Math.floor(Math.max(0, Math.min(99, value))) : null,
    ...(typeof filename === 'string' && filename.trim() ? { currentModelName: filename } : {}),
  };
}

/** 从最新任务中提取指定模型的运行、成功或失败状态；无关模型返回 null。 */
export function getEnvelopeTaskModelStatus(task, modelId) {
  if (!task || !modelId) return null;
  if (task.state === 'running') {
    if (task.kind === 'all') return { state: 'generating-all' };
    return task.kind === 'single' && task.model_id === modelId ? { state: 'generating' } : null;
  }
  if (task.state === 'failed') {
    if (task.kind === 'all' || task.model_id === modelId) return { state: 'error', message: task.error || '后台任务失败' };
    return null;
  }
  if (task.state !== 'succeeded') return null;
  if (task.kind === 'single') {
    return task.model_id === modelId ? compactEnvelopeStatus(task.result) : null;
  }
  const item = task.result?.results?.find((candidate) => candidate.id === modelId);
  return item?.status === 'generated'
    ? compactEnvelopeStatus(item.envelope)
    : item?.status === 'failed' ? { state: 'error', message: item.error || '包络生成失败' } : null;
}
