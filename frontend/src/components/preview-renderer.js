/**
 * 文件说明：统一三维预览的后端选择、异步初始化、绘制时尺寸提交、设备故障回退及 GPU 资源释放。
 * 优先按需加载 WebGPU，兼容路径使用原有 WebGLRenderer；稳定的 DOM 容器承载交互，允许更换画布而不丢失事件或相机。
 * 仅适配项目使用的渲染接口，不管理业务模型；配置由统一 TOML 客户端读取。
 */

import { beginOperation, reportError } from '../observability/runtime-log.js';
import * as THREE from 'three';
import { getPreviewRendererConfig } from '../api/model-upload-api.js';

/** 检查安全上下文与浏览器 WebGPU 入口；真实设备可用性仍由异步初始化确定。 */
function supportsWebGPU() {
  return globalThis.isSecureContext === true && Boolean(globalThis.navigator?.gpu);
}

/** 按需加载 GPU 实现，避免兼容模式下载节点渲染器。 */
async function loadWebGPUBackend() {
  return import('./webgpu-preview-backend.js');
}

/** 创建原有 WebGL 渲染器；参数保留各页面现有的抗锯齿、透明背景及性能偏好。 */
function createWebGLRenderer(parameters) {
  return new THREE.WebGLRenderer(parameters);
}

/**
 * 三维预览的公共渲染控制器；domElement 是稳定的交互容器，实际画布位于其内部。
 * 初始化期间合并绘制请求，就绪后绘制最新场景；回退不重新加载模型或重置相机。
 */
export class PreviewRenderer {
  /**
   * 创建渲染控制器并开始初始化；ready 返回最终后端名，无法建立任何后端时返回 null 并记录错误。
   * @param {object} parameters Three.js 选项与可选 onBackendChange 回调；回调负责替换后端专用材质。
   * @param {object} dependencies 可选环境与工厂替身，供隔离生命周期测试使用。
   */
  constructor(parameters = {}, dependencies = {}) {
    const { onBackendChange = null, ...rendererParameters } = parameters;
    this.parameters = { ...rendererParameters, alpha: rendererParameters.alpha ?? false };
    this.onBackendChange = onBackendChange;
    this.dependencies = {
      document: globalThis.document, supportsWebGPU, loadConfig: getPreviewRendererConfig,
      loadWebGPUBackend, createWebGLRenderer, ...dependencies,
    };
    this.domElement = this.dependencies.document.createElement('div');
    Object.assign(this.domElement.style, { width: '100%', height: '100%' });
    this.domElement.dataset.previewRenderer = 'initializing';
    this.outputColorSpace = THREE.SRGBColorSpace;
    this.toneMapping = THREE.NoToneMapping;
    this.toneMappingExposure = 1;
    this.pixelRatio = 1;
    this.width = 1;
    this.height = 1;
    this.renderer = null;
    this.pendingRenderer = null;
    this.backendName = null;
    this.lastFrame = null;
    this.disposed = false;
    this.gpuAttempt = null;
    this.releasedRenderers = new WeakSet();
    this.drawingBufferSizes = new WeakMap();
    this.logOperation = beginOperation('三维预览初始化到首帧');
    this.logOperation.step('初始化渲染后端');
    this.ready = Promise.resolve().then(() => this.initialize());
  }

