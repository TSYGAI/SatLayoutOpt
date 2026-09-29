/**
 * 文件说明：模型上传 React 页面，声明上传、模型库、Three.js 预览和统计区域的稳定 DOM 结构。
 * 现有业务控制器通过固定 ID 挂载，React 负责页面生命周期和公共外壳。
 */

import { useEffect } from 'react';
import {
  Box,
  ChevronRight,
  CloudUpload,
  LoaderCircle,
  RefreshCw,
  Scan,
  Search,
  Trash2,
  Waypoints,
} from 'lucide-react';

import { AppShell } from '../../app/AppShell.jsx';
import { ModelPreviewPanel } from '../../components/ModelPreviewPanel.jsx';
import { mountModelUploadPage } from './model-upload-page.js';
import '../../../styles/model-upload.css';

/** 渲染 STEP/GLB 模型管理与三维预览完整页面。 */
export default function ModelUploadPage() {
  useEffect(() => mountModelUploadPage(), []);

  return (
    <AppShell className="model-page-shell" pageTitle="模型上传" status="连接检查中" statusId="model-connection">
      <main className="model-workspace">
        <aside className="model-sidebar" aria-label="模型管理">
          <section className="upload-section" aria-labelledby="upload-title">
            <div className="section-heading">
              <div><p>精确数据源</p><h2 id="upload-title">上传模型</h2></div>
            </div>
            <label id="model-dropzone" className="upload-dropzone" htmlFor="model-file-input">
              <span className="upload-icon"><CloudUpload /></span>
              <strong>选择或拖入模型</strong>
              <small>仅支持 .stp 与 .step</small>
              <input id="model-file-input" type="file" accept=".stp,.step" multiple />
            </label>
            <div id="upload-queue" className="upload-queue" aria-live="polite" />

            <div className="artifact-strip" aria-label="模型数据链路">
              <div className="artifact-step source"><Box /><span><strong>STEP</strong><small>精确源模型</small></span></div>
              <ChevronRight className="artifact-arrow" />
              <div className="artifact-step mesh"><Scan /><span><strong>GLB</strong><small>浏览网格</small></span></div>
              <ChevronRight className="artifact-arrow" />
              <div className="artifact-step mapping"><Waypoints /><span><strong>映射表</strong><small>关联 STEP 面</small></span></div>
            </div>
          </section>

          <section className="uploaded-section" aria-labelledby="library-title">
            <div className="section-heading library-heading">
              <div><p>模型库</p><h2 id="library-title">已上传模型</h2></div>
              <div className="library-heading-actions">
                <label className="select-all-control"><input id="select-all-models" type="checkbox" aria-label="全选已上传模型" disabled /><span>全选</span></label>
                <span id="model-count" className="model-count">0 个模型</span>
              </div>
            </div>
            <div className="library-tools">
              <label className="search-field"><Search /><input id="model-search" type="search" placeholder="搜索模型" aria-label="搜索已上传模型" /></label>
              <button id="refresh-models" className="icon-button" type="button" title="刷新模型列表" aria-label="刷新模型列表"><RefreshCw /></button>
              <button id="delete-selected" className="icon-button danger" type="button" title="删除选中模型" aria-label="删除选中模型" disabled><Trash2 /></button>
            </div>
            <div id="model-list" className="model-list" data-scroll-position-key="model-list" aria-live="polite">
              <div className="list-empty"><LoaderCircle /><span>正在读取模型库</span></div>
            </div>
          </section>
        </aside>

        <ModelPreviewPanel />
      </main>
      <div id="toast" className="toast" role="status" aria-live="polite" hidden />
    </AppShell>
  );
}
