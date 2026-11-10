/**
 * 文件说明：数据管理功能页，负责固化记录检索、选择恢复、删除、下载反馈及包络预览的生命周期。
 * 列表、检索、勾选和详情保留在应用会话；独立加载三维控制器，供面板与悬浮大窗共用。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Database, LoaderCircle, RefreshCcw, Search, Trash2 } from '../components/icons.js';

import { AppShell } from '../app/AppShell.jsx';
import { usePageSessionState } from '../app/page-session-state.js';
import {
  deleteStoredModel,
  deleteStoredModels,
  getStoredModel,
  listStoredModels,
} from '../api/model-upload-api.js';
import { showToast } from '../components/toast.js';
import { StoredRecordDetail } from './data-management/StoredRecordDetail.jsx';
import { StoredRecordDeleteDialog } from './data-management/StoredRecordDeleteDialog.jsx';
import { useStoredEnvelopeDownload } from './data-management/use-stored-envelope-download.js';
import {
  readStoredRecordSelection,
  toStoredDetail,
  toStoredListItems,
  writeStoredRecordSelection,
} from './data-management/data-management-state.js';
import '../../styles/model-upload.css';
import '../../styles/model-settings.css';
import '../../styles/data-management.css';

const PAGE_SIZE = 100;
const BULK_PAGE_SIZE = 500;

/** 渲染数据管理页面。 */
export function DataManagementPage() {
  const { downloadingVariant, downloadVariant } = useStoredEnvelopeDownload();
  const [records, setRecords] = usePageSessionState('data-management', 'records', []);
  const [total, setTotal] = usePageSessionState('data-management', 'total', 0);
  const [keyword, setKeyword] = usePageSessionState('data-management', 'keyword', '');
  const [appliedKeyword, setAppliedKeyword] = usePageSessionState('data-management', 'appliedKeyword', '');
  const [listState, setListState] = useState('loading');
  const [detail, setDetail] = usePageSessionState('data-management', 'detail', null);
  const [detailState, setDetailState] = useState(detail ? 'ready' : 'idle');
  const [previewState, setPreviewState] = useState({ state: 'idle', message: '' });
  const [topologyEdgesVisible, setTopologyEdgesVisible] = useState(false);
  const [selectedRecordId, setSelectedRecordId] = usePageSessionState('data-management', 'selectedRecordId', readStoredRecordSelection);
  const [checkedRecordIds, setCheckedRecordIds] = usePageSessionState('data-management', 'checkedRecordIds', () => new Set());
  const [bulkState, setBulkState] = useState('idle');
  const [deleteRequest, setDeleteRequest] = useState(null);
  const [previewElement, setPreviewElement] = useState(null);
  const [previewReady, setPreviewReady] = useState(false);
  const previewRef = useRef(null);
  const selectAllRef = useRef(null);
  const shownPreviewUrlRef = useRef(null);
  const checkedCount = checkedRecordIds.size;
  const allMatchingChecked = total > 0 && (bulkState === 'selecting' || checkedCount === total);
  const bulkBusy = bulkState !== 'idle';

  /** 记录三维预览画布节点；节点挂载和卸载时由下方 effect 创建与释放控制器。 */
  const bindPreviewContainer = useCallback((element) => {
    setPreviewElement((current) => (current === element ? current : element));
  }, []);

  /** 让当前包络完整居中到画布，供预览工具栏恢复视角。 */
  function handleFitPreview() {
    previewRef.current?.fitView();
  }

  /** 切换固化包络预览边线；边线几何由控制器按需创建并在关闭时释放。 */
  const handleToggleTopologyEdges = useCallback(() => {
    const visible = previewRef.current?.toggleTopologyEdges();
    if (typeof visible === 'boolean') setTopologyEdgesVisible(visible);
  }, []);

  /** 在面板与大窗之间移动既有画布；不重建场景或重新加载包络资源。 */
  const handleMovePreview = useCallback((container) => {
    if (container) previewRef.current?.setContainer(container);
  }, []);

  /** 在预览控制器就绪后加载指定记录的固化包络，同一记录只加载一次。 */
  const showPreview = useCallback(async (recordId, signal) => {
    if (!previewRef.current) {
      setPreviewState({ state: 'error', message: '三维预览初始化失败，请刷新页面重试' });
      return;
    }
    if (shownPreviewUrlRef.current === recordId) return;
    previewRef.current.setTopologyEdgesVisible?.(false);
    setTopologyEdgesVisible(false);
    setPreviewState({ state: 'loading', message: '' });
    try {
      await previewRef.current.show(recordId, signal);
      if (signal.aborted) return;
      shownPreviewUrlRef.current = recordId;
      setPreviewState({ state: 'ready', message: '' });
    } catch (error) {
      if (!signal.aborted) setPreviewState({ state: 'error', message: error.message });
    }
  }, []);

  /** 重新读取固化记录列表并保留当前选择。 */
  const refreshRecords = useCallback(async (signal) => {
    setListState('loading');
    try {
      const body = await listStoredModels({ limit: PAGE_SIZE, offset: 0, keyword: appliedKeyword, signal });
      if (signal?.aborted) return;
      setRecords(toStoredListItems(body.records));
      setTotal(body.total || 0);
      if (body.total <= PAGE_SIZE) {
        const identifiers = new Set(body.records.map((record) => record.record_id));
        setCheckedRecordIds((current) => new Set([...current].filter((id) => identifiers.has(id))));
      }
      setListState('ready');
    } catch (error) {
      if (error.name === 'AbortError') return;
      setListState('error');
      showToast(`固化记录读取失败：${error.message}`, true);
    }
  }, [appliedKeyword]);

  useEffect(() => {
    const controller = new AbortController();
    void refreshRecords(controller.signal);
    return () => controller.abort();
  }, [refreshRecords]);

  /** 列表就绪且没有历史选择时打开第一条；列表刷新与检索不覆盖正在查看的记录。 */
  useEffect(() => {
    if (listState === 'ready' && !selectedRecordId && records.length > 0) {
      setSelectedRecordId(records[0].recordId);
    }
  }, [listState, records, selectedRecordId]);

  /** 选择变化后保存会话缓存，供浏览器刷新或菜单切换回来时恢复。 */
  useEffect(() => {
    writeStoredRecordSelection(selectedRecordId);
  }, [selectedRecordId]);

  /** 原生复选框显示部分选中态，明确区分逐条勾选和全选全部匹配记录。 */
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = checkedCount > 0 && !allMatchingChecked;
    }
  }, [checkedCount, allMatchingChecked]);

  /** 按记录 ID 加载详情；历史记录确已删除时重新取列表并回退，网络错误保留选择供重试。 */
  useEffect(() => {
    const controller = new AbortController();
    if (!selectedRecordId) {
      setDetail(null);
      setDetailState('idle');
      return () => controller.abort();
    }
    const hasCachedDetail = detail?.recordId === selectedRecordId;
    setDetailState(hasCachedDetail ? 'ready' : 'loading');
    getStoredModel(selectedRecordId, controller.signal)
      .then((record) => {
        if (controller.signal.aborted) return;
        setDetail(toStoredDetail(record));
        setDetailState('ready');
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (error.status === 404) {
          setSelectedRecordId(null);
          void refreshRecords();
          return;
        }
        setDetailState(hasCachedDetail ? 'ready' : 'error');
        showToast(`固化记录详情读取失败：${error.message}`, true);
      });
    return () => controller.abort();
  }, [selectedRecordId, refreshRecords]);

  /** 详情画布出现后才加载三维代码；切走时阻止迟到模块挂载，并释放既有 GPU 资源。 */
  useEffect(() => {
    if (!previewElement) return undefined;
    let disposed = false;
    setPreviewReady(false);
    setTopologyEdgesVisible(false);
    setPreviewState({ state: 'loading', message: '' });
    shownPreviewUrlRef.current = null;
    void import('./data-management/stored-envelope-preview.js').then((module) => {
      if (disposed) return;
      previewRef.current = module.createStoredEnvelopePreview({ container: previewElement });
      setTopologyEdgesVisible(false);
      setPreviewReady(true);
    }).catch((error) => {
      if (!disposed) setPreviewState({ state: 'error', message: `三维预览初始化失败：${error.message}` });
    });
    return () => {
      disposed = true;
      previewRef.current?.dispose();
      previewRef.current = null;
      shownPreviewUrlRef.current = null;
      setTopologyEdgesVisible(false);
    };
  }, [previewElement]);

  /** 详情就绪后加载固化包络；画布或记录晚就绪时本 effect 会重新触发。 */
  useEffect(() => {
    if (!detail || !previewReady || !previewRef.current) return undefined;
    if (!detail.envelope.previewUrl) {
      previewRef.current?.clear();
      shownPreviewUrlRef.current = null;
      setTopologyEdgesVisible(false);
      setPreviewState({ state: 'unavailable', message: '该记录未保存包络浏览网格' });
      return undefined;
    }
    const controller = new AbortController();
    void showPreview(detail.recordId, controller.signal);
    return () => controller.abort();
  }, [detail, previewElement, previewReady, showPreview]);

  /** 点击列表条目时切换右侧详情。 */
  function handleSelectRecord(recordId) {
    setSelectedRecordId(recordId);
  }

  /** 提交关键字检索。 */
  function handleSearchSubmit(event) {
    event.preventDefault();
    if (bulkBusy) return;
    setCheckedRecordIds(new Set());
    setAppliedKeyword(keyword.trim());
  }

  /** 清空批量选择并重新读取当前检索结果。 */
  function handleRefreshRecords() {
    if (bulkBusy) return;
    setCheckedRecordIds(new Set());
    void refreshRecords();
  }

  /** 切换一条记录的批量删除勾选状态，不改变右侧详情选择。 */
  function handleToggleRecord(recordId, checked) {
    setCheckedRecordIds((current) => {
      const next = new Set(current);
      if (checked) next.add(recordId); else next.delete(recordId);
      return next;
    });
  }

  /** 全选或清空当前检索条件下的全部记录；结果超过首屏时继续分页读取标识。 */
  async function handleToggleAll(event) {
    const checked = event.target.checked;
    if (!checked) {
      setCheckedRecordIds(new Set());
      return;
    }
    setBulkState('selecting');
    try {
      const identifiers = [];
      let offset = 0;
      let expected = total;
      do {
        const page = await listStoredModels({ limit: BULK_PAGE_SIZE, offset, keyword: appliedKeyword });
        const pageRecords = toStoredListItems(page.records);
        identifiers.push(...pageRecords.map((record) => record.recordId));
        offset += pageRecords.length;
        expected = Number(page.total) || 0;
        if (!pageRecords.length) break;
      } while (offset < expected);
      setTotal(expected);
      setCheckedRecordIds(new Set(identifiers));
    } catch (error) {
      setCheckedRecordIds(new Set());
      showToast(`全选固化记录失败：${error.message}`, true);
    } finally {
      setBulkState('idle');
    }
  }

  /** 清空当前详情和包络预览，用于删除正在查看的记录后恢复空状态。 */
  function clearSelectedDetail() {
    previewRef.current?.clear();
    setTopologyEdgesVisible(false);
    setPreviewState({ state: 'idle', message: '' });
    setDetail(null);
    setDetailState('idle');
    setSelectedRecordId(null);
  }

  /** 请求删除所有已勾选记录；实际删除等待居中确认弹窗提交。 */
  function handleDeleteCheckedRecords() {
    const identifiers = [...checkedRecordIds];
    if (!identifiers.length || bulkBusy) return;
    const deletingAll = allMatchingChecked;
    const scope = deletingAll ? `全部 ${identifiers.length} 条` : `选中的 ${identifiers.length} 条`;
    setDeleteRequest({ mode: 'bulk', identifiers, scope });
  }

  /** 执行确认后的批量删除，成功后清空选择并刷新当前检索结果。 */
  async function deleteCheckedRecords(identifiers) {
    setBulkState('deleting');
    try {
      const result = await deleteStoredModels(identifiers);
      if (selectedRecordId && checkedRecordIds.has(selectedRecordId)) clearSelectedDetail();
      setCheckedRecordIds(new Set());
      await refreshRecords();
      showToast(`已删除 ${result.deleted} 条固化记录，原始模型与包络产物不受影响`, false, { centered: true });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `批量删除固化记录失败：${error.message}` };
    } finally {
      setBulkState('idle');
    }
  }

  /** 请求删除当前详情记录；实际删除等待居中确认弹窗提交。 */
  function handleDeleteRecord() {
    if (!selectedRecordId || bulkBusy) return;
    setDeleteRequest({ mode: 'record', recordId: selectedRecordId, deviceName: detail?.deviceName || '当前固化记录' });
  }

  /** 执行确认后的单条删除并刷新列表。 */
  async function deleteRecord(recordId) {
    try {
      await deleteStoredModel(recordId);
      setCheckedRecordIds((current) => {
        const next = new Set(current);
        next.delete(recordId);
        return next;
      });
      clearSelectedDetail();
      showToast('已删除该固化记录，原始模型与包络产物不受影响', false, { centered: true });
      void refreshRecords();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `删除固化记录失败：${error.message}` };
    }
  }

  /** 提交居中删除弹窗对应的固定目标，避免确认期间选择变化影响删除范围。 */
  async function handleConfirmDelete() {
    if (!deleteRequest) return { ok: false, error: '删除目标已失效，请重试。' };
    return deleteRequest.mode === 'bulk'
      ? deleteCheckedRecords(deleteRequest.identifiers)
      : deleteRecord(deleteRequest.recordId);
  }

  const bulkDeleteLabel = bulkState === 'deleting'
    ? '正在删除所选记录'
    : allMatchingChecked
      ? `删除全部 ${checkedCount} 条记录`
      : `删除所选 ${checkedCount} 条记录`;

  return (
    <AppShell className="data-management-page-shell" pageTitle="数据管理" status={listState === 'loading' ? '读取中' : '系统就绪'} statusId="data-management-status">
      <main className="model-workspace data-management-workspace">
        <aside className="model-sidebar data-management-sidebar" aria-label="已存储模型">
          <div className="model-settings-sidebar-body">
            <section className="model-settings-model-section" aria-labelledby="data-management-list-title">
              <p className="eyebrow">固化存储</p>
              <div className="section-heading">
                <h2 id="data-management-list-title">已存储模型</h2>
                <span className="model-count">{total}</span>
              </div>
              <form className="data-management-search" role="search" onSubmit={handleSearchSubmit}>
                <span className="data-management-search-field">
                  <Search aria-hidden="true" />
                  <input
                    type="search"
                    aria-label="按设备名称或文件名检索存储记录"
                    placeholder="检索设备名称或文件名"
                    value={keyword}
                    disabled={bulkBusy}
                    onChange={(event) => setKeyword(event.target.value)}
                  />
                </span>
                <button type="submit" title="检索" aria-label="检索" disabled={bulkBusy}>
                  <Search aria-hidden="true" />
                </button>
                <button type="button" title="刷新列表" aria-label="刷新列表" aria-busy={listState === 'loading'}
                  disabled={bulkBusy} onClick={handleRefreshRecords}>
                  <RefreshCcw className={listState === 'loading' ? 'spinning' : undefined} aria-hidden="true" />
                </button>
              </form>
              <div className="data-management-bulk-actions">
                <label>
                  <input ref={selectAllRef} type="checkbox" checked={allMatchingChecked}
                    disabled={listState !== 'ready' || total === 0 || bulkBusy} onChange={(event) => void handleToggleAll(event)} />
                  <span>{bulkState === 'selecting' ? '正在全选…' : `全选（共 ${total} 条）`}</span>
                </label>
                <button className="data-management-bulk-delete" type="button" disabled={checkedCount === 0 || bulkBusy}
                  aria-label={bulkDeleteLabel} title={bulkDeleteLabel}
                  onClick={() => void handleDeleteCheckedRecords()}>
                  {bulkState === 'deleting'
                    ? <LoaderCircle className="spinning" aria-hidden="true" />
                    : <Trash2 aria-hidden="true" />}
                  {checkedCount > 0 && (
                    <span className="data-management-bulk-delete-count" aria-hidden="true">
                      (<span className="data-management-bulk-delete-count-value">{checkedCount}</span>)
                    </span>
                  )}
                </button>
              </div>
            </section>

            <section className="model-settings-form-section" aria-label="存储记录列表">
              {listState === 'error' && records.length === 0 ? (
                <p className="data-management-empty" role="alert">存储记录读取失败，可点击刷新重试。</p>
              ) : records.length === 0 ? (
                <p className="data-management-empty">
                  {appliedKeyword ? '没有匹配的存储记录' : '还没有存储任何模型，可在卫星设置页生成包络后点击“存储到数据库”'}
                </p>
              ) : (
                <ul className="data-management-record-list">
                  {records.map((record) => (
                    <li className="data-management-record-row" key={record.recordId}>
                      <input className="data-management-record-checkbox" type="checkbox"
                        aria-label={`选择 ${record.deviceName}`} checked={checkedRecordIds.has(record.recordId)} disabled={bulkBusy}
                        onChange={(event) => handleToggleRecord(record.recordId, event.target.checked)} />
                      <button
                        type="button"
                        className={`data-management-record${record.recordId === selectedRecordId ? ' active' : ''}`}
                        onClick={() => handleSelectRecord(record.recordId)}
                      >
                        <span className="data-management-record-title">{record.deviceName}</span>
                        <span className="data-management-record-meta">{record.createdAtText}</span>
                        <span className="data-management-record-meta">
                          {record.variantCount} 个方向 · {record.sourceSizeText} · {record.sourceFilename}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </aside>

        <section className="data-management-detail" aria-labelledby="data-management-detail-title">
          {!selectedRecordId ? (
            <div className="data-management-placeholder">
              <Database aria-hidden="true" />
              <strong>尚未选择存储记录</strong>
              <small>在左侧选择一个已存储模型，查看其基本信息与包络数据</small>
            </div>
          ) : detailState === 'loading' ? (
            <div className="data-management-placeholder">
              <LoaderCircle className="spinning" aria-hidden="true" />
              <strong>正在读取记录详情</strong>
            </div>
          ) : detailState === 'error' ? (
            <div className="data-management-placeholder">
              <strong>记录详情读取失败</strong>
              <small>请刷新列表后重新选择</small>
            </div>
          ) : detail ? (
            <StoredRecordDetail
              detail={detail}
              previewState={previewState}
              bindPreviewContainer={bindPreviewContainer}
              onFitView={handleFitPreview}
              onToggleTopologyEdges={handleToggleTopologyEdges}
              topologyEdgesVisible={topologyEdgesVisible}
              onMovePreview={handleMovePreview}
              onDelete={handleDeleteRecord}
              deleteDisabled={bulkBusy}
              onDownload={downloadVariant}
              downloadingVariant={downloadingVariant}
            />
          ) : null}
        </section>
      </main>
      <div id="toast" className="toast" role="status" aria-live="polite" hidden />
      {deleteRequest && (
        <StoredRecordDeleteDialog
          request={deleteRequest}
          onClose={() => setDeleteRequest(null)}
          onConfirm={handleConfirmDelete}
        />
      )}
    </AppShell>
  );
}
