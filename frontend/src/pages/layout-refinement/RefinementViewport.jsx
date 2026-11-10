/** 文件说明：封装微调视口生命周期、放大入口与显示设置；四视图共享草稿和不可变来源轮廓。 */
import { useEffect, useRef, useState } from 'react';
import { getLayoutPreviewConfig, getModulePreviewConfig } from '../../api/model-upload-api.js';
import { Maximize2 } from '../../components/icons.js';

/** 创建单一方向视口；卸载、模型换源或初始化失败时释放全部资源。 */
export function RefinementViewport({ mode, state, selection, tool, callbacks, radialSegments, fitToken, focusToken, display, onMaximize }) {
  const container = useRef(null), labels = useRef(null), viewer = useRef(null), latest = useRef(null);
  const [error, setError] = useState('');
  latest.current = { state, selection, tool, callbacks, display };
  const source = state.context?.source_fingerprint;
  useEffect(() => {
    if (!state.meshes || !state.snapshot) return undefined;
    let disposed = false;
    setError('');
    Promise.all([import('./refinement-viewer.js'), getLayoutPreviewConfig(), getModulePreviewConfig()])
      .then(([module, style, quality]) => {
        if (disposed) return;
        const current = latest.current;
        const control = module.createRefinementViewer({ container: container.current, labels: labels.current, mode,
          candidate: current.state.snapshot.candidate, source: current.state.context.candidate, meshes: current.state.meshes,
          satellites: current.state.job?.locked_config?.satellites, radialSegments, style,
          pixelRatio: quality.preConfigPixelRatioCap,
          callbacks: {
            /** 点击或标签选择始终由页面按组合规则解析。 */
            select: (id) => latest.current.callbacks.select(id),
            /** 开始拖动时由页面检查锁定和组合并返回完整成员。 */
            dragStart: (id) => latest.current.callbacks.dragStart(id),
            /** 更新瞬时命令，不增加撤销记录。 */
            drag: (command) => latest.current.callbacks.drag(command),
            /** 释放时提交一次动作或取消瞬时状态。 */
            dragEnd: (command) => latest.current.callbacks.dragEnd(command),
          } });
        viewer.current = control;
        control.update(current.state.snapshot.candidate, current.selection, current.state.checked, current.tool);
        control.setDisplay(current.display);
        if (import.meta.env.DEV) container.current.__refinementViewer = control;
      }).catch((failure) => { if (!disposed) setError(failure.message); });
    return () => { disposed = true; viewer.current?.dispose(); viewer.current = null; };
  }, [mode, state.meshes, source, radialSegments]);
  useEffect(() => { if (state.snapshot) viewer.current?.update(state.snapshot.candidate, selection, state.checked, tool); }, [state.snapshot, selection, state.checked, tool]);
  useEffect(() => { viewer.current?.fit(); }, [fitToken]);
  useEffect(() => { viewer.current?.locate(); }, [focusToken]);
  useEffect(() => { viewer.current?.setDisplay(display); }, [display]);
  const name = { '3d': '空间视图', xy: '俯视 XY', xz: '正视 XZ', yz: '侧视 YZ' }[mode];
  return <div className="refinement-view" data-refinement-view={mode}>
    <div className="refinement-view-name"><span>{name}</span>{onMaximize && <button type="button" aria-label={`放大${name}`} onClick={onMaximize}><Maximize2 aria-hidden="true" />放大</button>}</div><div ref={container} className="refinement-canvas" aria-label={`${name}布局画布`} />
    <div ref={labels} className="refinement-labels" />
    {(state.meshLoading || error) && <p className="refinement-view-message" role="status">{error || '正在读取历史正式包络…'}</p>}
  </div>;
}
