/**
 * 文件说明：卫星设置页的常驻模型搜索框结构，复用原选择区的高度与预览控制器生命周期。
 * 本组件只提供输入、清空和列表节点；候选资格、筛选、近期记录和模型切换由独立控制器管理。
 */

import { ChevronDown, Search, X } from '../../components/icons.js';
import '../../../styles/model-search-select.css';

/** 渲染固定高度的搜索选择框；初始禁用，控制器在可用预览出现后更新节点状态。 */
export function ModelSearchSelect() {
  return (
    <div className="model-settings-select-field">
      <label id="model-settings-model-select-label" htmlFor="model-settings-model-search">预览已就绪模型</label>
      <div className="model-settings-select-control model-search-control">
        <div className="model-search-field">
          <Search className="model-search-icon" aria-hidden="true" />
          <input id="model-settings-model-search" type="text" role="combobox" autoComplete="off" disabled
            aria-labelledby="model-settings-model-select-label" aria-autocomplete="list" aria-expanded="false"
            aria-controls="model-settings-model-options" placeholder="正在读取模型库" />
          <button id="model-settings-model-search-clear" className="model-search-clear" type="button"
            aria-label="清空模型搜索" hidden><X aria-hidden="true" /></button>
          <button id="model-settings-model-select" className="model-settings-select-trigger model-search-toggle"
            type="button" aria-label="展开模型列表" aria-haspopup="listbox" aria-expanded="false"
            aria-controls="model-settings-model-options" disabled>
            <span id="model-settings-model-select-value" className="model-search-sr">正在读取模型库</span>
            <ChevronDown aria-hidden="true" />
          </button>
        </div>
        <div id="model-settings-model-options" className="model-settings-model-options model-search-options"
          role="listbox" aria-label="预览已就绪模型" hidden />
        <span id="model-settings-model-search-status" className="model-search-sr" role="status" aria-live="polite" />
      </div>
    </div>
  );
}
