/** 文件说明：区分计算服务所在机器与浏览器渲染设备，展示 CPU、物理内存与 GPU 能力，不推测显存。 */
import { useEffect, useState } from 'react';
import { Boxes, Database, Layers3 } from '../../components/icons.js';
import { formatMemory } from './hardware-config-state.js';

/** 只读取浏览器图形适配器信息，不申请 GPU 设备或修改渲染配置。 */
async function inspectGpu() {
  if (!navigator.gpu) return { label: 'WebGL 兼容渲染', description: '当前浏览器未提供 WebGPU；显存容量无法可靠读取。' };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { label: 'WebGL 兼容渲染', description: '未获取到 WebGPU 适配器；显存容量无法可靠读取。' };
    const info = adapter.info;
    return { label: info?.description || info?.device || 'WebGPU 可用', description: '当前浏览器渲染设备；实际渲染仍按配置和设备初始化结果选择。' };
  } catch { return { label: 'GPU 信息暂不可用', description: '预览会按已有机制尝试 WebGPU 并回退 WebGL。' }; }
}

/** 展示服务器的资源采样与浏览器 GPU，远程访问时不混淆两台电脑的资源。 */
export function HardwareResources({ hardware }) {
  const [gpu, setGpu] = useState({ label: '正在读取图形设备…', description: 'GPU 用于三维显示；几何计算主要使用 CPU。' });
  useEffect(() => {
    let active = true;
    inspectGpu().then((value) => { if (active) setGpu(value); });
    return () => { active = false; };
  }, []);
  return <div className="hardware-resources">
    <article><Boxes aria-hidden="true" /><div><span>计算服务 CPU</span><strong>{hardware.logical_cpus} 个逻辑处理器</strong><small>计算服务所在电脑</small></div></article>
    <article><Database aria-hidden="true" /><div><span>计算服务内存</span><strong>{formatMemory(hardware.total_memory_bytes)}</strong><small>读取时可用 {formatMemory(hardware.available_memory_bytes)}</small></div></article>
    <article><Layers3 aria-hidden="true" /><div><span>浏览器 GPU</span><strong title={gpu.label}>{gpu.label}</strong><small>{gpu.description}</small></div></article>
  </div>;
}
