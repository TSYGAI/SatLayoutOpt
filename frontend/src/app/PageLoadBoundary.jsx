/**
 * 文件说明：功能页统一加载与异常边界，在懒加载或渲染失败期间保留公共菜单并提供恢复入口。
 * 本组件只管理页面级展示状态，不处理页面业务数据、接口重试或 Three.js 资源生命周期。
 */

import { Component, Suspense } from 'react';
import { LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';

import { AppShell } from './AppShell.jsx';
import '../../styles/page-loading.css';

/** 渲染页面加载中的稳定占位界面。 */
function PageLoadingState({ pageTitle }) {
  return (
    <AppShell className="page-state-shell" pageTitle={pageTitle} status="页面加载中" preservePagePosition={false}>
      <main className="page-state" aria-live="polite" aria-busy="true">
        <div className="page-state-content">
          <LoaderCircle className="page-state-spinner" aria-hidden="true" />
          <strong>{pageTitle}正在加载</strong>
        </div>
      </main>
    </AppShell>
  );
}

/** 捕获单个功能页的加载或渲染异常，避免异常卸载整个应用菜单。 */
class PageErrorBoundary extends Component {
  /** 初始化当前功能页的异常状态。 */
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.handleRetry = this.handleRetry.bind(this);
  }

  /** 将子树抛出的异常转换为可恢复的页面状态。 */
  static getDerivedStateFromError(error) {
    return { error };
  }

  /** 把页面异常写入浏览器控制台，供开发环境定位原始堆栈。 */
  componentDidCatch(error, details) {
    console.error(`功能页“${this.props.pageTitle}”加载失败`, error, details);
  }

  /** 重新加载当前地址，让动态模块和页面初始化从干净状态重试。 */
  handleRetry() {
    window.location.reload();
  }

  /** 在正常子树和异常恢复界面之间切换。 */
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <AppShell
        className="page-state-shell"
        pageTitle={this.props.pageTitle}
        status="页面加载失败"
        preservePagePosition={false}
      >
        <main className="page-state" role="alert">
          <div className="page-state-content is-error">
            <TriangleAlert aria-hidden="true" />
            <strong>{this.props.pageTitle}暂时无法打开</strong>
            <button type="button" onClick={this.handleRetry}>
              <RefreshCw aria-hidden="true" />
              重新加载
            </button>
          </div>
        </main>
      </AppShell>
    );
  }
}

/** 为一个功能页组合加载占位与渲染异常恢复能力。 */
export function PageLoadBoundary({ children, pageTitle }) {
  return (
    <PageErrorBoundary pageTitle={pageTitle}>
      <Suspense fallback={<PageLoadingState pageTitle={pageTitle} />}>
        {children}
      </Suspense>
    </PageErrorBoundary>
  );
}
