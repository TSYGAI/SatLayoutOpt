/**
 * 文件说明：保存当前应用会话的页面业务状态，独立于 React 页面挂载和三维资源生命周期。
 * 按页面和字段隔离，支持 Set、TypedArray 等内存数据；不保存 DOM、请求控制器或 GPU 对象，不替代后端持久化。
 */

import { useMemo, useSyncExternalStore } from 'react';

const sessions = new Map();

/** 获取一个稳定字段槽；初始化函数只在本次会话首次访问时执行，返回值由调用方按不可变数据更新。 */
function field(page, key, initial) {
  if (!sessions.has(page)) sessions.set(page, new Map());
  const values = sessions.get(page);
  if (!values.has(key)) {
    let value = typeof initial === 'function' ? initial() : initial;
    const listeners = new Set();
    values.set(key, {
      /** 返回当前快照，同值读取不创建新引用。 */
      read: () => value,
      /** 同步写入或基于最新值更新；页面卸载后的已确认业务结果仍可保存。 */
      write(next) {
        const updated = typeof next === 'function' ? next(value) : next;
        if (Object.is(value, updated)) return;
        value = updated;
        listeners.forEach((notify) => notify());
      },
      /** 订阅当前字段，返回只取消该订阅的清理函数。 */
      subscribe(notify) { listeners.add(notify); return () => listeners.delete(notify); },
    });
  }
  return values.get(key);
}

/** 读取命令式控制器的会话字段；缺失时以给定默认值初始化。 */
export function readPageSession(page, key, initial = null) {
  return field(page, key, initial).read();
}

/** 写入命令式控制器的会话字段并同步已挂载的 React 订阅者。 */
export function writePageSession(page, key, value) {
  field(page, key, null).write(value);
}

/** 提供与 useState 相同的读取与更新形式；同一页面重新挂载时立即复用已有快照。 */
export function usePageSessionState(page, key, initial) {
  const slot = useMemo(() => field(page, key, initial), [page, key]);
  return [useSyncExternalStore(slot.subscribe, slot.read, slot.read), slot.write];
}
