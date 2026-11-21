/* 错误边界通用测试入口：渲染一个按开关抛错的叶子组件，罩上 ErrorBoundary。
 * 测试通过 w.__ebSetThrow(true/false) 控制抛错，验证 fallback 与重试出口。 */
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '../../src/ui/ErrorBoundary.tsx';

function Bomb({ shouldThrow }) {
  if (shouldThrow) throw new Error('synthetic render failure for boundary test');
  return <div className="eb-ok">正常内容</div>;
}

window.__mountErrorBoundary = (el, scope = 'view') => {
  window.__ebThrow = false;
  const r = createRoot(el);
  const render = () =>
    r.render(
      <ErrorBoundary label="测试视图" scope={scope}>
        <Bomb shouldThrow={window.__ebThrow} />
      </ErrorBoundary>,
    );
  window.__ebRerender = render;
  window.__ebSetThrow = (v) => {
    window.__ebThrow = !!v;
    render();
  };
  render();
  return r;
};
