/* 视图路由（V4.4 / React Router）。
 *
 * 背景：视图切换历史上靠手写 hash 解析（util.parseHash 的一串 startsWith）与
 * writeHash(replaceState) 维护，路由语法没有单一声明源，新增一种深链要在多处改分支。
 * 这里用 React Router 的 matchPath 作为路由模式的唯一声明：hash → { tab, artId } 的
 * 解析统一走 matchRoutes，路由生成走命名模板。
 *
 * 兼容约束（产品刻意设计，不可破）：
 *  - 笺川**不把视图/文章写进浏览器历史**（replace-only，避免「读 20 篇后退 20 次」）。
 *    因此这里只用 matchPath 做解析，不挂 RouterProvider、不用 useNavigate 的 push 语义。
 *  - util.parseHash / writeHash 的门面保留，内部委托给本模块；测试钉的 hash 格式不变。
 */
import { matchPath } from 'react-router-dom';

/** 路由模式表：path 用 React Router 语法，name 对应 state.tab。 */
export const ROUTES = Object.freeze([
  { path: '/reader/art/:artId', tab: 'reader', art: true },
  { path: '/reader', tab: 'reader', art: false },
  { path: '/cards', tab: 'cards', art: false },
  { path: '/ai', tab: 'ai', art: false },
  { path: '/digest', tab: 'ai', art: false }, // 老深链兼容
  { path: '/favorite', tab: 'reader', art: false, scope: 'favorite' },
  { path: '/unread', tab: 'reader', art: false, scope: 'unread' },
]);

/** 解析 hash（'#/reader/art/x' 或旧式 '#reader/art/x'）为路由匹配结果。 */
export function matchViewHash(hash: any): any {
  const raw = String(hash || '').replace(/^#\/?/, '');
  if (!raw) return null;
  for (const r of ROUTES) {
    const m = matchPath({ path: r.path, end: true }, '/' + raw);
    if (m && m.params) {
      // matchPath 不解码 params：viewHash 生成时 encodeURIComponent 过，这里还原，
      // 让调用方拿到原始 artId（与旧 parseHash 直接 slice 的语义一致）。
      // Params 的索引签名只读，故构造新对象而非原地改。
      const params = { ...m.params };
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
export function viewHash(tab: any, artId?: any): string {
  if (tab === 'reader' && artId != null) return '#/reader/art/' + encodeURIComponent(String(artId));
  if (tab === 'cards') return '#/cards';
  if (tab === 'ai') return '#/ai';
  return '#/reader';
}
