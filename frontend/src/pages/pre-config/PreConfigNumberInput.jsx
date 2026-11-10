/**
 * 文件说明：前置配置共用的受控数字输入，保留浏览器原生小箭头，步进和上下方向键按当前值增减 1。
 * 输入范围由调用方提供，越界步进停在边界；不参与业务校验、保存或三维预览。
 */

import { useEffect, useRef } from 'react';
import { ParameterNumberInput } from '../../components/ParameterNumberInput.jsx';

/**
 * 渲染原生数字输入；onValueChange 接收输入文本，其余事件转交原输入框。
 * 鼠标步进期间暂时解除原生范围，避免浏览器阻止跨过下限的减 1；在变更回调中限制结果。
 */
export function PreConfigNumberInput({ label, value, min, max, disabled, onValueChange, onKeyDown, onPointerDown, onBlur, ...inputProps }) {
  const inputRef = useRef(null);
  const spinListeners = useRef(null);
  useEffect(() => () => spinListeners.current?.abort(), []);

  /** 将有限步进结果限制到调用方范围；手动输入的校验仍交由原输入框与业务层处理。 */
  function clamp(number) {
    if (min !== undefined && min !== '') number = Math.max(Number(min), number);
    if (max !== undefined && max !== '') number = Math.min(Number(max), number);
    return number;
  }

  /** 恢复输入的真实范围并清理本次指针监听，失焦保存之前也必须恢复原生约束。 */
  function restoreLimits() {
    const input = inputRef.current;
    if (input) {
      for (const [name, limit] of [['min', min], ['max', max]]) {
        if (limit === undefined || limit === '') input.removeAttribute(name);
        else input.setAttribute(name, String(limit));
      }
    }
    spinListeners.current?.abort();
    spinListeners.current = null;
  }

  /** 保留原生箭头点击和长按行为；结束指针操作或窗口失焦时立即恢复范围。 */
  function prepareNativeStep(event) {
    onPointerDown?.(event);
    const input = inputRef.current;
    if (event.defaultPrevented || !input || input.matches(':disabled') || input.readOnly) return;
    restoreLimits();
    input.removeAttribute('min');
    input.removeAttribute('max');
    const controller = new AbortController();
    spinListeners.current = controller;
    for (const type of ['pointerup', 'pointercancel']) {
      document.addEventListener(type, restoreLimits, { capture: true, signal: controller.signal });
    }
    window.addEventListener('blur', restoreLimits, { signal: controller.signal });
  }

  /** Chromium 原生步进触发普通 input Event，手动编辑触发 InputEvent；仅对步进结果截取边界。 */
  function handleChange(event) {
    const input = event.currentTarget;
    const stepped = event.nativeEvent.type === 'input' && !('inputType' in event.nativeEvent);
    const next = stepped && Number.isFinite(input.valueAsNumber) ? String(clamp(input.valueAsNumber)) : input.value;
    onValueChange(next);
  }

  /** 从当前输入值增减 1 并限制到字段范围；空输入从 0 起步，禁用或只读时不产生变更。 */
  function changeByOne(direction) {
    const input = inputRef.current;
    if (!input || input.matches(':disabled') || input.readOnly) return;
    const calculator = document.createElement('input');
    calculator.type = 'number';
    calculator.step = '1';
    calculator.defaultValue = Number.isFinite(input.valueAsNumber) ? input.value : '0';
    calculator.stepUp(direction);
    const next = clamp(calculator.valueAsNumber);
    if (Number.isFinite(next)) onValueChange(String(next));
  }

  /** 保留调用方的 Enter/Escape 行为；上下方向键使用与小箭头相同的步进规则。 */
  function handleKeyDown(event) {
    onKeyDown?.(event);
    if (event.defaultPrevented || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    changeByOne(event.key === 'ArrowUp' ? 1 : -1);
  }

  return <ParameterNumberInput {...inputProps} ref={inputRef} step="any" min={min} max={max}
    value={value} disabled={disabled} aria-label={label} onKeyDown={handleKeyDown}
    onPointerDown={prepareNativeStep} onChange={handleChange}
    onBlur={(event) => { restoreLimits(); onBlur?.(event); }} />;
}
