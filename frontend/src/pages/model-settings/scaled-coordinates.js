/** 文件说明：在缩放后的界面坐标与原始模型坐标之间换算；保持接口和历史数据语义，避免保存或刷新后重复缩放。 */

/** 返回合法正比例；编辑中暂时为空或非法时保留原始数值供用户继续输入。 */
export function coordinateScale(scale) {
  const value = Number(scale);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** 转换坐标输入，保留空值和不完整草稿；抑制浮点显示噪声，不转换角度。 */
export function scaledCoordinate(value, factor) {
  if (value === '' || value == null) return value ?? '';
  const number = Number(value) * factor;
  return Number.isFinite(number) ? Number(number.toPrecision(15)) : value;
}

/** 只缩放坐标系的长度量；欧拉角不变，三点定义的原点和两个参考点同步换算。 */
export function scaledCoordinateFrame(frame, factor) {
  const result = structuredClone(frame);
  for (const point of [result.origin, result.orientation.x_point, result.orientation.xy_point].filter(Boolean)) {
    for (const axis of ['x', 'y', 'z']) point[axis] = scaledCoordinate(point[axis], factor);
  }
  return result;
}
