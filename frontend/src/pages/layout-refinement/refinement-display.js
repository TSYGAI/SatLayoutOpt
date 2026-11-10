/** 文件说明：管理微调预览独立于布局历史的实体、卫星名称与辅助标记可见性；不参与业务校核或持久化。 */

/** 返回新的默认显示状态；切换来源时恢复实体、选中卫星名称与辅助标记，来源轮廓默认关闭。 */
export function createRefinementDisplay() {
  return { original: false, fairing: true, tube: true, base: true, satelliteNames: true, centerOfMass: true, axes: true, hiddenIds: [] };
}

/** 按实例集合统计全部、部分或均未显示，用于成员、嵌套组合及全部卫星的统一控件。 */
export function objectVisibility(ids, hiddenIds) {
  const hidden = new Set(hiddenIds), visibleCount = ids.filter((id) => !hidden.has(id)).length;
  return { visibleCount, all: ids.length > 0 && visibleCount === ids.length, some: visibleCount > 0 };
}

/** 返回变更后的显示状态；未指定目标时，有可见成员则整组隐藏，否则整组恢复，不修改原状态。 */
export function setObjectVisibility(display, ids, visible = !objectVisibility(ids, display.hiddenIds).some) {
  const hidden = new Set(display.hiddenIds);
  for (const id of ids) { if (visible) hidden.delete(id); else hidden.add(id); }
  return { ...display, hiddenIds: [...hidden] };
}
