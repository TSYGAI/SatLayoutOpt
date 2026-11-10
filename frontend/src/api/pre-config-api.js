/**
 * 文件说明：前置配置 API 客户端，封装卫星数量、软硬对称和整流舱段的读取、保存与构建请求。
 * 复用模型 API 的统一配置读取与错误转换；形态设置按统一请求对象提交，不维护旧位置参数或重复组装轮廓。
 */

import { requestJson } from './model-upload-api.js';

/** 读取前置配置页的当前配置、卫星类型清单与取值范围约束。 */
export async function getPreConfig(signal) {
  return requestJson('/api/pre-config/config', { signal, cache: 'no-store' });
}

/**
 * 保存某一类卫星的数量。
 * @param {string} recordId 数据管理页中的固化记录标识。
 * @param {number} value 该类卫星的数量。
 * @param {AbortSignal} [signal] 可选的取消信号。
 */
export async function saveSatelliteCount(recordId, value, signal) {
  return requestJson('/api/pre-config/satellite-count', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ record_id: recordId, value }),
    signal,
  });
}

/**
 * 保存整流罩外形与独立安装筒设置；共通半径、段序列和外形边界由服务端统一派生。
 * @param {object} payload 已校验的形态与安装筒请求体。
 * @param {AbortSignal} [signal] 可选的取消信号。
 */
export async function saveCustomFairingSegment(payload, signal) {
  return requestJson('/api/pre-config/fairing-segment', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
}

/**
 * 保存某类卫星的对称开关和模式，返回服务端确认的卫星配置；失败交由调用方展示。
 * @param {string} recordId 固化模型标识。
 * @param {boolean} enabled 是否启用两两对称。
 * @param {'hard'|'soft'} mode 硬约束或软约束。
 * @param {AbortSignal} [signal] 可选取消信号。
 */
export async function saveSatelliteSymmetry(recordId, enabled, mode, signal) {
  return requestJson('/api/pre-config/satellite-symmetry', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ record_id: recordId, enabled, mode }),
    signal,
  });
}
