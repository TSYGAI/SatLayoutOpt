/**
 * 文件说明：封装三维预览交互期间的动态像素比决策，不直接依赖 DOM 或 Three.js。
 * 页面控制器负责提供帧间隔并把返回的像素比应用到渲染器。
 */

export const DEFAULT_PREVIEW_QUALITY_CONFIG = Object.freeze({
  interactionPixelRatio: 1,
  interactionMinPixelRatio: 0.65,
  idlePixelRatioCap: 1.5,
  idleDelayMs: 180,
  slowFrameMs: 20,
  fastFrameMs: 14,
});

/** 创建模型预览 LOD 状态；该状态只描述决策，不持有 Three.js 或 DOM 对象。 */
export function createPreviewTransitionState(config, devicePixelRatio = 1) {
  return {
    modelId: null,
    interactionReady: false,
    detailReady: false,
    isInteracting: false,
    awaitingIdle: false,
    activeQuality: null,
    pixelRatio: Math.min(Math.max(Number(devicePixelRatio) || 1, 0.25), config.idlePixelRatioCap),
  };
}

/** 根据加载和交互事件计算下一预览状态，供页面控制器与单元测试共同使用。 */
export function transitionPreviewState(current, event, config) {
  const next = { ...current };
  const idlePixelRatio = Math.min(
    Math.max(Number(event.devicePixelRatio) || 1, 0.25),
    config.idlePixelRatioCap,
  );
  switch (event.type) {
    case 'select-model':
      return {
        ...createPreviewTransitionState(config, event.devicePixelRatio),
        modelId: event.modelId || null,
      };
    case 'interaction-ready':
      next.interactionReady = true;
      next.activeQuality = next.isInteracting || !next.detailReady ? 'interaction' : 'detail';
      break;
    case 'detail-ready':
      next.detailReady = true;
      next.activeQuality = next.isInteracting && next.interactionReady ? 'interaction' : 'detail';
      break;
    case 'interaction-start':
      next.isInteracting = true;
      next.awaitingIdle = false;
      next.activeQuality = next.interactionReady ? 'interaction' : next.detailReady ? 'detail' : null;
      next.pixelRatio = config.interactionPixelRatio;
      break;
    case 'interaction-end':
      next.awaitingIdle = true;
      break;
    case 'idle':
      next.isInteracting = false;
      next.awaitingIdle = false;
      next.activeQuality = next.detailReady ? 'detail' : next.interactionReady ? 'interaction' : null;
      next.pixelRatio = idlePixelRatio;
      break;
    case 'interaction-failed':
      next.interactionReady = false;
      next.activeQuality = next.detailReady ? 'detail' : null;
      break;
    case 'detail-failed':
      next.detailReady = false;
      next.activeQuality = next.interactionReady ? 'interaction' : null;
      break;
    default:
      throw new Error(`未知预览质量事件：${event.type}`);
  }
  return next;
}

/** 约束来自 TOML 的预览质量参数，避免异常配置导致渲染器不可用。 */
export function normalizePreviewQualityConfig(value = {}) {
  const number = (key, fallback) => Number.isFinite(Number(value[key])) ? Number(value[key]) : fallback;
  const interactionPixelRatio = Math.max(number('interactionPixelRatio', 1), 0.25);
  return {
    interactionPixelRatio,
    interactionMinPixelRatio: Math.min(
      interactionPixelRatio,
      Math.max(number('interactionMinPixelRatio', 0.65), 0.25),
    ),
    idlePixelRatioCap: Math.max(number('idlePixelRatioCap', 1.5), 0.25),
    idleDelayMs: Math.max(Math.round(number('idleDelayMs', 180)), 0),
    slowFrameMs: Math.max(number('slowFrameMs', 20), 1),
    fastFrameMs: Math.max(number('fastFrameMs', 14), 1),
  };
}

/** 创建一次交互会话使用的连续快慢帧计数状态。 */
export function createInteractionQualityState(config) {
  return {
    pixelRatio: config.interactionPixelRatio,
    slowFrames: 0,
    fastFrames: 0,
  };
}

/** 根据一帧间隔更新交互像素比，返回是否需要调整渲染器。 */
export function recordInteractionFrame(qualityState, durationMs, config) {
  const previousRatio = qualityState.pixelRatio;
  if (durationMs > config.slowFrameMs) {
    qualityState.slowFrames += 1;
    qualityState.fastFrames = 0;
    if (qualityState.slowFrames >= 8) {
      qualityState.pixelRatio = Math.max(
        config.interactionMinPixelRatio,
        Math.round((qualityState.pixelRatio - 0.1) * 100) / 100,
      );
      qualityState.slowFrames = 0;
    }
  } else if (durationMs < config.fastFrameMs) {
    qualityState.fastFrames += 1;
    qualityState.slowFrames = 0;
    if (qualityState.fastFrames >= 30) {
      qualityState.pixelRatio = Math.min(
        config.interactionPixelRatio,
        Math.round((qualityState.pixelRatio + 0.1) * 100) / 100,
      );
      qualityState.fastFrames = 0;
    }
  } else {
    qualityState.slowFrames = 0;
    qualityState.fastFrames = 0;
  }
  return qualityState.pixelRatio !== previousRatio;
}
