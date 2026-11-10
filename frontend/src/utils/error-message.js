/** 文件说明：整理可展示的错误原因，兼容旧记录中的 Python 调用栈；仅处理文案，不修改原始错误或任务数据。 */

/** 从异常或历史正文中提取中文原因，隐藏内部路径、调用栈和未知英文异常；未知错误使用调用方建议。 */
export function formatErrorMessage(error, fallback = '操作未能完成，请查看运行日志。') {
  const detail = error?.detail ?? error?.message ?? error;
  let message = typeof detail === 'string' ? detail.trim() : '';
  if (!message) return fallback;
  const exceptions = [...message.matchAll(/(?:^|\n)[ \t]*(?:[A-Za-z_]\w*\.)*(?:[A-Za-z_]\w*)?(?:Error|Exception|Interrupt|Exit):[ \t]*([^\n]*)/g)];
  if (exceptions.length) message = exceptions.at(-1)[1].trim();
  if (/Traceback|File\s+["']|\n\s+at\s|(?:[A-Z]:[\\/]|\\\\)[^\s]*|\b(?:[\w.]+)(?:Error|Exception)\b/i.test(message)) return fallback;
  if (/failed to fetch|networkerror|network request failed|err_connection|fetch failed/i.test(message)) {
    return '无法连接服务，请检查服务是否正常后重试。';
  }
  if (/out of memory|allocation failed|failed to allocate/i.test(message)) return '可用内存不足，请调整硬件配置后重试。';
  if (!/[\u3400-\u9fff]/.test(message)) return fallback;
  return message;
}
