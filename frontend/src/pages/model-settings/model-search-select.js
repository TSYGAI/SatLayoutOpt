/**
 * 文件说明：卫星设置页常驻模型搜索控制器；筛选已就绪预览，管理本会话搜索及有限最近使用记录。
 * 接收共享预览控制器的模型与切换回调，不读取业务接口或修改模型参数；事件随页面 AbortSignal 解绑。
 */

/** 返回已保存设备名称；历史数据未填写名称时回退到原始文件名。 */
export function getSettingsModelName(model) {
  const name = model.settings?.device_name;
  return (typeof name === 'string' ? name.trim() : '') || model.filename || '';
}

/** 归一化搜索文本，忽略大小写、全半角及名称中常用的空格、下划线和连字符。 */
function normalizeSearch(value) {
  return String(value).normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\s_-]+/g, '');
}

/** 同时检索已保存名称与原始文件名；多个词须全部匹配，返回保持原顺序的候选模型。 */
export function filterSettingsModels(models, query) {
  const tokens = String(query).trim().split(/\s+/).filter(Boolean).map(normalizeSearch);
  return models.filter((model) => {
    const text = normalizeSearch(`${getSettingsModelName(model)} ${model.filename || ''}`);
    return tokens.every((token) => text.includes(token));
  });
}

/** 将显式选择的模型置于近期记录首位，去重并按配置上限截断；不修改原数组。 */
export function recordRecentModel(recentIds, modelId, limit) {
  if (!Number.isSafeInteger(limit) || limit <= 0 || !modelId) return [];
  return [...new Set([modelId, ...recentIds])].slice(0, limit);
}

/**
 * 创建页面选择器；模型数据与就绪资格由调用方提供，记录仅保存在此控制器的应用会话中。
 * @param {{ getModels: Function, getExistingModels: Function, getSelectedModel: Function, getEmptyLabel: Function, onSelect: Function }} callbacks 数据读取及模型切换回调。
 * @returns {{ render: Function, bind: Function, configure: Function, reset: Function }} 渲染、绑定、配置及完整退出清理方法。
 */
