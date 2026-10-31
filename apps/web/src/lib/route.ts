import { useEffect } from 'react';
import { useUi, type ListFilter, type ListSort, type ListView, type Panel } from '../store/ui';

/**
 * 地址栏 ↔ UI 状态 的双向同步（深链 + 浏览器后退）。
 *
 * v1 有六种 hash（`#reader/art/<id>`、`#cards`、`#favorite`、`#unread`、`#digest`、
 * `#settings`），v2 一直没做，代价是四件事一起坏：单篇发不出去、刷新丢阅读层、
 * 手机返回键直接退出应用、浏览器后退键无效。
 *
 * ## 为什么是 hash 而不是 path
 * 生产是 Hono 同源托管静态产物 + service worker。改用 `/a/123` 这种 path 需要
 * 服务端配 fallback、sw 的导航兜底也要跟着改，而 hash 天然不需要任何服务端配合。
 *
 * ## 哪些变更进历史，哪些原地替换
 * 这是唯一真正需要判断的地方。规则：
 * - **进历史（push）**：换范围/换面板 —— 频道、分组、筛选、标签、打开阅读层。
 *   这些是「我去了别处」，后退应该回来。
 * - **原地替换（replace）**：改排序/视图/搜索词、阅读层里翻篇。
 *   这些是「同一处的调整」，每次打字都进历史会让后退键变成「一个字一个字退」。
 */

export interface RouteState {
  feedId: string | null;
  groupName: string | null;
  filter: ListFilter;
  sort: ListSort;
  view: ListView;
  tag: string | null;
  search: string;
  entryId: string | null;
  panel: Panel | null;
}

const EMPTY: RouteState = {
  feedId: null,
  groupName: null,
  filter: 'all',
  sort: 'new',
  view: 'grid',
  tag: null,
  search: '',
  entryId: null,
  panel: null,
};

const FILTERS: readonly ListFilter[] = ['all', 'unread', 'favorite', 'watch', 'block'];
const SORTS: readonly ListSort[] = ['new', 'old', 'name'];
const VIEWS: readonly ListView[] = ['grid', 'list'];
const PANELS: readonly Panel[] = ['settings', 'digest'];

/** 形如 `#/f/12/a/34?filter=unread&sort=old`。默认值一律不写进地址栏。 */
export function buildRoute(s: RouteState): string {
  const seg: string[] = [];
  /* 频道与分组互斥：同时存在时只写频道（store 里也保证不会同时有值，
   * 这里再判一次是防止手工拼接的 URL 把两个都塞进来导致标题说不清范围）。 */
  if (s.feedId) seg.push('f', encodeURIComponent(s.feedId));
  else if (s.groupName) seg.push('g', encodeURIComponent(s.groupName));
  if (s.entryId) seg.push('a', encodeURIComponent(s.entryId));
  if (s.panel) seg.push(s.panel);

  const p = new URLSearchParams();
  if (s.filter !== 'all') p.set('filter', s.filter);
  if (s.sort !== 'new') p.set('sort', s.sort);
  if (s.view !== 'grid') p.set('view', s.view);
  if (s.tag) p.set('tag', s.tag);
  if (s.search) p.set('q', s.search);

  const qs = p.toString();
  return `#/${seg.join('/')}${qs ? `?${qs}` : ''}`;
}

