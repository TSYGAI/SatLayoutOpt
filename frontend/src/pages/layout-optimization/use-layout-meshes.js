/** 文件说明：只加载所选方案涉及的型号；当前任务数组保留于应用会话，切页取消网络与 Worker，换任务释放旧缓存。 */
import { useEffect, useRef, useState } from 'react';
import { usePageSessionState } from '../../app/page-session-state.js';
import { loadLayoutMeshSelection } from '../../api/layout-mesh-loader.js';

/** 返回当前候选可用的完整显示资源与加载状态；只有全部型号准备完成才原子交给视口。 */
export function useLayoutMeshes(jobId, candidate) {
  const [snapshot, setSnapshot] = usePageSessionState('layout', 'meshSnapshot', null);
  const [failure, setFailure] = useState(null);
  const cache = useRef(snapshot);
  const selection = JSON.stringify([...new Set(candidate?.placements.map((item) => item.record_id) ?? [])].sort());
  useEffect(() => {
    const controller = new AbortController();
    const records = JSON.parse(selection);
    setFailure(null);
    if (cache.current?.jobId !== jobId) { cache.current = null; setSnapshot(null); }
    if (!jobId || !records.length) { cache.current = null; setSnapshot(null); return () => controller.abort(); }
    loadLayoutMeshSelection(jobId, records, cache.current?.meshes, controller.signal)
      .then((meshes) => {
        if (controller.signal.aborted) return;
        const next = { jobId, selection, meshes };
        cache.current = next; setSnapshot(next);
      }).catch((error) => {
        if (!controller.signal.aborted) { cache.current = null; setSnapshot(null); setFailure({ jobId, selection, message: error.message }); }
      });
    return () => controller.abort();
  }, [jobId, selection]);
  const meshes = snapshot && snapshot.jobId === jobId && snapshot.selection === selection ? snapshot.meshes : null;
  const error = failure && failure.jobId === jobId && failure.selection === selection ? failure.message : '';
  return { meshes, meshError: error, meshLoading: Boolean(candidate && !meshes && !error) };
}
