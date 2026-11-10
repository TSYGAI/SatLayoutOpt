/** 文件说明：固定组草稿与正式保存基线；每次编辑写本地存储，明确不保存时删除草稿并恢复基线，只有确认保存才发布。 */
import { useState } from 'react';
import { readPageSession, usePageSessionState } from '../../app/page-session-state.js';
import { clearFixedDraft, fixedDraftSignature, readFixedDraft, writeFixedDraft, replaceFixedGroup } from './fixed-draft.js';

/** 管理临时存储；网络请求期间使用命令式快照，防止连续操作读到旧 React 状态。 */
export function useFixedDraft() {
  const [draft, setDraft] = usePageSessionState('pre-config', 'fixedDraft', () => readFixedDraft() || {
    groups: readPageSession('pre-config', 'fixedGroups', null), savedGroups: null, defaults: {},
  });
  const [storageError, setStorageError] = useState('');
  /** 同步写会话和本地草稿；存储失败保留内存内容并给出可见错误。 */
  function update(changes) {
    const next = { ...readPageSession('pre-config', 'fixedDraft'), ...changes };
    setDraft(next);
    if (next.groups === null || next.savedGroups === null) return;
    try { writeFixedDraft(next); setStorageError(''); }
    catch { setStorageError('临时保存失败，请在离开前保存固定约束。'); }
  }
  /** 接收正式配置；已有未发布草稿仍可继续编辑，其他流程只读取服务端版本。 */
  function initialize(response) {
    const current = readPageSession('pre-config', 'fixedDraft');
    const pending = current.groups !== null && (current.savedGroups === null
      || fixedDraftSignature(current.groups, current.defaults) !== fixedDraftSignature(current.savedGroups, current.defaults));
    update({ groups: pending ? current.groups : response.groups, savedGroups: response.groups, defaults: response.defaults || current.defaults });
  }
  /** 编辑或正式预览规范化只更新草稿，不改变发布基线。 */
  function setGroups(groups) { update({ groups }); }
  /** 更新正式基线；指定组时仅合并该组的保存或删除结果，保留其他未发布草稿，返回合并后的列表。 */
  function commit(savedGroups, groupId = null) {
    const current = readPageSession('pre-config', 'fixedDraft');
    const groups = groupId ? replaceFixedGroup(current.groups || [], groupId,
      savedGroups.find((group) => group.group_id === groupId) || null) : savedGroups;
    update({ groups, savedGroups });
    return groups;
  }
  /** 丢弃内存和落盘草稿并返回正式基线；不调用临时写入或正式保存。 */
  function discard() {
    const current = readPageSession('pre-config', 'fixedDraft');
    const savedGroups = current.savedGroups || [];
    setDraft({ ...current, groups: savedGroups, savedGroups });
    try { clearFixedDraft(); setStorageError(''); }
    catch { setStorageError('本地草稿清理失败，当前编辑已恢复为上次保存的内容。'); }
    return savedGroups;
  }
  return { groups: draft.groups, defaults: draft.defaults, setGroups, initialize, commit, discard, storageError,
    dirty: draft.groups !== null && draft.savedGroups !== null
      && fixedDraftSignature(draft.groups, draft.defaults) !== fixedDraftSignature(draft.savedGroups, draft.defaults) };
}