export function parseRoute(hash: string): RouteState {
  const out: RouteState = { ...EMPTY };
  const raw = String(hash || '').replace(/^#/, '').replace(/^\//, '');
  if (!raw) return out;

  const qi = raw.indexOf('?');
  const path = qi >= 0 ? raw.slice(0, qi) : raw;
  const qs = qi >= 0 ? raw.slice(qi + 1) : '';

  const seg = path.split('/').filter(Boolean);
  for (let i = 0; i < seg.length; i += 1) {
    const key = seg[i];
    if (!key) break;
    if (key === 'f' || key === 'g' || key === 'a') {
      const next = seg[i + 1];
      if (next === undefined) break; // 尾部残缺（手工编辑到一半）就停，不抛
      i += 1;
      let val = next;
      /* 手输的中文分组名可能不是合法转义序列。decode 失败就按原样用 ——
       * 这一层抛错会让整个应用白屏，而白屏比「分组名显示成 %E6%8A」糟得多。 */
      try {
        val = decodeURIComponent(next);
      } catch {
        /* 保留原文 */
      }
      if (key === 'f') out.feedId = val;
      else if (key === 'g') out.groupName = val;
      else out.entryId = val;
    } else if ((PANELS as readonly string[]).includes(key)) {
      out.panel = key as Panel;
    }
  }

  const p = new URLSearchParams(qs);
  const f = p.get('filter');
  if (f && (FILTERS as readonly string[]).includes(f)) out.filter = f as ListFilter;
  const s = p.get('sort');
  if (s && (SORTS as readonly string[]).includes(s)) out.sort = s as ListSort;
  const v = p.get('view');
  if (v && (VIEWS as readonly string[]).includes(v)) out.view = v as ListView;
  out.tag = p.get('tag') || null;
  out.search = p.get('q') || '';
  return out;
}

/* ------------------------------------------------------------------ 同步 */

/** 正在「从地址栏写 store」，此时不要反过来再写地址栏（会打架）。 */
let applying = false;

/** 当前 store 快照转成路由状态。 */
function snapshot(): RouteState {
  const s = useUi.getState();
  return {
    feedId: s.feedId,
    groupName: s.groupName,
    filter: s.filter,
    sort: s.sort,
    view: s.view,
    tag: s.tag,
    search: s.search,
    entryId: s.readingId,
    panel: s.panel,
  };
}

/**
 * 把一份路由状态写回 store。
 *
 * 用一次 `setState` 而不是逐个 setter：逐个调用会触发多次订阅回调，
 * 中间态（比如 feedId 已改、groupName 还没清）会被当成一次真实变更写进地址栏，
 * 后退历史里就多出一条谁也没见过的状态。
 */
function applyRoute(r: RouteState): void {
  applying = true;
  useUi.setState({
    feedId: r.feedId,
    groupName: r.groupName,
    filter: r.filter,
    sort: r.sort,
    view: r.view,
    tag: r.tag,
    search: r.search,
    readingId: r.entryId,
    panel: r.panel,
  });
  applying = false;
}

function writeHash(hash: string, mode: 'push' | 'replace'): void {
  /* `reader` 标记只在「我们自己 push 出来的那条」上为 true，
   * 关闭阅读层时靠它决定是 back() 还是 replace —— 见 onStoreChange。 */
  const state = { ...(window.history.state || {}), reader: Boolean(parseRoute(hash).entryId) };
  if (mode === 'push') window.history.pushState(state, '', hash);
  else window.history.replaceState(state, '', hash);
}

/**
 * 这次变更该不该进历史。
 * 只有「换了个地方」才 push；「同一个地方调整一下」一律 replace。
 */
function shouldPush(prev: RouteState, next: RouteState): boolean {
  /* 打开阅读层：从「没有条目」到「有条目」是一次真正的跳转，必须进历史，
   * 否则后退键回不到列表 —— 这条和下面的「关闭」是一对，漏任何一个都会让
   * 后退键在「文章 ↔ 列表」这条主干路径上失效。
   * （条目→条目 = 翻篇，落在最后 return false 走 replace，避免历史爆炸。） */
  if (!prev.entryId && next.entryId) return true;

  // 关闭阅读层在 onStoreChange 里单独处理（走 back），这里只关心「换范围」
  if (prev.feedId !== next.feedId) return true;
  if (prev.groupName !== next.groupName) return true;
  if (prev.panel !== next.panel) return true;
  if (prev.filter !== next.filter) return true;
  if (prev.tag !== next.tag) return true;
  return false;
}

function onStoreChange(): void {
  if (applying) return;

  const next = snapshot();
  const prev = parseRoute(window.location.hash);

  /* 关闭阅读层：如果这条历史是我们 push 出来的，就应该真的「退回去」，
   * 而不是把当前这条改成无 entry 的版本 —— 后者会在历史里留下一条
   * 和第列表页一模一样的记录，用户按后退看起来「没反应」。
   * 直接深链进来（历史里没有 reader 标记）的才用 replace 去掉 a 段。 */
  if (prev.entryId && !next.entryId) {
    if (window.history.state?.reader) {
      window.history.back(); // 真正的回退交给 popstate 处理
      return;
    }
    writeHash(buildRoute(next), 'replace');
    return;
  }

  const hash = buildRoute(next);
  if (hash === window.location.hash) return;
  writeHash(hash, shouldPush(prev, next) ? 'push' : 'replace');
}

function onLocationChange(): void {
  const r = parseRoute(window.location.hash);
  // 地址栏与 store 已经一致时不必再 setState（避免无谓重渲染）
  const cur = snapshot();
  if (buildRoute(cur) === buildRoute(r)) return;
  applyRoute(r);
}

/**
 * 首帧之前把地址栏同步进 store。
 *
 * 必须在 React 渲染前调用（放在 main.tsx 里）：EntriesPanel 用 store 里的筛选条件
 * 生成 queryKey，晚一步的话会先用 localStorage 的值发一次请求，再改条件重发一次，
 * 表现为「刷新时列表闪一下」。
 */
export function hydrateFromRoute(): void {
  const raw = window.location.hash;
  const meaningful = raw && raw !== '#' && raw !== '#/';

  if (!meaningful) {
    /* 地址栏什么都没有（登录跳回来、用户手删了 hash）：把 localStorage 里的状态
     * 写进地址栏。用 replace，否则用户在应用里按后退会先「退回没有 hash 的自己」。 */
    writeHash(buildRoute(snapshot()), 'replace');
    return;
  }
  applyRoute(parseRoute(raw));
}

/** 在应用壳里挂一次：接上 popstate / hashchange / store 变更三路。 */
export function useRouteSync(): void {
  useEffect(() => {
    const unsubscribe = useUi.subscribe(onStoreChange);
    window.addEventListener('popstate', onLocationChange);
    /* 手改地址栏 / 站内返回等场景只有 hashchange，没有 popstate。
     * 两个都挂不会重复生效：onLocationChange 里有「已经一致就跳过」的短路。 */
    window.addEventListener('hashchange', onLocationChange);
    return () => {
      unsubscribe();
      window.removeEventListener('popstate', onLocationChange);
      window.removeEventListener('hashchange', onLocationChange);
    };
  }, []);
}
