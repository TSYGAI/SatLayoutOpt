/**
 * 文件说明：分别调度应用会话中的预览生成与已有资源读取，两条通道各自串行、互不等待。
 * 后端就绪状态只决定读取通道，实际解码成功后才开放模型设置；不依赖 DOM 或 Three.js，删除或退出才取消任务。
 */

/** 创建队列；load 返回可移交的资源，onResult 接管资源，disposeResult 回收已删除模型的迟到结果。 */
export function createPreviewLoadQueue({ load, onResult, onChange, disposeResult, canStartDetail }) {
  const entries = new Map();
  let active = null;
  let restoring = null;
  let preferredId = null;
  let disposed = false;
  let scheduled = false;

  /** 读取只包含状态和错误的快照，不暴露任务控制器或资源所有权。 */
  function get(id) {
    const entry = entries.get(id);
    return entry ? { interaction: entry.interaction, detail: entry.detail,
      hasLoadedPreview: entry.hasLoadedPreview, restoring: restoring?.entry === entry,
      restoringQuality: restoring?.entry === entry ? restoring.quality : null,
      available: { ...entry.available }, errors: { ...entry.errors } } : null;
  }

  /** 合并同一调用栈的同步操作，保证新上传登记和当前选择都能参与下一次调度。 */
  function schedule() {
    if (scheduled || disposed) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; pump(); pumpRestore(); });
  }

  /** 判断某档是否属于指定通道；同模型先尝试已有简易缓存，避免完整缓存命中前重复生成高清。 */
  function eligible(entry, quality, restore) {
    return entry[quality] === 'pending' && entry.available[quality] === restore
      && !(quality === 'detail' && (entry.interaction === 'loading'
        || (entry.interaction === 'pending' && entry.available.interaction)));
  }

  /** 在同一质量档中优先处理当前选择，按已生成标记分流；绝不抢占正在进行的模型。 */
  function next(quality, restore) {
    const preferred = entries.get(preferredId);
    return preferred && eligible(preferred, quality, restore) ? preferred
      : [...entries.values()].find((entry) => eligible(entry, quality, restore));
  }

  /** 自动读取所有模型的已有资源；当前选择优先，其他模型无需点击即可继续，上传及生成不会占用此通道。 */
  function pumpRestore() {
    if (restoring || disposed) return;
    for (const quality of ['interaction', 'detail']) {
      const entry = next(quality, true);
      if (entry) { void run(entry, quality, true); return; }
    }
  }

  /** 缺失简易档均尝试生成且上传结束后才生成高清；其他模型的已有资源读取不会阻塞生成通道。 */
  function pump() {
    if (active || disposed) return;
    let quality = 'interaction';
    let entry = next(quality, false);
    const interactionPending = [...entries.values()].some((item) => !item.available.interaction
      && ['pending', 'loading'].includes(item.interaction));
    if (!entry && !interactionPending && canStartDetail()) { quality = 'detail'; entry = next(quality, false); }
    if (!entry) return;
    void run(entry, quality, false);
  }

  /** 执行指定通道的单个阶段并交付资源；失败隔离，删除或退出后的迟到结果统一回收。 */
  async function run(entry, quality, restore) {
    const controller = new AbortController();
    const task = { entry, quality, controller };
    if (restore) restoring = task;
    else active = task;
    entry[quality] = 'loading';
    onChange();
    try {
      const result = await load(entry.model, quality, controller.signal);
      if (disposed || controller.signal.aborted || entries.get(entry.model.id) !== entry) {
        disposeResult(result);
      } else {
        onResult(entry.model, quality, result);
        entry[quality] = 'ready';
        entry.available[quality] = true;
        entry.hasLoadedPreview = true;
        if (result.complete) {
          for (const tier of ['interaction', 'detail']) {
            entry.available[tier] = true;
            if (entry[tier] !== 'loading') entry[tier] = 'ready';
            delete entry.errors[tier];
          }
        }
        delete entry.errors[quality];
      }
    } catch (error) {
      if (!controller.signal.aborted && entries.get(entry.model.id) === entry) {
        entry[quality] = 'failed';
        entry.errors[quality] = error.message;
        if (entry.interaction === 'failed' && entry.detail === 'failed') entry.hasLoadedPreview = false;
      }
    } finally {
      if (restore) restoring = null;
      else active = null;
      if (!disposed) { onChange(); schedule(); }
    }
  }

  /** 同步已确认的模型清单；删除会取消对应在途任务，显式重试只重置失败阶段。 */
  function sync(models, { retryFailed = false } = {}) {
    const valid = new Set(models.map((model) => model.id));
    for (const [id, entry] of entries) {
      if (valid.has(id)) continue;
      entries.delete(id);
      if (active?.entry === entry) active.controller.abort();
      if (restoring?.entry === entry) restoring.controller.abort();
    }
    for (const model of models) {
      const entry = entries.get(model.id);
      if (entry) {
        entry.model = model;
        entry.available.interaction ||= model.derivatives?.interaction_state === 'ready';
        entry.available.detail ||= model.derivatives?.state === 'ready';
        if (retryFailed) {
          for (const quality of ['interaction', 'detail']) {
            if (entry[quality] === 'failed') { entry[quality] = 'pending'; delete entry.errors[quality]; }
          }
        }
      } else entries.set(model.id, { model, interaction: 'pending', detail: 'pending',
        hasLoadedPreview: false, available: { interaction: model.derivatives?.interaction_state === 'ready',
          detail: model.derivatives?.state === 'ready' }, errors: {} });
    }
    schedule();
  }

  /** 选择只调整后续顺序；内存缺失时独立恢复已生成资源，成功前不把后端就绪标记当作加载成功。 */
  function request(id, { reload = false, retry = false } = {}) {
    preferredId = id;
    const entry = entries.get(id);
    if (!entry) return;
    for (const quality of ['interaction', 'detail']) {
      if ([active, restoring].some((task) => task?.entry === entry && task.quality === quality)) continue;
      if ((reload && entry[quality] === 'ready') || (retry && entry[quality] === 'failed')) {
        entry[quality] = 'pending'; delete entry.errors[quality];
      }
    }
    schedule();
  }

  /** 应用退出时停止调度并中断在途工作；页面卸载不调用本方法。 */
  function dispose() {
    disposed = true;
    active?.controller.abort();
    restoring?.controller.abort();
    entries.clear();
  }

  return { get, sync, request, dispose };
}
