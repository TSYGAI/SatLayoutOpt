/**
 * 文件说明：固化记录详情视图，按模型参数、包络预览、正式包络存储信息与 STL 下载分组展示数据。
 * 只接收已格式化的记录与页面回调；请求、下载反馈、删除状态和 Three.js 生命周期由页面及专用 hook 负责。
 */

import { ChevronRight, Download, FileText, Fingerprint, Layers3, LoaderCircle, Trash2 } from '../../components/icons.js';
import { StoredEnvelopePreview } from './StoredEnvelopePreview.jsx';
import { formatParameterNumber } from '../../utils/number-format.js';

/** 展示标签与完整取值；wide 跨整行，mono 用于可选择复制的技术标识。 */
function InfoItem({ label, value, mono = false, wide = false }) {
  return (
    <div className={`data-management-info-item${wide ? ' is-wide' : ''}`}>
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : undefined}>{value}</dd>
    </div>
  );
}

/** 展示源文件摘要和模型参数，长文件名、姿态与包络增量允许换行。 */
function ModelInformation({ detail }) {
  return (
    <section className="data-management-panel data-management-model-panel" aria-labelledby="stored-model-info-title">
      <div className="data-management-panel-heading">
        <h3 id="stored-model-info-title"><FileText aria-hidden="true" />模型基本信息</h3>
      </div>
      <div className="data-management-source-file">
        <span className="data-management-format">{detail.source.format}</span>
        <div>
          <small>来源文件</small>
          <strong>{detail.source.filename}</strong>
        </div>
      </div>
      <dl className="data-management-info-grid">
        <InfoItem label="设备名称" value={detail.deviceName} />
        <InfoItem label="文件大小" value={detail.source.sizeText} />
        <InfoItem label="质量" value={detail.settings.mass} />
        <InfoItem label="安装面" value={detail.settings.installationFace} />
        <InfoItem label="质心" value={detail.settings.centerOfMass} wide />
      </dl>
      <dl className="data-management-info-grid data-management-parameters">
        <InfoItem label="初始姿态" value={detail.settings.pose} wide />
        <InfoItem label="六向包络增量（mm）" value={detail.settings.safetyClearance} wide />
      </dl>
    </section>
  );
}

/** 展示正式包络文件及下载等待状态；下载交给页面执行，新记录仅含基础包络，旧记录保持可查。 */
function DirectionVariants({ detail, onDownload, downloadingVariant }) {
  const variants = detail.envelope.variants;
  return (
    <section className="data-management-panel data-management-variants-panel" aria-labelledby="stored-variants-title">
      <div className="data-management-panel-heading">
        <h3 id="stored-variants-title"><Layers3 aria-hidden="true" />正式包络文件<span className="data-management-count">{variants.length}</span></h3>
        <span className="data-management-panel-note">新记录仅保存基础包络</span>
      </div>
      {variants.length > 0 ? (
        <div className="data-management-table-scroll" role="region" aria-label="正式包络文件表格" tabIndex={0}>
          <table className="data-management-table">
            <thead>
              <tr>
                <th scope="col">方向</th>
                <th scope="col">存储大小</th>
                <th scope="col">网格规模</th>
                <th scope="col">水密</th>
                <th scope="col">包围范围（mm）</th>
                <th scope="col">下载</th>
              </tr>
            </thead>
            <tbody>
              {variants.map((variant) => {
                const downloading = downloadingVariant?.recordId === detail.recordId && downloadingVariant.rotZ === variant.rotZ;
                const label = variant.rotZ === 0 ? '基础包络' : `历史 Rz ${formatParameterNumber(variant.rotZ)}° 包络`;
                return (
                  <tr key={variant.rotZ}>
                    <th scope="row"><span className="data-management-direction">{variant.rotZ === 0 ? '基础包络' : `历史 Rz ${formatParameterNumber(variant.rotZ)}°`}</span></th>
                    <td>{variant.sizeText}</td>
                    <td>{variant.triangleText}</td>
                    <td><span className={`data-management-watertight${variant.watertight ? ' is-ready' : ''}`}>{variant.watertight ? '是' : '否'}</span></td>
                    <td className="mono data-management-bounds">{variant.boundsText}</td>
                    <td>
                      <button className="data-management-download" type="button" disabled={Boolean(downloadingVariant)}
                        aria-label={`${downloading ? '正在下载' : '下载'} ${label}`} aria-busy={downloading}
                        onClick={() => void onDownload(detail.recordId, detail.deviceName, variant)}>
                        {downloading ? <LoaderCircle className="spinning" aria-hidden="true" /> : <Download aria-hidden="true" />}
                        {downloading ? '下载中…' : '下载 STL'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <p className="data-management-empty">该记录未保存正式包络文件。</p>}
    </section>
  );
}

/**
 * 渲染完整详情；下载链接来自后端，删除和相机操作通过回调交由页面执行。
 * @param {object} props 包含格式化详情、预览状态、画布绑定及操作回调。
 * @returns {import('react').ReactNode} 详情标题、双栏概览、变体表格与可展开的技术信息。
 */
export function StoredRecordDetail({ detail, previewState, bindPreviewContainer, onDelete, deleteDisabled, onFitView,
  onToggleTopologyEdges, topologyEdgesVisible, onMovePreview, onDownload, downloadingVariant }) {
  return (
    <div className="data-management-detail-content">
      <header className="data-management-detail-header">
        <div className="data-management-record-heading">
          <p className="eyebrow">存储记录</p>
          <div className="data-management-record-title-row">
            <h2 id="data-management-detail-title">{detail.deviceName}</h2>
            <p className="data-management-record-time">固化于 {detail.createdAtText}</p>
          </div>
        </div>
        <div className="data-management-detail-actions">
          <button className="data-management-action danger" type="button" disabled={deleteDisabled} onClick={onDelete}>
            <Trash2 aria-hidden="true" /><span>删除记录</span>
          </button>
        </div>
      </header>

      <div className="data-management-detail-body">
        <div className="data-management-overview">
          <ModelInformation detail={detail} />
          <StoredEnvelopePreview detail={detail} previewState={previewState} bindPreviewContainer={bindPreviewContainer}
            onFitView={onFitView} onToggleTopologyEdges={onToggleTopologyEdges} topologyEdgesVisible={topologyEdgesVisible}
            onMovePreview={onMovePreview} />
        </div>
        <DirectionVariants detail={detail} onDownload={onDownload} downloadingVariant={downloadingVariant} />
        <details className="data-management-panel data-management-technical" key={detail.recordId}>
          <summary>
            <Fingerprint aria-hidden="true" />
            <span>存储与校验信息</span>
            <span className="data-management-panel-note">记录 ID · 算法 · SHA-256</span>
            <ChevronRight className="data-management-disclosure-icon" aria-hidden="true" />
          </summary>
          <dl className="data-management-info-grid">
            <InfoItem label="记录 ID" value={detail.recordId} mono />
            <InfoItem label="算法标识" value={detail.envelope.algorithm} mono />
            <InfoItem label="源文件 SHA-256" value={detail.source.sha256} mono />
            <InfoItem label="包络网格 SHA-256" value={detail.envelope.meshSha256} mono />
          </dl>
        </details>
      </div>
    </div>
  );
}
