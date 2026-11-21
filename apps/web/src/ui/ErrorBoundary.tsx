/* 运行期错误边界（最后一道网，不替代防御式编码）。
 *
 * 启动层的 catch 只覆盖「外壳还没画出来」的阶段；ready 之后任何视图渲染期抛错，
 * React 19 默认会卸掉整棵树 —— 用户看到的是一片白屏，且没有任何恢复出口。
 * 这里给应用根与四个大视图各罩一层：错误只降级出问题的那一块，其它视图继续可用。
 * fallback 不展示英文堆栈（那是开发者的信息，不是用户的信息），只给中文说明与三个出口。
 */
import { core } from '@core';
import React from 'react';

type BoundaryScope = 'app' | 'view';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** 出问题的区域名，仅用于中文提示，如「文章页」「设置」。 */
  label: string;
  /** app 级 fallback 需要全屏兜底；view 级只占宿主容器。 */
  scope?: BoundaryScope;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** 应用级 / 视图级共用；重试靠重置 state 让子树重新挂载。 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 开发者侧保留完整堆栈（控制台），用户侧只给中文文案；不把 error.message 塞进 DOM。
    console.error(`[FeedLore] ${this.props.label}渲染异常`, error, info.componentStack);
  }

  private readonly retry = () => {
    this.setState({ error: null });
  };

  private readonly backToReader = () => {
    // 走统一的视图切换入口（唯一实现），切换前先复位边界，否则旧 fallback 会留在 DOM 里。
    this.setState({ error: null }, () => {
      try {
        core.switchView('reader');
      } catch {
        /* 桥未就绪时「重新加载」出口仍然存在 */
      }
    });
  };

  private readonly reload = () => {
    window.location.reload();
  };

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { label, scope = 'view' } = this.props;
    return (
      <div
        className={'eb-fallback' + (scope === 'app' ? ' eb-fallback-app' : '')}
        role="alert"
        aria-live="assertive"
      >
        <div className="eb-icon" aria-hidden="true">
          !
        </div>
        <h3>{label}暂时无法显示</h3>
        <p>这部分内容遇到了一个显示问题，其他页面仍可正常使用。你可以重试或换个入口继续。</p>
        <div className="eb-actions">
          <button type="button" className="btn primary" onClick={this.retry}>
            重试
          </button>
          <button type="button" className="btn" onClick={this.backToReader}>
            回到文章页
          </button>
          <button type="button" className="btn" onClick={this.reload}>
            重新加载
          </button>
        </div>
      </div>
    );
  }
}
