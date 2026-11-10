/** 文件说明：硬件设置的显示单位转换和增量比较；不复制后端的跨字段业务校验。 */

import { formatParameterNumber } from '../../utils/number-format.js';

/** 将配置原值换算为易读输入字符串，保留足够精度以免未修改字段发生变化。 */
export function displayValue(field, value) {
  return field.kind === 'select' ? String(value) : String(Number((value / field.scale).toPrecision(12)));
}

/** 根据后端字段目录生成表单草稿；草稿保持字符串以支持清空和编辑中的小数。 */
export function createDraft(snapshot) {
  return Object.fromEntries(snapshot.fields.map((field) => [field.key, displayValue(field, snapshot.values[field.key])]));
}

/** 返回实际变更的原始配置值；空输入保留 null，由浏览器和后端明确拒绝。 */
export function changesFromDraft(snapshot, draft) {
  if (!snapshot) return {};
  const baseline = createDraft(snapshot);
  return Object.fromEntries(snapshot.fields.filter((field) => draft[field.key] !== baseline[field.key]).map((field) => {
    const raw = draft[field.key];
    const value = field.kind === 'select' ? raw : raw?.trim() ? Number((Number(raw) * field.scale).toPrecision(15)) : null;
    return [field.key, value];
  }));
}

/** 格式化内存总量为 GiB，未知值明确显示尚不可用。 */
export function formatMemory(bytes) {
  return Number.isFinite(bytes) ? `${formatParameterNumber(bytes / 1024 ** 3)} GiB` : '暂不可用';
}
