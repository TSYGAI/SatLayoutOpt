/** 文件说明：固定约束最近一次三维快照的单槽 CPU 缓存；内存支持切页即取，IndexedDB 支持刷新恢复，正式发布仍由后端负责。 */
import { readPageSession, writePageSession } from '../../app/page-session-state.js';

/** 保留参考尺寸并规范化组字段顺序；任何安装参数差异都不能误用旧矩阵。 */
function signature(groups) {
  return JSON.stringify(groups.map((group) => Object.fromEntries(Object.entries(group).sort(([a], [b]) => a.localeCompare(b)))));
}

/** 单槽存储使用结构化复制保留 TypedArray；浏览器不支持或拒绝存储时直接回退内存。 */
async function access(mode, value) {
  if (!globalThis.indexedDB) return null;
  return new Promise((resolve) => {
    let opening;
    try { opening = indexedDB.open('sat-layout-opt:fixed-view:v1', 1); }
    catch { resolve(null); return; }
    opening.onupgradeneeded = () => opening.result.createObjectStore('preview');
    opening.onerror = () => resolve(null);
    opening.onblocked = () => resolve(null);
    opening.onsuccess = () => {
      const db = opening.result;
      try {
        const transaction = db.transaction('preview', mode);
        const request = mode === 'readonly' ? transaction.objectStore('preview').get('latest')
          : transaction.objectStore('preview').put(value, 'latest');
        let result = null;
        request.onsuccess = () => { result = request.result; };
        transaction.oncomplete = () => { db.close(); resolve(result); };
        transaction.onerror = transaction.onabort = () => { db.close(); resolve(null); };
      } catch { db.close(); resolve(null); }
    };
  });
}

/** 只恢复与服务端当前指纹、尺寸/数量和当前草稿一致的三维数据；不允许过期缓存覆盖新草稿。 */
export async function readFixedView(configKey, fingerprint, groups) {
  const entry = readPageSession('pre-config', 'fixedView') || await access('readonly');
  if (!Array.isArray(entry?.groups) || !Array.isArray(entry?.candidate?.placements) || !entry.meshes
      || !entry.candidate.installation_base || !entry.candidate.fairing_profile
      || entry.candidate.placements.some((item) => !item.space_preview_limits?.installation_vertices?.length)
      || entry.configKey !== configKey || (fingerprint && entry.fingerprint !== fingerprint)
      || (groups && signature(entry.groups) !== signature(groups))) return null;
  writePageSession('pre-config', 'fixedView', entry);
  return entry;
}

/** 只保存一个已完成正式验收的快照；调用方已按统一网格内存预算准备数组，无 GPU 对象入库。 */
export function writeFixedView(configKey, fingerprint, groups, candidate, meshes, opacity) {
  const entry = { configKey, fingerprint, groups, candidate, meshes, opacity };
  writePageSession('pre-config', 'fixedView', entry);
  void access('readwrite', entry);
}