export function createModelSearchSelect({ getModels, getExistingModels, getSelectedModel, getEmptyLabel, onSelect }) {
  let query = '', recentIds = [], recentLimit = 0, results = [], activeId = null;
  let rebuildingOptions = false;

  /** 读取当前页面节点；离开卫星设置页时返回 null，不保留已卸载 DOM。 */
  function nodes() {
    const input = document.getElementById('model-settings-model-search');
    if (!input) return null;
    return {
      input, control: input.closest('.model-search-control'),
      toggle: document.getElementById('model-settings-model-select'),
      value: document.getElementById('model-settings-model-select-value'),
      clear: document.getElementById('model-settings-model-search-clear'),
      options: document.getElementById('model-settings-model-options'),
      status: document.getElementById('model-settings-model-search-status'),
    };
  }

  /** 同步键盘活动选项，并仅滚动候选列表，避免把下方参数表单或页面滚动位置带走。 */
  function updateActive(elements, scroll = false) {
    const items = [...elements.options.querySelectorAll('[role="option"]')];
    const current = items.find((item) => item.dataset.modelId === activeId);
    items.forEach((item) => item.classList.toggle('keyboard-active', item === current));
    if (current && !elements.options.hidden) {
      elements.input.setAttribute('aria-activedescendant', current.id);
      if (scroll) {
        const list = elements.options.getBoundingClientRect(), row = current.getBoundingClientRect();
        if (row.top < list.top) elements.options.scrollTop += row.top - list.top;
        else if (row.bottom > list.bottom) elements.options.scrollTop += row.bottom - list.bottom;
      }
    } else elements.input.removeAttribute('aria-activedescendant');
  }

  /** 展开或关闭绝对定位列表；始终保留常驻输入框的原始高度，不增加提示行。 */
  function setOpen(open, focus = false) {
    const elements = nodes();
    if (!elements) return;
    const expanded = Boolean(open && !elements.input.disabled);
    elements.options.hidden = !expanded;
    elements.control.classList.toggle('open', expanded);
    elements.input.setAttribute('aria-expanded', String(expanded));
    elements.toggle.setAttribute('aria-expanded', String(expanded));
    elements.toggle.setAttribute('aria-label', expanded ? '收起模型列表' : '展开模型列表');
    const selected = getModels().find((model) => model.id === getSelectedModel()?.id);
    elements.input.placeholder = elements.input.disabled ? getEmptyLabel()
      : expanded ? '输入模型名称或文件名…' : selected ? getSettingsModelName(selected) : '搜索并选择模型…';
    updateActive(elements);
    if (focus) elements.input.focus({ preventScroll: true });
  }

  /** 创建候选行；通过 textContent 写入模型文本，避免文件名及设备名称注入 HTML。 */
  function createOption(model, selectedId) {
    const option = document.createElement('button');
    option.type = 'button';
    option.role = 'option';
    option.tabIndex = -1;
    option.id = `model-search-option-${encodeURIComponent(model.id)}`;
    option.className = 'model-settings-model-option model-search-option';
    option.dataset.modelId = model.id;
    option.setAttribute('aria-selected', String(model.id === selectedId));
    option.setAttribute('aria-label', getSettingsModelName(model));
    const icon = document.createElement('i');
    icon.dataset.lucide = 'box';
    icon.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'model-settings-model-option-label';
    name.textContent = getSettingsModelName(model);
    const check = document.createElement('span');
    check.className = 'model-search-option-check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = model.id === selectedId ? '✓' : '';
    option.append(icon, name, check);
    return option;
  }

  /** 添加带文字标题的候选分组；相同模型仅出现一次，空分组不占位。 */
  function appendGroup(elements, models, label, selectedId) {
    if (!models.length) return;
    const group = document.createElement('div');
    group.role = 'group';
    group.setAttribute('aria-label', label);
    const heading = document.createElement('div');
    heading.className = 'model-search-group-label';
    heading.setAttribute('aria-hidden', 'true');
    heading.textContent = label;
    group.append(heading, ...models.map((model) => createOption(model, selectedId)));
    elements.options.append(group);
  }

  /** 同步模型、筛选结果和禁用状态；后台预览进度不重建未变化的选项或抢走输入焦点。 */
  function render() {
    const elements = nodes();
    if (!elements) return;
    const models = getModels(), selectedId = getSelectedModel()?.id;
    const existing = new Set(getExistingModels().map((model) => model.id));
    recentIds = recentIds.filter((id) => existing.has(id)).slice(0, recentLimit);
    const matches = filterSettingsModels(models, query);
    const recent = query.trim() ? [] : recentIds.map((id) => matches.find((model) => model.id === id)).filter(Boolean);
    const other = matches.filter((model) => !recent.some((item) => item.id === model.id));
    results = [...recent, ...other];
    if (!results.some((model) => model.id === activeId)) activeId = results[0]?.id || null;
    const selected = models.find((model) => model.id === selectedId);
    const label = selected ? getSettingsModelName(selected) : models.length ? '请选择已就绪模型' : getEmptyLabel();
    elements.toggle.dataset.value = selected?.id || '';
    elements.value.textContent = label;
    elements.input.disabled = elements.toggle.disabled = !models.length;
    if (elements.input.value !== query) elements.input.value = query;
    elements.clear.hidden = !query || !models.length;
    const key = JSON.stringify([models.map((model) => [model.id, getSettingsModelName(model), model.filename]), query, recentIds]);
    if (elements.options.dataset.modelListKey !== key) {
      const focusedId = elements.options.contains(document.activeElement) ? document.activeElement.dataset.modelId : null;
      // 重建会同步触发旧选项失焦；恢复同一模型的焦点后再允许正常的离开关闭行为。
      rebuildingOptions = true;
      try {
        elements.options.replaceChildren();
        if (recent.length) {
          appendGroup(elements, recent, '最近使用', selectedId);
          appendGroup(elements, other, '全部模型', selectedId);
        } else if (matches.length) elements.options.append(...matches.map((model) => createOption(model, selectedId)));
        else {
          const empty = document.createElement('div');
          empty.className = 'model-search-empty';
          empty.textContent = '未找到匹配模型，请尝试其他名称或文件名';
          elements.options.append(empty);
        }
        elements.options.dataset.modelListKey = key;
        elements.status.textContent = models.length ? `找到 ${matches.length} 个模型` : label;
        window.lucide?.createIcons({ nodes: [elements.options] });
        if (focusedId) ([...elements.options.querySelectorAll('[role="option"]')]
          .find((option) => option.dataset.modelId === focusedId) || elements.input).focus({ preventScroll: true });
      } finally {
        rebuildingOptions = false;
      }
    }
    elements.options.querySelectorAll('[role="option"]').forEach((option) => {
      const selectedOption = option.dataset.modelId === selectedId;
      option.setAttribute('aria-selected', String(selectedOption));
      option.querySelector('.model-search-option-check').textContent = selectedOption ? '✓' : '';
    });
    setOpen(!elements.options.hidden);
  }

  /** 确认仍有可用预览的候选，更新有限最近记录并调用既有模型切换；筛选不修改当前参数。 */
  async function choose(modelId) {
    const model = getModels().find((item) => item.id === modelId);
    if (!model) return;
    recentIds = recordRecentModel(recentIds, model.id, recentLimit);
    query = '';
    setOpen(false);
    await onSelect(model);
    render();
    nodes()?.input.focus({ preventScroll: true });
  }

  /** 输入时即时筛选；中文输入法候选期间也只更新列表，确认键不会误选模型。 */
  function handleInput(event) {
    query = event.target.value;
    activeId = null;
    render();
    setOpen(true);
  }

  /** 清除搜索词并重新展开完整候选，不清空当前模型、参数或最近使用记录。 */
  function clearSearch() {
    query = '';
    activeId = null;
    render();
    setOpen(true, true);
  }

  /** 点击常驻输入框时展开候选；不因搜索行为切换模型或保存草稿。 */
  function openFromInput() { setOpen(true); }

  /** 箭头按钮切换列表显隐，展开时将输入焦点移入搜索框。 */
  function toggleList() {
    const elements = nodes();
    if (elements) setOpen(elements.options.hidden, elements.options.hidden);
  }

  /** 点击候选行时仅提交其模型 ID，避免分组标题和空结果文字触发切换。 */
  function handleOptionClick(event) {
    const option = event.target.closest('[role="option"]');
    if (option) void choose(option.dataset.modelId);
  }

  /** 处理搜索选择键盘交互；方向键只滚动列表，Escape 收起，Tab 保持自然焦点顺序。 */
  function handleKeyDown(event) {
    if (event.isComposing || event.keyCode === 229) return;
    const elements = nodes();
    if (!elements) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false, true);
    } else if (event.key === 'Tab') setOpen(false);
    else if (event.key === 'Enter' && !elements.options.hidden) {
      event.preventDefault();
      const option = event.target.closest('[role="option"]');
      void choose(option?.dataset.modelId || activeId);
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      if (['Home', 'End'].includes(event.key) && event.target === elements.input) return;
      event.preventDefault();
      const wasClosed = elements.options.hidden;
      setOpen(true);
      const focusedId = event.target.closest('[role="option"]')?.dataset.modelId || activeId;
      const current = results.findIndex((model) => model.id === focusedId);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? results.length - 1
        : wasClosed || current < 0 ? event.key === 'ArrowUp' ? results.length - 1 : 0
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      activeId = results[index]?.id || null;
      updateActive(elements, true);
      elements.input.focus({ preventScroll: true });
    }
  }

  /** 点击选择器外部时收起浮层，不清除会话搜索词或最近记录。 */
  function handleOutside(event) {
    const elements = nodes();
    if (elements && !elements.control.contains(event.target)) setOpen(false);
  }

  /** 键盘焦点完全离开选择器后收起列表；候选间切换焦点时保持展开。 */
  function handleFocusOut(event) {
    if (rebuildingOptions) return;
    const elements = nodes();
    if (elements && !elements.control.contains(event.relatedTarget)) setOpen(false);
  }

  /** 绑定当前页面事件，随调用方提供的生命周期信号一次性解绑。 */
  function bind(signal) {
    const elements = nodes();
    if (!elements) return;
    elements.input.addEventListener('input', handleInput, { signal });
    elements.input.addEventListener('click', openFromInput, { signal });
    elements.toggle.addEventListener('click', toggleList, { signal });
    elements.clear.addEventListener('click', clearSearch, { signal });
    elements.options.addEventListener('click', handleOptionClick, { signal });
    elements.control.addEventListener('keydown', handleKeyDown, { signal });
    elements.control.addEventListener('focusout', handleFocusOut, { signal });
    document.addEventListener('pointerdown', handleOutside, { signal });
    render();
  }

  /** 从统一配置接收最近使用容量，非法配置直接报错，避免静默采用不同上限。 */
  function configure({ recentLimit: limit }) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('模型最近使用上限必须是非负整数');
    recentLimit = limit;
    recentIds = recentIds.slice(0, limit);
  }

  /** 完整退出应用时清空会话搜索及近期记录；普通路由切换保留它们。 */
  function reset() { query = ''; recentIds = []; results = []; activeId = null; }

  return { render, bind, configure, reset };
}
