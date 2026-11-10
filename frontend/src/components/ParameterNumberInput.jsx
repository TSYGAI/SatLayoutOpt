/** 文件说明：统一受控参数输入的显示精度；失焦显示最多三位小数，聚焦恢复完整值，仅真实输入触发变更，不参与校验或保存。 */
import { useState } from 'react';
import { flushSync } from 'react-dom';
import { formatParameterNumber } from '../utils/number-format.js';

/** 透传原生数字输入属性和 ref；聚焦、失焦只切换显示文本，事件处理器仍读取未经舍入的编辑值。 */
export function ParameterNumberInput({ value, onFocus, onBlur, ...props }) {
  const [focused, setFocused] = useState(false);
  /** 在原生输入或箭头步进开始前同步恢复完整值；文本变化时重新选中，避免首次替换输入追加到原值末尾。 */
  function handleFocus(event) {
    const shown = event.currentTarget.value;
    flushSync(() => setFocused(true));
    if (shown !== event.currentTarget.value) event.currentTarget.select();
    onFocus?.(event);
  }
  return <input {...props} type="number" value={focused ? (value ?? '') : formatParameterNumber(value, '')}
    onFocus={handleFocus}
    onBlur={(event) => { onBlur?.(event); setFocused(false); }} />;
}
