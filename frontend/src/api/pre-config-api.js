/**
 * 文件说明：前置配置页的 API 客户端，封装卫星数量与自定义整流舱段的读取、保存与构建请求。
 * 复用模型 API 的统一配置读取与错误转换，页面层不直接拼接后端地址；前置配置页不提供构件下载。
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
 * 保存整流舱段尺寸区间、中轴半径与整流罩半径，并按区间最小值构建 B-Rep 构件。
 * @param {number} minRadiusMm 圆柱段底面半径最小值，单位为毫米。
 * @param {number} maxRadiusMm 圆柱段底面半径最大值，单位为毫米。
 * @param {number} minHeightMm 圆柱段高度最小值，单位为毫米。
 * @param {number} maxHeightMm 圆柱段高度最大值，单位为毫米。
 * @param {number} axisRadiusMm 中轴（中心杆）半径，单位为毫米。
 * @param {number} fairingRadiusMm 整流罩半径，单位为毫米。
 * @param {AbortSignal} [signal] 可选的取消信号。
 */
export async function saveCustomFairingSegment(
  minRadiusMm,
  maxRadiusMm,
  minHeightMm,
  maxHeightMm,
  axisRadiusMm,
  fairingRadiusMm,
  signal,
) {
  return requestJson('/api/pre-config/fairing-segment', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      min_radius_mm: minRadiusMm,
      max_radius_mm: maxRadiusMm,
      min_height_mm: minHeightMm,
      max_height_mm: maxHeightMm,
      axis_radius_mm: axisRadiusMm,
      fairing_radius_mm: fairingRadiusMm,
    }),
    signal,
  });
}
