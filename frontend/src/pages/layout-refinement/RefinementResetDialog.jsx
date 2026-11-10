/** 文件说明：确认将安装筒尺寸及本次人工微调重置到来源方案；只通知宿主执行，不直接修改草稿、视角或后端版本。 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { RotateCcw } from '../../components/icons.js';

/** 显示可取消的重置确认框；关闭和 Escape 均保留当前编辑，仅确认时调用 onConfirm。 */
export function RefinementResetDialog({ open, onCancel, onConfirm }) {
  const dialog = useRef(null);
  useEffect(() => {
    if (open) dialog.current?.showModal(); else dialog.current?.close();
  }, [open]);
  return createPortal(<dialog ref={dialog} className="refinement-leave-dialog" aria-labelledby="refinement-reset-title"
    onCancel={(event) => { event.preventDefault(); onCancel(); }}>
    <h2 id="refinement-reset-title"><RotateCcw aria-hidden="true" />重置人工微调</h2>
    <p>恢复到进入页面时的来源方案，清除本次安装筒尺寸、位置、悬高、组合、锁定修改及本地草稿。已保存版本不受影响。</p>
    <div><button type="button" onClick={onCancel}>取消</button>
      <button type="button" className="primary" onClick={onConfirm}>确认重置</button></div>
  </dialog>, document.body);
}
