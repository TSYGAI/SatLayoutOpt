/**
 * 文件说明：数据管理页的包络预览面板，负责加载提示、独立聚焦按钮和悬浮大窗交互。
 * Three.js 控制器由页面管理；通过回调移动同一画布，保留模型资源、旋转与缩放状态。
 */

import { useCallback, useEffect, useId, useRef } from 'react';
import { Box, Crosshair, GitBranch, LoaderCircle, Maximize2, X } from '../../components/icons.js';

/** 展示包络及悬浮大窗；回调负责绑定或移动画布与聚焦模型，本组件仅管理弹窗及焦点恢复。 */
export function StoredEnvelopePreview({ detail, previewState, bindPreviewContainer, onFitView, onToggleTopologyEdges,
  topologyEdgesVisible, onMovePreview }) {
  const inlineContainerRef = useRef(null);
  const expandedContainerRef = useRef(null);
  const dialogRef = useRef(null);
  const expandButtonRef = useRef(null);
  const closeButtonRef = useRef(null);
  const previousOverflowRef = useRef('');
  const titleId = useId();
  const descriptionId = useId();

  /** 保留小窗容器并交给页面初始化控制器；卸载时同步通知页面释放资源。 */
  const bindInlineContainer = useCallback((element) => {
    inlineContainerRef.current = element;
    bindPreviewContainer(element);
  }, [bindPreviewContainer]);

  /** 将原画布移回面板，恢复背景滚动与展开按钮焦点；未打开时不产生副作用。 */
  const closePreview = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog?.open) return;
    onMovePreview(inlineContainerRef.current);
    dialog.close();
    document.body.style.overflow = previousOverflowRef.current;
    if (expandButtonRef.current?.isConnected) expandButtonRef.current.focus({ preventScroll: true });
  }, [onMovePreview]);

  /** 捕获节点以便在 React 卸载 ref 后仍能关闭大窗、恢复画布与背景滚动。 */
  useEffect(() => {
    const dialog = dialogRef.current;
    const container = inlineContainerRef.current;
    return () => {
      if (!dialog.open) return;
      onMovePreview(container);
      dialog.close();
      document.body.style.overflow = previousOverflowRef.current;
    };
  }, [detail.recordId, onMovePreview]);

  /** 在浏览器顶层展示大窗并复用已有画布；保留相机状态且不重新请求包络。 */
  function openPreview() {
    const dialog = dialogRef.current;
    if (previewState.state !== 'ready' || dialog.open) return;
    previousOverflowRef.current = document.body.style.overflow;
    dialog.showModal();
    document.body.style.overflow = 'hidden';
    onMovePreview(expandedContainerRef.current);
    closeButtonRef.current.focus();
  }

  /** 接管原生 Esc 关闭事件，确保画布、滚动和焦点同步恢复。 */
  function cancelPreview(event) {
    event.preventDefault();
    closePreview();
  }

  /** 仅当点击面板外遮罩时关闭，避免旋转画布或点击面板留白误触。 */
  function backdropClick(event) {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom) closePreview();
  }

  return (
    <section className="data-management-panel data-management-preview-panel" aria-labelledby="stored-envelope-title">
      <div className="data-management-panel-heading">
        <h3 id="stored-envelope-title"><Box aria-hidden="true" />包络预览</h3>
        <span className={`data-management-status${detail.envelope.state === 'ready' ? ' is-ready' : ''}`}>
          <span aria-hidden="true" />
          {detail.envelope.state === 'ready' ? '已生成' : detail.envelope.state}
        </span>
      </div>
      <div className="data-management-preview">
        <div ref={bindInlineContainer} className="data-management-preview-canvas" />
        {previewState.state === 'ready' ? (
          <div className="data-management-preview-tools">
            <button type="button" onClick={onFitView} title="聚焦模型" aria-label="聚焦模型">
              <Crosshair aria-hidden="true" />
            </button>
            <button type="button" className={topologyEdgesVisible ? 'is-active' : undefined}
              onClick={onToggleTopologyEdges} title={topologyEdgesVisible ? '隐藏拓扑边线' : '显示拓扑边线'}
              aria-label={topologyEdgesVisible ? '隐藏拓扑边线' : '显示拓扑边线'} aria-pressed={topologyEdgesVisible}>
              <GitBranch aria-hidden="true" />
            </button>
            <button ref={expandButtonRef} type="button" onClick={openPreview} title="放大包络预览"
              aria-label="放大包络预览" aria-haspopup="dialog">
              <Maximize2 aria-hidden="true" />
            </button>
          </div>
        ) : (
          <div className="data-management-preview-overlay" aria-live="polite">
            {previewState.state === 'loading' && <LoaderCircle className="spinning" aria-hidden="true" />}
            <span>
              {previewState.state === 'error'
                ? `包络预览加载失败：${previewState.message}`
                : previewState.state === 'unavailable'
                  ? previewState.message
                  : '正在加载包络预览'}
            </span>
          </div>
        )}
      </div>
      <div className="data-management-preview-caption">
        <span>生成于 {detail.envelope.generatedAtText}</span>
        <span>拖动旋转 · 滚轮缩放</span>
      </div>
      <dialog ref={dialogRef} className="data-management-preview-dialog" aria-labelledby={titleId}
        aria-describedby={descriptionId} aria-modal="true" onCancel={cancelPreview} onClick={backdropClick}>
        <header className="data-management-preview-dialog-header">
          <div>
            <h2 id={titleId}><Box aria-hidden="true" />包络预览</h2>
            <p>{detail.deviceName}</p>
          </div>
          <button ref={closeButtonRef} className="data-management-preview-close" type="button"
            onClick={closePreview} title="关闭包络预览" aria-label="关闭包络预览">
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="data-management-preview">
          <div ref={expandedContainerRef} className="data-management-preview-canvas" />
          <div className="data-management-preview-tools">
            <button type="button" onClick={onFitView} title="聚焦模型" aria-label="聚焦模型">
              <Crosshair aria-hidden="true" />
            </button>
            <button type="button" className={topologyEdgesVisible ? 'is-active' : undefined}
              onClick={onToggleTopologyEdges} title={topologyEdgesVisible ? '隐藏拓扑边线' : '显示拓扑边线'}
              aria-label={topologyEdgesVisible ? '隐藏拓扑边线' : '显示拓扑边线'} aria-pressed={topologyEdgesVisible}>
              <GitBranch aria-hidden="true" />
            </button>
          </div>
        </div>
        <div id={descriptionId} className="data-management-preview-caption">
          <span>生成于 {detail.envelope.generatedAtText}</span>
          <span>拖动旋转 · 滚轮缩放 · Esc 关闭</span>
        </div>
      </dialog>
    </section>
  );
}
