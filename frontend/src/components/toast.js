/**
 * 文件说明：全局轻量提示条，向前置配置、模型上传、模型设置和数据管理等功能页提供统一反馈。
 * 提示内容写入各功能页约定的 `#toast` 占位节点，本模块不持有页面状态，可被任意页面复用。
 */

let toastTimer = null;

/**
 * 显示一条短暂提示，并在超时后自动隐藏。
 * @param {string} message 提示文本。
 * @param {boolean} error 为真时使用错误配色。
 * @param {{ centered?: boolean }} [options] 可选展示位置；centered 用于需要居中反馈的页面操作。
 */
export function showToast(message, error = false, options = {}) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast${error ? ' error' : ''}${options.centered ? ' toast-centered' : ''}`;
  toast.hidden = false;
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 3600);
}
