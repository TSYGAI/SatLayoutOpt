/**
 * 文件说明：按需加载 Three.js WebGPU 渲染器与节点宽线，供公共预览渲染控制器使用。
 * 负责材质关联资源先于渲染器释放，支持业务缓存跨场景复用；不管理业务数据，WebGL 路径不会加载本模块。
 */

import { WebGPURenderer, Line2NodeMaterial, Color, NoToneMapping, LinearSRGBColorSpace } from 'three/webgpu';
import { output, renderOutput } from 'three/tsl';
import { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js';

/**
 * 保留原有 WebGL 的逐材质色彩输出顺序，随后在显示色空间混合半透明包络和网格。
 * Three.js 的默认 GPU 输出会在混合后对整幅图做色调映射，改变背景、透明覆盖和 toneMapped=false 的颜色。
 */
class PreviewWebGPURenderer extends WebGPURenderer {
  /** 创建 GPU 渲染器并适配节点材质输出；不修改业务材质的颜色、透明度或灯光。 */
  constructor(parameters) {
    super(parameters);
    this.previewBackground = new Color();
    this.previewMaterials = new Set();
    /** 材质正常释放后取消追踪，避免渲染器持有已经淘汰的模型。 */
    this.onPreviewMaterialDispose = ({ target }) => {
      target.removeEventListener('dispose', this.onPreviewMaterialDispose);
      this.previewMaterials.delete(target);
    };
    const fromMaterial = this.library.fromMaterial.bind(this.library);
    const outputs = new WeakMap();
    /** 为标准与节点材质附加一次色调映射和 sRGB 编码，使 GPU 混合顺序与原有 WebGL 一致。 */
    this.library.fromMaterial = (material) => {
      const nodeMaterial = fromMaterial(material);
      if (nodeMaterial) {
        const toneMapping = material.toneMapped ? this.toneMapping : NoToneMapping;
        let cached = outputs.get(material);
        if (!cached || cached.toneMapping !== toneMapping || cached.colorSpace !== this.outputColorSpace) {
          cached = { toneMapping, colorSpace: this.outputColorSpace, node: renderOutput(output, toneMapping, this.outputColorSpace) };
          outputs.set(material, cached);
        }
        nodeMaterial.outputNode = cached.node;
      }
      return nodeMaterial;
    };
  }

  /** 材质已独立完成色调映射，跳过默认整幅画面的第二次映射。 */
  get currentToneMapping() {
    return NoToneMapping;
  }

  /** 材质已独立完成输出编码，跳过默认整幅画面的第二次色空间转换。 */
  get currentColorSpace() {
    return LinearSRGBColorSpace;
  }

  /** 记录实际绘制材质，包括已移出场景的缓存模型；参数和绘制行为沿用 Three.js 的公开接口。 */
  renderObject(object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId) {
    const renderedMaterial = material.allowOverride && scene.overrideMaterial ? scene.overrideMaterial : material;
    if (!this.previewMaterials.has(renderedMaterial)) {
      this.previewMaterials.add(renderedMaterial);
      renderedMaterial.addEventListener('dispose', this.onPreviewMaterialDispose);
    }
    return super.renderObject(object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId);
  }

  /**
   * 先释放全部已绘制材质的 GPU 关联，再销毁渲染器；材质与几何的 CPU 数据仍可用于下一次渲染。
   * Three.js 0.180 清空节点缓存时不会解绑缓存模型上的材质监听，顺序颠倒会在后续删除时访问失效的 usedTimes。
   */
  dispose() {
    for (const material of [...this.previewMaterials]) material.dispose();
    super.dispose();
  }

  /** 以原有显示色清屏，并在绘制后恢复场景背景引用；不改变主题状态或持久化配色。 */
  render(scene, camera) {
    const background = scene.background;
    if (background?.isColor) scene.background = this.previewBackground.copy(background).convertLinearToSRGB();
    try {
      return super.render(scene, camera);
    } finally {
      scene.background = background;
    }
  }
}

/** 创建待异步初始化的 WebGPU 渲染器；参数与 Three.js 的渲染器选项一致。 */
export function createRenderer(parameters) {
  return new PreviewWebGPURenderer(parameters);
}

/** 使用既有宽线几何创建 WebGPU 描边；返回值由宿主负责释放，线宽保持与 WebGL 一致。 */
export function createWideLine(geometry, parameters) {
  return new LineSegments2(geometry, new Line2NodeMaterial(parameters));
}
