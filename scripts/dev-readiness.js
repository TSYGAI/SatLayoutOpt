/**
 * 文件说明：等待受管前端通过 Node IPC 报告资源就绪，供开发编排器区分端口监听与页面可加载。
 * 只管理就绪等待的超时与事件清理；进程启动、停止及浏览器操作由编排器负责。
 */

/** 等待子进程发出 frontend-ready；提前退出、启动失败或超时时拒绝，并清理全部监听器。 */
function waitForFrontendReady(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    /** 完成等待并释放计时器和事件监听器，避免服务生命周期内重复响应。 */
    function finish(error) {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    }
    /** 仅接受前端完成首页预热后发送的明确就绪消息。 */
    function onMessage(message) {
      if (message?.type === 'frontend-ready') finish();
    }
    /** 转发进程启动失败，避免等待到超时才显示原因。 */
    function onError(error) { finish(error); }
    /** 将资源准备阶段的提前退出转换为可诊断错误。 */
    function onExit(code) { finish(new Error(`前端准备完成前已退出（${code}）`)); }
    const timer = setTimeout(() => finish(new Error('前端资源未在预期时间内准备完成')), timeoutMs);
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

module.exports = { waitForFrontendReady };