  /** 读取配置并在时限内尝试 WebGPU；任何失败都启用原有 WebGL，释放后不再挂载画布。 */
  async initialize() {
    try {
      if (this.disposed) return null;
      if (!this.dependencies.supportsWebGPU()) return this.fallback();
      const config = await this.dependencies.loadConfig();
      if (this.disposed) return null;
      if (config.preference === 'webgl') return this.fallback();
      const attempt = { cancelled: false, cancel: null };
      this.gpuAttempt = attempt;
      let timer;
      try {
        await Promise.race([
          this.initializeWebGPU(attempt),
          new Promise((resolve) => { attempt.cancel = resolve; }),
          new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('WebGPU 初始化超时')), config.initTimeoutMs);
          }),
        ]);
        return this.backendName;
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      if (this.disposed) return null;
      return this.fallback(error);
    }
  }

  /** 加载并初始化独立画布上的 GPU 后端，取消或超时后的迟到资源立即释放。 */
  async initializeWebGPU(attempt) {
    const backend = await this.dependencies.loadWebGPUBackend();
    if (this.disposed || attempt.cancelled) return;
    const candidate = backend.createRenderer(this.parameters);
    candidate.previewGPUBackend = candidate.backend;
    this.pendingRenderer = candidate;
    this.syncRenderer(candidate);
    let deviceLost = false;
    /** 设备意外丢失时回退，主动销毁产生的通知不会重新建立渲染器。 */
    candidate.onDeviceLost = (info) => {
      deviceLost = true;
      if (!this.disposed && !attempt.cancelled && this.renderer === candidate) {
        this.fallback(new Error(`WebGPU 设备丢失：${info.message || info.reason || '未知原因'}`));
      }
    };
    try {
      await candidate.init();
      candidate.previewInitialized = true;
      if (this.disposed || attempt.cancelled) return;
      if (deviceLost || !candidate.backend.isWebGPUBackend) throw new Error('WebGPU 设备不可用');
      /** 驱动或 GPU 校验错误发生后切换到兼容后端，避免画布永久停留在损坏状态。 */
      const onGPUError = (event) => {
        if (!this.disposed && this.renderer === candidate) this.fallback(event.error);
      };
      candidate.backend.device?.addEventListener('uncapturederror', onGPUError);
      candidate.previewErrorListener = onGPUError;
      this.activate(candidate, 'webgpu', backend);
    } finally {
      if (this.pendingRenderer === candidate) this.pendingRenderer = null;
      if (this.renderer !== candidate) this.releaseRenderer(candidate);
    }
  }

  /** 在初始化或绘制时同步最终尺寸、DPR 与色彩，避免尺寸修改后等待下一帧时暴露空缓冲区。 */
  syncRenderer(renderer) {
    renderer.outputColorSpace = this.outputColorSpace;
    renderer.toneMapping = this.toneMapping;
    renderer.toneMappingExposure = this.toneMappingExposure;
    const previous = this.drawingBufferSizes.get(renderer);
    if (previous?.width === this.width && previous.height === this.height && previous.pixelRatio === this.pixelRatio) return;
    // Three.js 重设画布尺寸会清空画面并重建附属纹理；尺寸和 DPR 一次提交，相同值无需重复分配。
    renderer.setDrawingBufferSize(this.width, this.height, this.pixelRatio);
    this.drawingBufferSizes.set(renderer, { width: this.width, height: this.height, pixelRatio: this.pixelRatio });
  }

  /** 挂载一个已就绪后端，通知材质适配并补绘初始化期间最后请求的场景。 */
  activate(renderer, name, backend = null) {
    if (this.disposed) { this.releaseRenderer(renderer); return; }
    this.syncRenderer(renderer);
    this.onBackendChange?.(name, backend);
    this.renderer = renderer;
    this.backendName = name;
    Object.assign(renderer.domElement.style, { display: 'block', width: '100%', height: '100%' });
    renderer.domElement.dataset.previewRenderer = name;
    const label = this.domElement.getAttribute('aria-label');
    if (label) renderer.domElement.setAttribute('aria-label', label);
    this.domElement.replaceChildren(renderer.domElement);
    this.domElement.dataset.previewRenderer = name;
    if (this.lastFrame) this.render(...this.lastFrame);
  }

  /** 取消 GPU 尝试并换用独立 WebGL 画布；GPU 画布无法复用为 WebGL，事件仍留在稳定容器上。 */
  fallback(error = null) {
    if (this.disposed) return null;
    if (this.gpuAttempt) {
      this.gpuAttempt.cancelled = true;
      this.gpuAttempt.cancel?.();
    }
    if (this.backendName === 'webgl') return 'webgl';
    if (error) reportError(error, 'WARN');
    if (error) console.warn('三维预览已自动回退 WebGL：', error.message || error);
    const previous = this.renderer;
    this.renderer = null;
    this.releaseRenderer(previous);
    let renderer;
    try {
      renderer = this.dependencies.createWebGLRenderer(this.parameters);
      this.activate(renderer, 'webgl');
      return 'webgl';
    } catch (failure) {
      this.releaseRenderer(renderer);
      this.renderer = null;
      this.backendName = null;
      this.domElement.dataset.previewRenderer = 'unavailable';
      this.logOperation?.finish(failure);
      console.error('无法初始化三维预览渲染器：', failure);
      return null;
    }
  }

  /** 返回当前像素比，兼容原有交互质量调节逻辑。 */
  getPixelRatio() {
    return this.pixelRatio;
  }

  /** 保存下一次绘制所需的像素比，保留可见上一帧；由宿主沿用既有按需绘制调度。 */
  setPixelRatio(value) {
    if (this.disposed) return;
    this.pixelRatio = value;
  }

  /** 合并下一次绘制所需的逻辑尺寸；仅容器样式可立即更新，实际缓冲区与新帧一起提交。 */
  setSize(width, height, updateStyle = true) {
    if (this.disposed) return;
    this.width = width;
    this.height = height;
    if (updateStyle) Object.assign(this.domElement.style, { width: `${width}px`, height: `${height}px` });
  }

  /** 渲染最新场景；GPU 同步错误自动回退，兼容后端错误保留原来的异常行为。 */
  render(scene, camera) {
    if (this.disposed) return;
    this.lastFrame = [scene, camera];
    if (!this.renderer) return;
    // WebGPU 使用 0..1 深度范围；回退时必须恢复 WebGL 投影，保证显示与 CPU 射线拾取一致。
    const coordinateSystem = this.backendName === 'webgpu' ? THREE.WebGPUCoordinateSystem : THREE.WebGLCoordinateSystem;
    if (camera.coordinateSystem !== coordinateSystem) {
      camera.coordinateSystem = coordinateSystem;
      camera.updateProjectionMatrix();
    }
    try {
      this.syncRenderer(this.renderer);
      this.renderer.render(scene, camera);
      if (this.logOperation) {
        const operation = this.logOperation; this.logOperation = null;
        (globalThis.requestAnimationFrame || ((callback) => callback()))(() => operation.finish(null, {backend:this.backendName, boundary:'首次提交后的浏览器帧'}));
      }
    } catch (error) {
      if (this.backendName !== 'webgpu') throw error;
      this.fallback(error);
    }
  }

  /** 释放渲染资源、错误监听、GPU 设备及 WebGL 上下文；不得销毁业务场景。 */
  releaseRenderer(renderer) {
    if (!renderer || this.releasedRenderers.has(renderer)) return;
    this.releasedRenderers.add(renderer);
    const gpuBackend = renderer.previewGPUBackend || renderer.backend;
    const device = gpuBackend?.device;
    if (renderer.previewErrorListener) device?.removeEventListener('uncapturederror', renderer.previewErrorListener);
    // Three.js 未完成初始化时 dispose 会再次启动 init，产生未处理的拒绝；此时只释放已经分配的底层资源。
    if (!renderer.isWebGPURenderer || renderer.previewInitialized) renderer.dispose();
    else renderer.backend?.gl?.getExtension('WEBGL_lose_context')?.loseContext();
    renderer.forceContextLoss?.();
    if (device) {
      gpuBackend.context?.unconfigure();
      device.destroy();
    }
    renderer.domElement.remove();
  }

  /** 幂等释放公共控制器；正在初始化的后端由其完成回调释放，不得迟到挂载。 */
  dispose() {
    if (this.disposed) return;
    this.logOperation?.finish(new DOMException('预览已释放','AbortError'));
    this.disposed = true;
    if (this.gpuAttempt) {
      this.gpuAttempt.cancelled = true;
      this.gpuAttempt.cancel?.();
    }
    this.releaseRenderer(this.renderer);
    this.renderer = null;
    this.lastFrame = null;
    this.onBackendChange = null;
  }

  /** 兼容宿主原有释放调用；GPU 后端由 dispose 释放设备，WebGL 可显式丢失上下文。 */
  forceContextLoss() {
    this.renderer?.forceContextLoss?.();
  }
}
