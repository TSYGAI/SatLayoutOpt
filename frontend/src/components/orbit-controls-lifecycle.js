/**
 * 文件说明：统一释放 Three.js OrbitControls 及其注册在文档根节点上的键盘监听。
 * React 卸载可能先移除画布；本模块通过画布的 ownerDocument 补偿 OrbitControls 对 getRootNode 的依赖。
 */

/**
 * 释放视角控制器，并确保已脱离文档的画布不会留下全局键盘监听。
 * @param {import('three/addons/controls/OrbitControls.js').OrbitControls|null|undefined} controls 需要释放的控制器。
 * @returns {void}
 */
export function disposeOrbitControls(controls) {
  if (!controls) return;
  const ownerDocument = controls.domElement?.ownerDocument;
  if (ownerDocument && typeof controls._interceptControlDown === 'function') {
    ownerDocument.removeEventListener('keydown', controls._interceptControlDown, true);
  }
  if (ownerDocument && typeof controls._interceptControlUp === 'function') {
    ownerDocument.removeEventListener('keyup', controls._interceptControlUp, true);
  }
  controls.dispose();
}
