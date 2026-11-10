/** 文件说明：选中模型两侧的旋转按钮按当前相机视角保持屏幕顺逆时针；只换算点击方向和投影位置，安装轴、姿态及正式校验由固定约束流程负责。 */
import { Vector3 } from 'three';

/** 将屏幕逆时针换算为世界安装法向的角度符号；透视按安装点视线、正交按平行视线判断，正侧视或缺数据返回0供调用方保留方向。 */
export function screenMountRotationSign(camera, normal, point) {
  if (!camera || !normal?.every(Number.isFinite) || normal.length !== 3) return 0;
  const axis = new Vector3().fromArray(normal);
  if (!axis.lengthSq()) return 0;
  const towardCamera = new Vector3();
  camera.updateWorldMatrix(true, false);
  if (camera.isPerspectiveCamera) {
    if (!point?.every(Number.isFinite) || point.length !== 3) return 0;
    camera.getWorldPosition(towardCamera).sub(new Vector3().fromArray(point));
  } else camera.getWorldDirection(towardCamera).negate();
  if (!towardCamera.lengthSq()) return 0;
  const facing = axis.normalize().dot(towardCamera.normalize());
  return Math.abs(facing) > Number.EPSILON ? Math.sign(facing) : 0;
}

/** 创建可键盘访问的顺逆时针按钮；调用方负责每帧更新相机投影并在预览卸载时释放。 */
export function createFixedMountRotationControls(container, onRotate) {
  const layer = document.createElement('div');
  layer.className = 'fixed-mount-rotation-controls'; layer.hidden = true;
  let selection = null, bounds = null, spacing = 0, viewCamera = null, viewSign = 1;
  const buttons = [
    { sign: 1, text: '↶', name: '逆时针' },
    { sign: -1, text: '↷', name: '顺时针' },
  ].map(({ sign, text, name }) => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'fixed-mount-rotation-button';
    /** 按钮独占按下事件，避免画布取消选择或启动相机拖动。 */
    function down(event) { event.stopPropagation(); }
    /** 点击时重新读取当前相机，按屏幕方向发布安装轴角度符号；正侧视沿用最近可辨认方向，按键触发保持原生行为。 */
    function click(event) {
      event.stopPropagation();
      if (!selection || button.disabled) return;
      viewSign = screenMountRotationSign(viewCamera, selection.installationFaceNormal, selection.installationPoint) || viewSign;
      onRotate({ instanceId: selection.instanceId, groupId: selection.groupId, sign: sign * viewSign });
    }
    button.addEventListener('pointerdown', down);
    button.addEventListener('click', click);
    layer.append(button);
    return { button, name, text, down, click };
  });
  container.append(layer);
  return {
    /** 设置当前实例及其世界包围盒；未选中时隐藏，等待新模型基准时禁用按钮。 */
    show(value, worldBounds, step, enabled, sizePx) {
      if (value?.instanceId !== selection?.instanceId || value?.groupId !== selection?.groupId) viewSign = 1;
      selection = value; bounds = worldBounds; spacing = sizePx;
      layer.hidden = !value;
      if (!value) return;
      for (const { button, name, text } of buttons) {
        button.textContent = `${text} ${step}°`;
        button.setAttribute('aria-label', `${name}旋转 ${step}°`);
        button.title = `按当前视角，${name}旋转 ${step}°`;
        button.disabled = !enabled;
      }
    },
    /** 将模型世界包围盒投影到屏幕两侧；随视角及缩放更新，屏幕边缘保持按钮可点击。 */
    update(camera, width, height) {
      viewCamera = camera;
      if (!selection || !bounds || !width || !height) return;
      viewSign = screenMountRotationSign(camera, selection.installationFaceNormal, selection.installationPoint) || viewSign;
      const center = bounds.getCenter(new Vector3()).project(camera);
      layer.hidden = center.z < -1 || center.z > 1;
      if (layer.hidden) return;
      let left = Infinity, right = -Infinity;
      for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
        const point = new Vector3(x, y, z).project(camera);
        const screenX = (point.x + 1) * width / 2;
        left = Math.min(left, screenX); right = Math.max(right, screenX);
      }
      const centerX = (center.x + 1) * width / 2;
      const top = Math.max(24, Math.min(height - 24, (1 - center.y) * height / 2));
      const positions = [Math.min(left, centerX - spacing) - 16, Math.max(right, centerX + spacing) + 16];
      buttons.forEach(({ button }, index) => {
        const buttonWidth = button.offsetWidth;
        const target = positions[index] - (index === 0 ? buttonWidth : 0);
        button.style.left = `${Math.max(8, Math.min(width - buttonWidth - 8, target))}px`;
        button.style.top = `${top}px`;
      });
    },
    /** 释放按钮事件和 DOM；不修改场景、草稿或模型几何。 */
    dispose() {
      for (const { button, down, click } of buttons) {
        button.removeEventListener('pointerdown', down); button.removeEventListener('click', click);
      }
      layer.remove(); selection = null; bounds = null; viewCamera = null;
    },
  };
}
