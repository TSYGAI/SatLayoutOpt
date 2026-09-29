/**
 * 文件说明：读取统一 TOML 配置中的前后端监听参数与前端域名白名单，供 Node.js 启动进程使用。
 * 解析范围限于启动所需字段，业务配置由 Python 后端读取。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 提取 TOML 指定节的文本内容。 */
function readSection(content, name) {
  return content.match(new RegExp(`(?:^|\\n)\\[${name}\\]([\\s\\S]*?)(?=\\n\\[|$)`, 'i'))?.[1] || '';
}

/** 从 TOML 节读取字符串配置。 */
function readString(section, key) {
  return section.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']\\s*$`, 'm'))?.[1];
}

/** 从 TOML 节读取有效整数配置。 */
function readInteger(section, key) {
  const value = Number(section.match(new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)\\s*$`, 'm'))?.[1]);
  return Number.isInteger(value) ? value : undefined;
}

/** 从 TOML 节读取单行主机名字符串数组；缺省时仅使用 Vite 的本机默认规则。 */
function readHostnames(section, key) {
  const value = section.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm'))?.[1];
  if (value === undefined) return [];
  const content = value.match(/^\s*\[\s*(.*?)\s*\]\s*(?:#.*)?$/)?.[1];
  if (content === undefined) throw new Error(`${key} 必须是主机名字符串数组`);
  const hosts = [];
  let remaining = content.trim();
  while (remaining) {
    const item = remaining.match(/^(["'])([^"'\\]+)\1/);
    if (!item || !item[2].split('.').every((part) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(part))) {
      throw new Error(`${key} 必须是主机名字符串数组`);
    }
    hosts.push(item[2]);
    remaining = remaining.slice(item[0].length).trimStart();
    if (!remaining) break;
    if (!remaining.startsWith(',')) throw new Error(`${key} 必须是主机名字符串数组`);
    remaining = remaining.slice(1).trimStart();
  }
  return hosts;
}

/** 读取并校验本地前后端监听配置。 */
function readRuntimeConfig(projectRoot = path.resolve(__dirname, '..')) {
  const content = fs.readFileSync(path.resolve(projectRoot, 'config/sat_layout_opt.toml'), 'utf8');
  const backend = readSection(content, 'backend');
  const frontend = readSection(content, 'frontend');
  const config = {
    backend: { host: readString(backend, 'host'), port: readInteger(backend, 'port') },
    frontend: { host: readString(frontend, 'host'), port: readInteger(frontend, 'port'),
      allowedHosts: readHostnames(frontend, 'allowed_hosts') },
  };
  Object.entries(config).forEach(([name, value]) => {
    if (!value.host || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
      throw new Error(`TOML 配置缺少有效的 ${name}.host 或 ${name}.port`);
    }
  });
  return config;
}

module.exports = { readRuntimeConfig };
