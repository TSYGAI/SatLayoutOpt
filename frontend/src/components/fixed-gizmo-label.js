/** 文件说明：位置微调箭头使用的世界轴文字纹理；不处理卫星坐标或业务约束。 */
import * as THREE from 'three';

/** 生成方向文字纹理；纹理由调用方持有并在控件卸载时释放。 */
export function labelTexture(text) {
  const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 64;
  const context = canvas.getContext('2d');
  context.fillStyle = 'rgba(8, 20, 30, 0.85)'; context.fillRect(0, 0, 128, 64);
  context.font = 'bold 38px sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle';
  context.fillStyle = '#ffffff'; context.fillText(text, 64, 34);
  return new THREE.CanvasTexture(canvas);
}
