/**
 * 文件说明：提供前置配置侧边栏的页内分组切换，承载模型设定、关系约束和固定约束面板。
 * 分组选择保留于应用会话，页内切换保留表单挂载状态；不访问 API，也不管理三维预览。
 */

import { useEffect, useRef } from 'react';
import { usePageSessionState } from '../../app/page-session-state.js';

const SECTIONS = Object.freeze([
  { id: 'model-settings', label: '模型设定' },
  { id: 'relation-constraints', label: '关系约束' },
  { id: 'fixed-constraints', label: '固定约束' },
]);

/**
 * 渲染独立切换的侧边栏；隐藏面板保留其表单输入，返回完整的侧边栏区域。
 * @param {{ children: import('react').ReactNode, relationConstraints?: import('react').ReactNode, fixedConstraints?: import('react').ReactNode, onSectionChange?: Function }} props 三组表单及画布所属分组的同步回调。
 */
export function PreConfigSidebar({ children, relationConstraints, fixedConstraints, onSectionChange, navigationRef }) {
  const [activeSection, setActiveSection] = usePageSessionState('pre-config', 'activeSection', SECTIONS[0].id);
  const tabRefs = useRef([]);
  /** 向页面同步当前画布所属分组，恢复会话选项时也会通知。 */
  useEffect(() => { onSectionChange?.(activeSection); }, [activeSection, onSectionChange]);

  /** 离开固定约束前等待草稿保存选择；取消时保留当前面板和键盘焦点。 */
  async function changeSection(id, focus = false) {
    if (id === activeSection) return;
    if (activeSection === 'fixed-constraints' && navigationRef?.current && !await navigationRef.current()) return;
    setActiveSection(id);
    if (focus) tabRefs.current[SECTIONS.findIndex((item) => item.id === id)]?.focus();
  }

  /** 用左右方向键及 Home/End 切换并聚焦分组；其余按键保留浏览器默认行为。 */
  function handleTabKeyDown(event, index) {
    const nextIndex = {
      ArrowLeft: (index + SECTIONS.length - 1) % SECTIONS.length,
      ArrowRight: (index + 1) % SECTIONS.length,
      Home: 0,
      End: SECTIONS.length - 1,
    }[event.key];
    if (nextIndex === undefined) return;
    event.preventDefault();
    void changeSection(SECTIONS[nextIndex].id, true);
  }

  return (
    <aside className="model-sidebar pre-config-sidebar" aria-label="前置配置">
      <div className="pre-config-sidebar-tabs" role="tablist" aria-label="前置配置分组">
        {SECTIONS.map(({ id, label }, index) => (
          <button
            key={id}
            ref={(element) => { tabRefs.current[index] = element; }}
            id={`pre-config-tab-${id}`}
            className="pre-config-sidebar-tab"
            type="button"
            role="tab"
            aria-selected={activeSection === id}
            aria-controls={`pre-config-panel-${id}`}
            tabIndex={activeSection === id ? 0 : -1}
            onClick={() => changeSection(id)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="model-settings-sidebar-body">
        {SECTIONS.map(({ id }) => (
          <section
            key={id}
            id={`pre-config-panel-${id}`}
            className="pre-config-sidebar-panel"
            role="tabpanel"
            aria-labelledby={`pre-config-tab-${id}`}
            hidden={activeSection !== id}
            tabIndex={0}
          >
            {id === SECTIONS[0].id ? children : id === 'relation-constraints' ? relationConstraints : fixedConstraints}
          </section>
        ))}
      </div>
    </aside>
  );
}
