/**
 * 文件说明：将后端当前会话的性能配置覆盖到构建期 TOML，保证生产包与桌面重启后读取真实运行值。
 * 只替换 frontend 节已有键；404 兼容旧后端，其他故障明确失败，不把待重启值冒充已生效值。
 */
import { monitoredFetch } from '../observability/runtime-log.js';

/** 获取当前运行的前端性能值并合并到 TOML 文本；不调用依赖配置的业务 API，避免循环加载。 */
export async function mergeHardwareRuntime(content) {
  const section = content.match(/\[frontend\]([\s\S]*?)(?=\r?\n\[|$)/)?.[1] || '';
  const base = section.match(/^\s*api_base_url\s*=\s*["']([^"']+)["']/m)?.[1]?.replace(/\/$/, '');
  if (base === undefined) throw new Error('TOML 配置缺少 frontend.api_base_url');
  const response = await monitoredFetch(`${base}/api/hardware-config/runtime`, { cache: 'no-store' });
  if (response.status === 404) return content;
  if (!response.ok) throw new Error(`运行配置读取失败（${response.status}）`);
  const body = await response.json();
  if (!body.values || typeof body.values !== 'object' || Array.isArray(body.values)) throw new Error('运行配置响应无效');
  let merged = section;
  for (const [key, value] of Object.entries(body.values)) {
    if (!/^frontend\.[a-z][a-z0-9_]*$/.test(key) || !['number', 'string'].includes(typeof value)) {
      throw new Error('运行配置包含无效字段');
    }
    const name = key.slice('frontend.'.length);
    const pattern = new RegExp(`^(\\s*${name}\\s*=)[^\\r\\n]*`, 'm');
    if (!pattern.test(merged)) throw new Error(`前端版本缺少配置项：${name}，请更新前端资源`);
    merged = merged.replace(pattern, (_, prefix) => `${prefix} ${JSON.stringify(value)}`);
  }
  return content.replace(section, () => merged);
}
