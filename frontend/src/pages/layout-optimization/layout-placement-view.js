/** 文件说明：依据快照中的安装位置为装载明细生成排序副本，先侧挂层次、后顶部，同层按安装高度排列；不计算几何约束或改写候选数据。 */

/** 读取安装区域下缘的全局高度，旧快照依次回退到安装点和安装面中心；缺失时置于同层末尾，不用质心或包络高度替代。 */
function installationHeight(placement) {
  return [placement.installation_region_bottom_mm, placement.installation_point_mm?.[2], placement.installation_face_center_mm?.[2]]
    .find(Number.isFinite) ?? Infinity;
}

/** 返回从低层到高层、顶部最后的展示副本；同层按安装高度升序，相同高度保持原顺序，缺层号的侧挂卫星排在已知侧挂层之后。 */
export function sortPlacementsForDisplay(placements) {
  return [...placements].sort((a, b) => {
    const mountOrder = Number(a.mount === 'top') - Number(b.mount === 'top');
    if (mountOrder) return mountOrder;
    if (a.mount !== 'top') {
      const layerOrder = (Number.isFinite(a.layer) ? a.layer : Infinity) - (Number.isFinite(b.layer) ? b.layer : Infinity);
      if (layerOrder) return layerOrder;
    }
    return installationHeight(a) - installationHeight(b) || 0;
  });
}
