/**
 * 文件说明：模型页面与 Three.js 控制器之间的轻量加载边界，页面挂载后才请求三维模块。
 * 缓存模块与在途加载；已加载时同步接管场景，保留控制器既有内存和磁盘缓存策略。
 */

/** 创建可取消挂载的模块加载器；导入失败可重试，卸载后不允许迟到模块操作下一页 DOM。 */
export function createPreviewLoader(importController) {
  let controller = null;
  let pending = null;

  /** 复用已完成或在途的模块请求；失败时清除在途引用，以便用户重试。 */
  function load() {
    if (!pending) pending = Promise.resolve().then(importController).then((module) => {
      controller = module;
      return module;
    }).catch((error) => {
      pending = null;
      throw error;
    });
    return pending;
  }

  /** 挂载指定页面并通知局部加载状态；返回同步清理函数，不取消其他页面共享的模块请求。 */
  function mount(method, onStateChange, options = {}) {
    let disposed = false;
    let unmount = null;
    /** 当前页面仍存在时才挂载；已缓存的控制器保持同步，避免错过场景接管窗口。 */
    function attach(module) {
      if (disposed) return;
      unmount = module[method](options);
      onStateChange({ status: 'ready', message: '' });
    }
    /** 将模块或同步挂载错误限制在当前预览区域，菜单和页面外壳仍可使用。 */
    function fail(error) {
      if (!disposed) onStateChange({ status: 'error', message: error.message });
    }
    onStateChange({ status: 'loading', message: '' });
    if (controller) {
      try { attach(controller); } catch (error) { fail(error); }
    } else void load().then(attach).catch(fail);
    return () => {
      disposed = true;
      unmount?.();
    };
  }

  /** 仅转发给已加载控制器；加载期间无模型可编辑，忽略空状态同步而不触发额外导入。 */
  function invoke(method, ...args) {
    return controller?.[method](...args);
  }

  return { mount, invoke };
}

const loader = createPreviewLoader(() => import('./model-upload-page.js'));

/** 页面显示后加载上传控制器；通过回调通知局部状态，返回页面卸载清理函数。 */
export function mountModelUploadPage(onStateChange, options = {}) {
  return loader.mount('mountModelUploadPage', onStateChange, options);
}

/** 页面显示后加载设置控制器；命中模块缓存时同步恢复原有场景。 */
export function mountModelSettingsPage(onStateChange) {
  return loader.mount('mountModelSettingsPage', onStateChange);
}

/** 向已加载预览应用设置，未选择模型时返回 undefined。 */
export function applyCurrentModelPreviewSettings(settings, options) {
  return loader.invoke('applyCurrentModelPreviewSettings', settings, options);
}

/** 更新坐标系编辑预览；null 表示退出编辑并恢复当前生效设置。 */
export function setCoordinateFrameDraft(frame) { return loader.invoke('setCoordinateFrameDraft', frame); }

/** 切换已加载预览的安装面拾取；返回控制器的异步结果或未加载时的 undefined。 */
export function setInstallationFacePicking(enabled) {
  return loader.invoke('setInstallationFacePicking', enabled);
}

/** 同步安全包络上下文；初次加载前的空状态不触发 Three.js 导入。 */
export function setCurrentModelEnvelopePreview(context) {
  return loader.invoke('setCurrentModelEnvelopePreview', context);
}
