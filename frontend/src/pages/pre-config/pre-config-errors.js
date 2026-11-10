/**
 * 文件说明：将前置配置各分组的异常和字段校验结果整理为可展示的中文文案。
 * 仅处理展示，不修改错误对象、状态码、取消信号或业务校验；原始异常仍供日志排障。
 */

const FIELD_LABELS = Object.freeze({
  installation_tube: '安装筒', base: '基座', lower_radius_mm: '下底面半径', upper_radius_mm: '上底面半径',
  min_radius_mm: '安装筒半径最小值', max_radius_mm: '安装筒半径最大值',
  min_height_mm: '安装筒高度最小值', max_height_mm: '安装筒高度最大值',
  axis_radius_mm: '质心最大偏移', centroid_max_offset_mm: '质心最大偏移',
  fairing_radius_mm: '整流罩最大半径', fairing_form: '整流罩形态', fairing_profile: '整流罩轮廓',
  fairing_cylinder_radius_mm: '圆柱段半径', fairing_cylinder_height_mm: '圆柱段高度',
  lower_cone_lower_radius_mm: '下锥段下底面半径', lower_cone_upper_radius_mm: '下锥段上底面半径',
  lower_cone_height_mm: '下锥段高度', upper_cone_lower_radius_mm: '上锥段下底面半径',
  upper_cone_upper_radius_mm: '上锥段上底面半径', upper_cone_height_mm: '上锥段高度',
  lower_cone: '下锥段', upper_cone: '上锥段', cylinder: '圆柱段', segments: '组合段',
  radius_mm: '半径', height_mm: '高度', record_id: '卫星类型', value: '卫星数量',
  enabled: '对称开关', mode: '对称约束类型', groups: '固定组', group_id: '固定组标识',
  mount: '安装位置', copies: '对称数量', symmetry_mode: '对称方式', constraint_mode: '约束类型',
  angle_deg: '环向位置角度', height_mode: '高度设置方式', clearance_mm: '筒壁间距',
  position: '世界位置', rotation_deg: '姿态角度', config_fingerprint: '配置版本',
  include_meshes: '预览网格开关', enforce_space: '空间校验开关', action: '微调操作',
});

