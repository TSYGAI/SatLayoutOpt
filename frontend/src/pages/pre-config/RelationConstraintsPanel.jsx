/**
 * 文件说明：为已选择的卫星类型展示对称开关及软硬模式；经 API 保存后通知父页更新确认状态。
 * 仅管理请求和展示，不计算布局、不操作右侧预览；配对及最终验收由后端负责。
 * 保存错误复用前置配置的中文提示转换，不直接展示网络或服务端英文异常。
 */

import { useEffect, useRef, useState } from 'react';
import { saveSatelliteSymmetry } from '../../api/pre-config-api.js';
import { showToast } from '../../components/toast.js';
import { formatPreConfigError } from './pre-config-errors.js';

/** 渲染已选类型的关系约束；onSaved 接收标识、开关和模式，disabled 表示数量保存中。 */
export function RelationConstraintsPanel({ satellites, loadState, disabled = false, onSaved }) {
  const [savingId, setSavingId] = useState(null);
  const controllerRef = useRef(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  /** 原子保存开关及模式并更新父页；失败保留原值，卸载时取消请求并停止更新。 */
  async function saveSymmetry(satellite, enabled, mode = satellite.symmetryMode) {
    if (controllerRef.current || disabled) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setSavingId(satellite.recordId);
    try {
      const response = await saveSatelliteSymmetry(satellite.recordId, enabled, mode, controller.signal);
      if (controller.signal.aborted) return;
      onSaved(satellite.recordId, response.satellite.symmetry_enabled, response.satellite.symmetry_mode);
      showToast(`${satellite.deviceName} · ${enabled ? `对称${mode === 'soft' ? '软' : '硬'}约束已保存` : '两两对称已关闭'}`);
    } catch (error) {
      if (!controller.signal.aborted) showToast(`对称设置保存失败：${formatPreConfigError(error)}`, true);
    } finally {
      if (!controller.signal.aborted) setSavingId(null);
      controllerRef.current = null;
    }
  }

  return (
    <div className="model-settings-form" aria-label="关系约束表单">
      <section className="model-settings-form-section" aria-labelledby="satellite-symmetry-title">
        <div className="model-settings-section-heading">
          <h2 id="satellite-symmetry-title">对称关系设定</h2>
        </div>
        <p className="pre-config-hint">
          硬约束要求同类型两两同高、等距、相隔 180°；软约束优先舱高、半径和质心，指标接近时尽量对称。
        </p>
        {loadState === 'loading' ? (
          <p className="pre-config-hint">正在读取卫星类型</p>
        ) : loadState === 'error' ? (
          <p className="pre-config-hint" role="alert">配置读取失败，请刷新页面重试</p>
        ) : satellites.length === 0 ? (
          <p className="pre-config-hint">请先在“模型设定”中将需要装载的卫星数量设为大于 0</p>
        ) : (
          <div className="pre-config-satellite-list" role="region" aria-label="卫星对称设置列表" tabIndex={0}>
            {satellites.map((satellite) => (
              <div key={satellite.recordId} className="pre-config-satellite-row pre-config-symmetry-row">
                <label className="pre-config-satellite-meta" htmlFor={`symmetry-enabled-${satellite.recordId}`}>
                  <strong title={satellite.deviceName}>{satellite.deviceName}</strong>
                  <small>
                    {satellite.count} 颗 · {satellite.symmetryEnabled
                      ? satellite.symmetryMode === 'soft' ? '尽量对称'
                        : `${Math.floor(satellite.count / 2)} 组对称${satellite.count % 2 ? ' · 1 颗自由' : ''}`
                      : '未启用对称'}
                  </small>
                </label>
                <select
                  className="pre-config-symmetry-mode"
                  aria-label={`${satellite.deviceName} 对称约束类型`}
                  value={satellite.symmetryMode}
                  disabled={disabled || savingId !== null || !satellite.symmetryEnabled}
                  onChange={(event) => saveSymmetry(satellite, true, event.target.value)}
                >
                  <option value="hard">硬约束</option>
                  <option value="soft">软约束</option>
                </select>
                <input
                  id={`symmetry-enabled-${satellite.recordId}`}
                  type="checkbox"
                  role="switch"
                  aria-label={`${satellite.deviceName} 两两对称`}
                  checked={satellite.symmetryEnabled}
                  disabled={disabled || savingId !== null}
                  onChange={(event) => saveSymmetry(satellite, event.target.checked)}
                />
              </div>
            ))}
          </div>
        )}
        <p className="pre-config-hint" role="status">
          {savingId ? '正在保存对称设置…' : '修改后自动保存，应用于后续布局任务。'}
        </p>
      </section>
    </div>
  );
}
