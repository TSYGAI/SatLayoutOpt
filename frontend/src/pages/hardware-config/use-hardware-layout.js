/** 文件说明：测量硬件设置滚动区的实际尺寸，让保存栏对齐内容区、窄屏焦点避开模块导航；不读写资源参数。 */
import { useLayoutEffect, useRef } from 'react';

/** 返回滚动区引用；尺寸变化后同步滚动条宽度和导航高度，卸载时停止观察。 */
export function useHardwareLayout(ready) {
  const scrollRef = useRef(null);
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const shell = scroll?.closest('.hardware-shell');
    if (!shell) return undefined;
    const sidebar = scroll.querySelector('.hardware-sidebar-content');

    /** 仅更新变化的 CSS 尺寸，避免布局观察反复触发相同的样式写入。 */
    function updateMeasurements() {
      const measurements = {
        '--hardware-scrollbar-width': scroll.offsetWidth - scroll.clientWidth,
        '--hardware-sidebar-height': sidebar?.getBoundingClientRect().height || 0,
      };
      for (const [name, size] of Object.entries(measurements)) {
        const value = `${size}px`;
        if (shell.style.getPropertyValue(name) !== value) shell.style.setProperty(name, value);
      }
    }

    const observer = new ResizeObserver(updateMeasurements);
    observer.observe(scroll);
    if (sidebar) observer.observe(sidebar);
    updateMeasurements();
    return () => observer.disconnect();
  }, [ready]);
  return scrollRef;
}
