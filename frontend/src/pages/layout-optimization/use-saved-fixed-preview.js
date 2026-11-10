/** 文件说明：为布局优化输入空间加载已保存固定卫星快照；复用保存时的CPU网格，指纹变化或离页取消旧响应，不读取未保存草稿。 */
import { useEffect, useState } from 'react';
import { usePageSessionState } from '../../app/page-session-state.js';
import { calculateFixedConstraints } from '../../api/fixed-constraints-api.js';
import { loadFixedMeshes } from '../../api/fixed-mesh-loader.js';

/** 返回与锁定配置匹配的固定卫星及网格；无会话缓存时通过既有正式预览接口计算，不改历史方案矩阵。 */
export function useSavedFixedPreview(config, enabled) {
  const [snapshot, setSnapshot] = usePageSessionState('layout', 'savedFixedPreview', null);
  const [failure, setFailure] = useState(null);
  const fingerprint = config?.config_fingerprint;
  const hasFixed = Boolean(config?.fixed_groups?.length);
  const cached = enabled && hasFixed && snapshot?.fingerprint === fingerprint
    && snapshot.candidate?.installation_base && snapshot.candidate?.fairing_profile
    && snapshot.candidate.placements.every((item) => item.space_preview_limits?.installation_vertices?.length) ? snapshot : null;
  useEffect(() => {
    setFailure(null);
    if (!enabled || !hasFixed || !fingerprint || cached) return undefined;
    const controller = new AbortController();
    Promise.all([calculateFixedConstraints(config.fixed_groups, fingerprint, { signal: controller.signal }),
      loadFixedMeshes(config.fixed_groups.map((group) => group.record_id), null, controller.signal,
        { groups: config.fixed_groups, fingerprint })])
      .then(([response, meshes]) => {
        if (controller.signal.aborted) return;
        if (!controller.signal.aborted) setSnapshot({ fingerprint, candidate: response.candidate, meshes });
      }).catch((error) => {
        if (!controller.signal.aborted) setFailure({ fingerprint, message: error.message });
      });
    return () => controller.abort();
  }, [enabled, hasFixed, fingerprint, cached]);
  const error = enabled && failure && failure.fingerprint === fingerprint ? failure.message : '';
  return { candidate: cached?.candidate ?? null, meshes: cached?.meshes ?? null, error,
    loading: Boolean(enabled && hasFixed && !cached && !error) };
}
