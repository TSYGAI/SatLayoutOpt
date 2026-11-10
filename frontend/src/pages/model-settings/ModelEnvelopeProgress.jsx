/**
 * 文件说明：显示包络任务的阶段、百分比和进度条；全部生成时额外显示后端当前计算模型的名称。
 * 名称与显示范围由任务状态模块提供；本组件只负责展示，不轮询、不计时，也不推断计算模型。
 */
import { Layers3 } from '../../components/icons.js';
import '../../../styles/model-envelope-progress.css';

/** 渲染已筛选到当前模型页的进度；百分比未知时保留阶段说明和无确定值的进度语义。 */
export function ModelEnvelopeProgress({ progress }) {
  if (!progress) return null;
  const unknown = progress.percent === null;
  const currentModelName = progress.kind === 'all' ? progress.currentModelName : null;
  const message = currentModelName ? `正在生成：${currentModelName}，${progress.message}` : progress.message;
  return (
    <div className="model-envelope-progress" data-scope={progress.kind}>
      {currentModelName && (
        <p className="model-envelope-progress-current-model" aria-live="polite">
          <span>正在生成：</span><span>{currentModelName}</span>
        </p>
      )}
      <div className="model-envelope-progress-heading">
        <Layers3 aria-hidden="true" />
        <p className={`model-settings-envelope-status ${progress.kind === 'all' ? 'generating-all' : 'generating'}`} aria-live="polite">
          {progress.message}
        </p>
        <span className="model-envelope-progress-percent">{unknown ? '—' : `${progress.percent}%`}</span>
      </div>
      <div className={`model-envelope-progress-track${unknown ? ' indeterminate' : ''}`}
        role="progressbar" aria-label={progress.kind === 'all' ? '全部模型包络生成进度' : '当前模型包络生成进度'}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={unknown ? undefined : progress.percent}
        aria-valuetext={unknown ? `${message}，等待进度更新` : `${message}，${progress.percent}%`}>
        <div className="model-envelope-progress-fill" style={{ width: unknown ? '100%' : `${progress.percent}%` }} />
      </div>
    </div>
  );
}
