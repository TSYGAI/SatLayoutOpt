/**
 * 文件说明：页面位置会话缓存工具，负责按路由保存和恢复窗口及标记滚动容器的位置。
 * 缓存使用 sessionStorage，仅在当前浏览器标签页会话内保留，并对存储异常静默降级。
 */

const STORAGE_KEY_PREFIX = 'sat-layout-opt:page-position:v1:';

/** 返回当前页面在会话缓存中的稳定键。 */
function getStorageKey(pathname = window.location.pathname, search = window.location.search) {
  return `${STORAGE_KEY_PREFIX}${pathname}${search}`;
}

/** 安全读取某个路由的位置快照。 */
function readPagePosition(pathname, search) {
  try {
    const raw = window.sessionStorage.getItem(getStorageKey(pathname, search));
    if (!raw) return null;
    const snapshot = JSON.parse(raw);
    return snapshot && typeof snapshot === 'object' ? snapshot : null;
  } catch {
    return null;
  }
}

/** 收集窗口和带有 data-scroll-position-key 的滚动容器位置。 */
function collectPagePosition() {
  const elements = {};
  document.querySelectorAll('[data-scroll-position-key]').forEach((element) => {
    const key = element.dataset.scrollPositionKey;
    if (!key) return;
    elements[key] = { top: element.scrollTop, left: element.scrollLeft };
  });
  return {
    window: { top: window.scrollY, left: window.scrollX },
    elements,
  };
}

/** 保存当前路由的位置快照，sessionStorage 不可用时保持页面功能不受影响。 */
export function savePagePosition(pathname = window.location.pathname, search = window.location.search) {
  try {
    window.sessionStorage.setItem(getStorageKey(pathname, search), JSON.stringify(collectPagePosition()));
  } catch {
    // 隐私模式或存储空间不足时忽略缓存，不影响页面交互。
  }
}

/** 恢复当前路由的位置快照，可按需只恢复页面内滚动容器。 */
export function restorePagePosition(
  pathname = window.location.pathname,
  search = window.location.search,
  { restoreWindow = true, restoreElements = true } = {},
) {
  const snapshot = readPagePosition(pathname, search);
  if (!snapshot) return false;
  if (restoreWindow && Number.isFinite(snapshot.window?.left) && Number.isFinite(snapshot.window?.top)) {
    window.scrollTo(snapshot.window.left, snapshot.window.top);
  }
  if (restoreElements && snapshot.elements && typeof snapshot.elements === 'object') {
    document.querySelectorAll('[data-scroll-position-key]').forEach((element) => {
      const position = snapshot.elements[element.dataset.scrollPositionKey];
      if (!position) return;
      if (Number.isFinite(position.left)) element.scrollLeft = position.left;
      if (Number.isFinite(position.top)) element.scrollTop = position.top;
    });
  }
  return true;
}
