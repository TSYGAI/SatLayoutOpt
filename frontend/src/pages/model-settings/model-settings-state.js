/**
 * 文件说明：规范化含曲面安装点、固定/自由向上轴及六向包络增量的模型设置，并计算预览变换。
 * 本模块不访问 DOM 或后端；后端仍是设置校验与持久化的最终权威。
 */

import { Euler, Vector3 } from 'three';
import { buildSafetyClearancePayload, normalizeSafetyClearance } from './model-safety-clearance-state.js';

export const MODEL_SETTINGS_SELECTION_EVENT = 'sat-layout-model-settings-selection';
export const UP_ORIENTATIONS = Object.freeze(['free', '+X', '-X', '+Y', '-Y', '+Z', '-Z']);

const UNIT_TO_MILLIMETERS = Object.freeze({ mm: 1, cm: 10, m: 1000 });
const VALID_ROTATIONS = new Set([0, 90, 180, 270]);
const STEP_FACE_ID_PATTERN = /^FACE_\d{5}$/;

/** 将后端或表单中的可空质心转换为三轴受控值。 */
function normalizeCenterOfMass(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return null;
  return {
    x: values.x ?? '',
    y: values.y ?? '',
    z: values.z ?? '',
  };
}

/** 将后端或拾取事件中的可空 STEP 源坐标安装点转换为三轴受控值。 */
function normalizeInstallationPoint(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return null;
  return {
    x: values.x ?? '',
    y: values.y ?? '',
    z: values.z ?? '',
  };
}

/** 将后端设置转换为完整表单；向上轴向沿用 front_orientation 存储字段，不参与预览旋转。 */
export function normalizeModelSettings(values = {}) {
  return {
    device_name: typeof values.device_name === 'string' ? values.device_name : '',
    mass: values.mass ?? '',
    model_scale: values.model_scale ?? 1,
    model_unit: UNIT_TO_MILLIMETERS[values.model_unit] ? values.model_unit : 'mm',
    rotation_x: VALID_ROTATIONS.has(Number(values.rotation_x)) ? Number(values.rotation_x) : 0,
    rotation_y: VALID_ROTATIONS.has(Number(values.rotation_y)) ? Number(values.rotation_y) : 0,
    rotation_z: VALID_ROTATIONS.has(Number(values.rotation_z)) ? Number(values.rotation_z) : 0,
    front_orientation: values.front_orientation ?? '+Z',
    center_of_mass: normalizeCenterOfMass(values.center_of_mass),
    installation_face_id: typeof values.installation_face_id === 'string' ? values.installation_face_id : null,
    installation_point: normalizeInstallationPoint(values.installation_point),
    safety_clearance_mm: normalizeSafetyClearance(values.safety_clearance_mm),
  };
}

/** 将表单值转换为后端 PUT 接口需要的完整设置，并在客户端提供即时错误提示。 */
export function buildModelSettingsPayload(values) {
  const normalized = normalizeModelSettings(values);
  const deviceName = normalized.device_name.trim();
  const mass = normalized.mass === '' || normalized.mass === null ? null : Number(normalized.mass);
  const modelScale = Number(normalized.model_scale);
  const centerValues = normalized.center_of_mass
    ? [normalized.center_of_mass.x, normalized.center_of_mass.y, normalized.center_of_mass.z]
    : ['', '', ''];
  const emptyCenterAxes = centerValues.filter((value) => value === '' || value === null || value === undefined).length;
  let centerOfMass = null;
  if (!deviceName || deviceName.length > 200) throw new Error('设备名称必须为 1 至 200 个字符');
  if (!UP_ORIENTATIONS.includes(normalized.front_orientation)) {
    throw new Error('向上轴向必须是 +X、-X、+Y、-Y、+Z、-Z 或自由');
  }
  if (mass !== null && (!Number.isFinite(mass) || mass < 0 || mass > 1_000_000_000_000)) {
    throw new Error('质量必须是 0 至 1000000000000 kg 的有限数值');
  }
  if (!Number.isFinite(modelScale) || modelScale < 0.0001 || modelScale > 1_000_000) {
    throw new Error('模型比例必须是 0.0001 至 1000000 之间的有限数值');
  }
  if (emptyCenterAxes !== 0 && emptyCenterAxes !== 3) throw new Error('质心 X、Y、Z 坐标必须同时填写或全部留空');
  if (emptyCenterAxes === 0) {
    const coordinates = centerValues.map(Number);
    if (!coordinates.every(Number.isFinite)) throw new Error('质心 X、Y、Z 坐标必须是有限数值');
    centerOfMass = { x: coordinates[0], y: coordinates[1], z: coordinates[2] };
  }
  if (normalized.installation_face_id !== null && !STEP_FACE_ID_PATTERN.test(normalized.installation_face_id)) {
    throw new Error('安装面 ID 格式无效，请重新选择安装面');
  }
  let installationPoint = null;
  if (normalized.installation_point) {
    const rawPoint = [normalized.installation_point.x, normalized.installation_point.y, normalized.installation_point.z];
    if (rawPoint.some((value) => value === '' || value === null || value === undefined)) {
      throw new Error('安装点 X、Y、Z 坐标必须完整');
    }
    const coordinates = rawPoint.map(Number);
    if (!coordinates.every(Number.isFinite)) throw new Error('安装点 X、Y、Z 坐标必须是有限数值');
    installationPoint = { x: coordinates[0], y: coordinates[1], z: coordinates[2] };
  }
  if (normalized.installation_face_id === null && installationPoint !== null) {
    throw new Error('未选择安装面时不能设置安装点');
  }
  return {
    ...normalized,
    device_name: deviceName,
    mass,
    model_scale: modelScale,
    center_of_mass: centerOfMass,
    installation_point: installationPoint,
    safety_clearance_mm: buildSafetyClearancePayload(normalized.safety_clearance_mm),
  };
}

/** 计算以毫米为场景基准的统一缩放和 XYZ 欧拉旋转弧度。 */
export function getModelPreviewTransform(values) {
  const normalized = normalizeModelSettings(values);
  const modelScale = Number(normalized.model_scale);
  if (!Number.isFinite(modelScale) || modelScale <= 0) return null;
  const radians = Math.PI / 180;
  return {
    scale: modelScale * UNIT_TO_MILLIMETERS[normalized.model_unit],
    rotation: [
      normalized.rotation_x * radians,
      normalized.rotation_y * radians,
      normalized.rotation_z * radians,
    ],
  };
}

/** 计算质心经过当前单位、比例和 XYZ 旋转后的预览世界坐标。 */
export function getCenterOfMassPreviewPosition(values) {
  const normalized = normalizeModelSettings(values);
  const center = normalized.center_of_mass;
  if (!center || [center.x, center.y, center.z].some((value) => value === '' || !Number.isFinite(Number(value)))) return null;
  const transform = getModelPreviewTransform(normalized);
  if (!transform) return null;
  return new Vector3(Number(center.x), Number(center.y), Number(center.z))
    .multiplyScalar(transform.scale)
    .applyEuler(new Euler(...transform.rotation, 'XYZ'))
    .toArray();
}

/** 比较两份设置的规范化业务值是否完全一致。 */
export function areModelSettingsEqual(left, right) {
  try {
    return JSON.stringify(buildModelSettingsPayload(left)) === JSON.stringify(buildModelSettingsPayload(right));
  } catch {
    return false;
  }
}
