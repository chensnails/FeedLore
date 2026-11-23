/* 视图路由（V4.4，零依赖实现）。
 *
 * 背景：视图切换历史上靠手写 hash 解析（util.parseHash 的一串 startsWith）与
 * writeHash(replaceState) 维护，路由语法没有单一声明源，新增一种深链要在多处改分支。
 * 这里保留声明式路由表：hash → { tab, artId } 的解析统一走本模块，路由生成走命名模板。
 *
 * V6.1 起不再从 react-router-dom 引 matchPath：全项目只用到了这一个函数，却把整个
 * 路由包（含 RouterProvider / useNavigate 等永不使用的代码）打进首屏 vendor。
 * 本表的模式只有「字面段 + :命名段」两种，十几行匹配器就够，行为与原来的
 * matchPath({ end: true }) 一致（完整段匹配、参数 decodeURIComponent）。
 *
 * 兼容约束（产品刻意设计，不可破）：
 *  - 笺川**不把视图/文章写进浏览器历史**（replace-only，避免「读 20 篇后退 20 次」）；
 *  - util.parseHash / writeHash 的门面保留，内部委托给本模块；测试钉的 hash 格式不变。
 */
import type { ViewTab } from '../core/types.ts';

/** 路由模式表：path 用命名段语法（兼容原 React Router 模式字符串），tab 对应 state.tab。 */
export const ROUTES = Object.freeze([
  { path: '/reader/art/:artId', tab: 'reader', art: true },
  { path: '/reader', tab: 'reader', art: false },
  { path: '/cards', tab: 'cards', art: false },
  { path: '/ai', tab: 'ai', art: false },
  { path: '/digest', tab: 'ai', art: false }, // 老深链兼容
  { path: '/favorite', tab: 'reader', art: false, scope: 'favorite' },
  { path: '/unread', tab: 'reader', art: false, scope: 'unread' },
] as const);

/** 解析 hash（'#/reader/art/x' 或旧式 '#reader/art/x'）为路由匹配结果。 */
export interface RouteMatch {
  path: string;
  tab: ViewTab;
  art: boolean;
  scope?: string;
  params: Record<string, string | undefined>;
}

/** 完整段匹配：字面段必须相等，:name 段捕获一段；段数不等即不匹配。 */
function matchSegments(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/').filter(Boolean);
  const got = path.split('/').filter(Boolean);
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const seg = want[i];
    if (seg == null) return null;
    if (seg.startsWith(':')) params[seg.slice(1)] = got[i] ?? '';
    else if (seg !== got[i]) return null;
  }
  return params;
}

export function matchViewHash(hash: string | null | undefined): RouteMatch | null {
  const raw = String(hash || '').replace(/^#\/?/, '');
  if (!raw) return null;
  for (const r of ROUTES) {
    const params = matchSegments(r.path, raw);
    if (params) {
      // viewHash 生成时 encodeURIComponent 过，这里还原成原始 artId
      // （与旧 matchPath + decodeURIComponent 的语义一致）。
      if (params.artId != null) {
        try {
          params.artId = decodeURIComponent(params.artId);
        } catch (_) {
          /* 非法百分号序列：保留原值 */
        }
      }
      return { ...r, params };
    }
  }
  return null;
}

/** 生成视图 hash（replace-only 语义由调用方 writeHash 保证）。 */
export function viewHash(tab: ViewTab, artId?: string | number | null): string {
  if (tab === 'reader' && artId != null) return '#/reader/art/' + encodeURIComponent(String(artId));
  if (tab === 'cards') return '#/cards';
  if (tab === 'ai') return '#/ai';
  return '#/reader';
}