/** 替换内部字段标识，保留数值、单位及用户输入的模型名称。 */
function translateFields(message) {
  return message.replace(/\b[a-z][a-z0-9_]*\b/g, (key, offset) => {
    const before = message.slice(0, offset), after = message.slice(offset + key.length);
    const isField = /^[\s`'"]*(?:必须|不能为空|不能|不得|无效|超出|字段|参数)/.test(after)
      || /(?:缺少|缺失|字段|参数)[\s`'"]*$/.test(before);
    return isField ? FIELD_LABELS[key] || key : key;
  });
}

/** 从结构化校验位置取得中文字段名，固定组数组使用面向用户的一起始序号。 */
function validationLabel(location) {
  const path = Array.isArray(location) ? location.filter((key) => !['body', 'query', 'path'].includes(key)) : [];
  const labels = path.filter((key) => typeof key === 'string' && FIELD_LABELS[key]).map((key) => FIELD_LABELS[key]);
  const index = path.indexOf('groups');
  const prefix = index >= 0 && Number.isInteger(path[index + 1]) ? `第 ${path[index + 1] + 1} 个固定组的` : '';
  const parent = path.at(-2);
  const scope = ['base', 'lower_cone', 'upper_cone', 'cylinder'].includes(parent) ? FIELD_LABELS[parent] : '';
  return prefix + scope + (labels.at(-1) || '请求参数');
}

/** 将服务端校验类型翻译为字段级提示；未识别的英文规则以中文格式建议兜底。 */
function validationMessage(detail) {
  if (!detail || typeof detail !== 'object') return formatPreConfigError(detail, '请求参数格式不正确，请检查后重试。');
  const label = validationLabel(detail.loc);
  const type = String(detail.type || '').replace(/^value_error\./, '');
  const message = String(detail.msg || '');
  if (/missing|required/i.test(type) || /^field required$/i.test(message)) return `${label}不能为空。`;
  if (/extra/.test(type)) return `${label}不受支持，请刷新页面后重试。`;
  if (/int/.test(type)) return `${label}必须为整数。`;
  if (/float|finite_number|number/.test(type)) return `${label}必须为有限数值。`;
  if (/bool/.test(type)) return `${label}必须为是或否。`;
  if (/enum|literal/.test(type)) return `${label}取值无效，请重新选择。`;
  for (const [rule, text] of [['gt', '大于'], ['ge', '大于或等于'], ['lt', '小于'], ['le', '小于或等于']]) {
    if (Number.isFinite(detail.ctx?.[rule])) return `${label}必须${text} ${detail.ctx[rule]}。`;
  }
  return formatPreConfigError(message.replace(/^Value error,\s*/i, ''), `${label}格式不正确，请检查后重试。`);
}

/**
 * 返回不含原始英文异常的中文提示；已有中文业务说明保留具体约束和模型名称。
 * @param {unknown} error 原始异常、服务端 detail 或约束违规文本，不会被修改。
 * @param {string} [fallback] 调用场景对应的中文重试建议。
 * @returns {string} 可直接用于提示条、行内错误或位姿浮窗的文案。
 */
export function formatPreConfigError(error, fallback = '操作未能完成，请重试；若仍失败，请重启应用后重试。') {
  const detail = error?.detail ?? error?.message ?? error;
  if (Array.isArray(detail)) {
    const messages = [...new Set(detail.map(validationMessage))];
    return messages.length > 1 ? messages.map((message) => message.replace(/[。；]$/, '')).join('；') + '。' : messages[0] || fallback;
  }
  const message = typeof detail === 'string' ? detail.trim() : '';
  if (!message) return fallback;
  if (/配置缺少 frontend\.api_base_url/.test(message)) {
    return '应用服务地址配置缺失，请检查统一配置中的服务地址后重启应用。';
  }
  if (/配置(?:无效|缺失|缺少|格式无效).*[:：].*[a-z_]/i.test(message)) {
    return '应用配置缺失或无效，请检查统一配置文件后重启应用。';
  }
  if (/dynamically imported module|loading chunk|importing a module/i.test(message)) {
    return '页面资源加载失败，请刷新页面；若仍失败，请重启应用后重试。';
  }
  if (/failed to fetch|networkerror|network request failed|load failed|err_connection|fetch failed/i.test(message)) {
    return '无法连接服务，请检查网络和服务是否正常后重试。';
  }
  if (error?.name === 'TimeoutError' || /timed?\s*out|timeout|deadline.*exceeded/i.test(message)) {
    return '请求处理超时，请稍后重试；若多次超时，请检查服务状态。';
  }
  if (/permission denied|access is denied|access denied|winerror 5\b|os error 5\b/i.test(message)) {
    return '访问文件被拒绝，请检查目录和文件的读写权限后重试。';
  }
  if (/used by another process|sharing violation|winerror 32\b|os error 32\b/i.test(message)) {
    return '文件正被其他程序占用，请关闭占用程序后重试。';
  }
  if (/no space left|disk.*full|winerror 112\b|os error 112\b/i.test(message)) {
    return '存储空间不足，请释放项目所在磁盘的空间后重试。';
  }
  if (/database.*locked|database.*busy/i.test(message)) return '数据正在被其他操作使用，请稍后重试。';
  if (/out of memory|allocation failed|failed to allocate/i.test(message)) {
    return '可用内存不足，请减少预览模型数量或降低预览复杂度后重试。';
  }
  if (/no such file|file not found|cannot find the file|winerror 2\b|os error 2\b/i.test(message)) {
    return '所需文件不存在或已被移动，请重新读取配置或重新固化模型后重试。';
  }
  if (/cone with two identic/i.test(message)) {
    return '锥段上下底面半径不能相同或过于接近，请调整锥段半径或选择不含该锥段的整流罩形态。';
  }
  if (/brep_api|standard_(?:failure|constructionerror)|command not done/i.test(message)) {
    return '几何构建失败，请检查各段尺寸、连接关系及模型是否完整后重试。';
  }
  if (/unexpected (?:token|end)|invalid json|json.*(?:parse|position)|not valid json/i.test(message)) {
    return '服务返回的数据格式异常，请重新读取；若仍失败，请重启应用后重试。';
  }
  if (/cannot read propert|is not a function|is not defined|[A-Za-z_]*(?:Error|Exception)\b|traceback|\n\s+at\s|must be|should be|invalid input|field required/i.test(message)) {
    return fallback;
  }
  if (/(?:失败|异常|错误)[^：:]*[:：]\s*[^\u3400-\u9fff\r\n]*[A-Za-z][^\u3400-\u9fff\r\n]*$/.test(message)) return fallback;
  const translated = translateFields(message);
  if (/[\u3400-\u9fff]/.test(translated) && !/失败（\d+）$/.test(translated)) return translated;
  if (Number(error?.status) >= 500) return '服务处理失败，请稍后重试；若仍失败，请重启应用后重试。';
  if (Number(error?.status) === 404) return '所需配置或模型记录不存在，请刷新页面后重新选择。';
  if (Number(error?.status) === 409) return '当前配置与操作冲突，请重新读取配置后再试。';
  if (Number(error?.status) === 422) return '请求参数不正确，请检查输入并重新提交。';
  return fallback;
}
