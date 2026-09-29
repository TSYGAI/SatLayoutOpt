/**
 * 文件说明：提供带居中选中值和等宽选项列表的受控下拉组件，供设置类表单复用。
 * 组件只管理列表开合与选项交互，具体选项、禁用状态和业务变更由调用页面负责。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * 渲染受控的居中下拉控件。
 * @param {{ id: string, label: string, value: string | number, options: Array<{ value: string | number, label: string }>, disabled?: boolean, onChange: (value: string | number) => void }} props 控件标识、名称、当前值、选项、禁用状态与变更回调。
 */
export function SettingsSelect({ id, label, value, options, disabled = false, onChange }) {
  const [open, setOpen] = useState(false);
  const [optionCenterOffset, setOptionCenterOffset] = useState(0);
  const controlRef = useRef(null);
  const optionsRef = useRef(null);
  const selectedOption = options.find((option) => String(option.value) === String(value)) || options[0];

  useLayoutEffect(() => {
    if (!open) {
      setOptionCenterOffset(0);
      return;
    }
    const element = optionsRef.current;
    const triggerText = controlRef.current?.querySelector('.model-settings-field-select-trigger > span:nth-child(2)');
    const optionText = element?.querySelector('.model-settings-field-select-option > span');
    if (!triggerText || !optionText) return;
    /** 暂时移除已有补偿，直接测量两段文字的中心差，兼容不同浏览器的滚动条和边框宽度。 */
    const previousTransform = optionText.style.transform;
    optionText.style.transform = 'none';
    const triggerRect = triggerText.getBoundingClientRect();
    const optionRect = optionText.getBoundingClientRect();
    optionText.style.transform = previousTransform;
    setOptionCenterOffset((triggerRect.left + triggerRect.width / 2) - (optionRect.left + optionRect.width / 2));
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return undefined;
    /** 点击控件外部时关闭选项列表。 */
    function handlePointerDown(event) {
      if (!controlRef.current?.contains(event.target)) setOpen(false);
    }
    /** 按下 Escape 时关闭选项列表。 */
    function handleKeyDown(event) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  /** 选择一项并关闭下拉列表。 */
  function handleSelect(nextValue) {
    onChange(nextValue);
    setOpen(false);
  }

  return (
    <span ref={controlRef} className={`model-settings-field-select-control${open ? ' open' : ''}`}>
      <button
        id={id}
        className="model-settings-field-select-trigger"
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-options`}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true" />
        <span>{selectedOption.label}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      <div
        ref={optionsRef}
        id={`${id}-options`}
        className="model-settings-field-select-options"
        role="listbox"
        hidden={!open}
        style={{ '--settings-select-option-center-offset': `${optionCenterOffset}px` }}
      >
        {options.map((option) => (
          <button
            key={option.value}
            className="model-settings-field-select-option"
            type="button"
            role="option"
            aria-selected={String(option.value) === String(value)}
            onClick={() => handleSelect(option.value)}
          >
            <span>{option.label}</span>
          </button>
        ))}
      </div>
    </span>
  );
}
