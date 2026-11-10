/** 文件说明：把后端推荐与当前编辑草稿比较，仅负责展示差异和确认后的合并，不复制资源推荐算法。 */
import { displayValue } from './hardware-config-state.js';

/** 以当前编辑值生成确认清单；文件版本变化时抛出冲突，避免推荐覆盖用户尚未看到的新配置。 */
export function prepareRecommendation(snapshot, draft, recommendation) {
  if (snapshot.revision !== recommendation.revision) {
    const error = new Error('配置文件已变化，请重新读取后再生成推荐；当前编辑已保留。');
    error.status = 409;
    throw error;
  }
  return { ...recommendation, tiers: recommendation.tiers.map((tier) => prepareTier(snapshot, draft, tier)) };
}

/** 分别生成每档与当前草稿的差异，不改变草稿，不在浏览器推算 CPU 或内存策略。 */
function prepareTier(snapshot, draft, tier) {
  const fields = new Map(snapshot.fields.map((field) => [field.key, field]));
  const items = tier.items.flatMap((item) => {
    const field = fields.get(item.key);
    if (!field) throw new Error('推荐包含当前页面不支持的配置项，请更新页面');
    const toDisplay = displayValue(field, item.to);
    const fromDisplay = draft[item.key];
    if (fromDisplay === toDisplay) return [];
    return [{ ...item, module: field.module, label: field.label, unit: field.unit,
      fromDisplay: fromDisplay || '未填写', toDisplay,
      replacesDraft: fromDisplay !== displayValue(field, snapshot.values[item.key]) }];
  });
  return { ...tier, items,
    groups: snapshot.modules.map((module) => ({ ...module, items: items.filter((item) => item.module === module.id) }))
      .filter((module) => module.items.length > 0),
  };
}

/** 只合并用户预览并确认过的字段；其他模块的手动草稿保持原样，不触发保存。 */
export function applyRecommendationToDraft(draft, tier) {
  if (!tier?.available) throw new Error('所选档位当前不可用，请选择可用方案。');
  return { ...draft, ...Object.fromEntries(tier.items.map((item) => [item.key, item.toDisplay])) };
}
