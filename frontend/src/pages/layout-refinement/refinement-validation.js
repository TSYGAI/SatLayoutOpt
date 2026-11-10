/** 文件说明：为实时校验请求分配会话与递增版本，新请求立即替代旧请求；后端按身份中断计算，前端拒绝迟到结果，不管理业务历史。 */

/** 创建来源专属的校验通道；预览和关闭由 API 层注入，便于验证乱序和取消，不使用输入防抖。 */
export function createRefinementValidation(preview, close) {
  const sessionId = crypto.randomUUID();
  let revision = 0, controller = null, closed = false;
  return {
    /** 立即提交完整最新状态，并在新版本到来后取消旧 HTTP 等待；旧计算由后端会话版本负责取消。 */
    async request(body) {
      if (closed) throw new DOMException('校验会话已关闭', 'AbortError');
      controller?.abort();
      const current = new AbortController(), version = ++revision;
      controller = current;
      const result = await preview({ ...body, validation: { session_id: sessionId, revision: version } }, current.signal);
      if (closed || current.signal.aborted || version !== revision) throw new DOMException('校验已被最新状态替代', 'AbortError');
      return result;
    },
    /** 关闭会话时同时通知后端停止计算；只发送一次，调用方可等待关闭响应或处理失败。 */
    close() {
      if (closed) return Promise.resolve();
      closed = true; controller?.abort();
      return close(sessionId);
    },
  };
}
