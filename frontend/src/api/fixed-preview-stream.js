/** 文件说明：读取固定预览的待校验显示帧与正式终态；断流、过期和错误不能被解释为验收通过，保留错误 detail 供中文展示。 */
import { observe } from '../observability/runtime-log.js';

import { monitoredFetch } from '../observability/runtime-log.js';

import { getLayoutMeshConfig, resolveApiUrl } from './model-upload-api.js';

/** 消费有界按行 JSON；显示回调只呈现暂态，唯一 result 才能发布正式结论，返回错误携带状态码。 */
export async function streamFixedPreview(groups, fingerprint, signal, onDisplay) {
  return observe("固定预览与正式校验", {}, () => streamFixedPreviewLogged(...arguments), {signal,long:true});
}

/** 执行固定预览与正式校验；日志边界由同名公开入口管理。 */
async function streamFixedPreviewLogged(groups, fingerprint, signal, onDisplay) {
  const response = await monitoredFetch(await resolveApiUrl('/api/pre-config/fixed-constraints/preview'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, signal,
    body: JSON.stringify({ groups, config_fingerprint: fingerprint, include_meshes: false }),
  });
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    throw Object.assign(new Error(typeof value.detail === 'string' ? value.detail : `固定预览失败（${response.status}）`), { status: response.status, detail: value.detail });
  }
  // 保持旧服务与测试代理的 JSON 响应兼容；同样只接收最终正式结果。
  if (!response.headers.get('content-type')?.includes('application/x-ndjson')) return response.json();
  const limit = (await getLayoutMeshConfig()).downloadMaxBytes;
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = '';
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      text += decoder.decode(value, { stream: !done });
      if (text.length > limit) throw new Error('固定预览响应超过容量预算');
      let end;
      while ((end = text.indexOf('\n')) >= 0) {
        const line = text.slice(0, end); text = text.slice(end + 1);
        if (!line.trim()) continue;
        const frame = JSON.parse(line);
        if (frame.type === 'error') throw Object.assign(new Error(frame.detail), { status: frame.status, detail: frame.detail });
        if (!['display', 'result'].includes(frame.type) || frame.result?.config_fingerprint !== fingerprint) {
          throw new Error('固定预览响应与当前配置不一致');
        }
        if (frame.type === 'result') {
          if (frame.result.candidate?.validation_pending) throw new Error('固定预览缺少正式校验结果');
          return frame.result;
        }
        if (frame.result.candidate?.validation_pending !== true) throw new Error('固定预览暂态标记无效');
        await onDisplay?.(frame.result);
      }
      if (done) throw new Error('固定预览连接中断，尚未完成正式校验');
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
