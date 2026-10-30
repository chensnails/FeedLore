import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * 纯前端 UI 状态（与服务端无关）：选中频道、列表筛选/排序/视图、正在阅读的条目、临时提示。
 *
 * 分工铁律：
 * - 服务端数据（会话、频道、条目、偏好）→ TanStack Query，**不进这里**；
 * - 只影响「怎么显示」的选择 → 这里，且持久化到 localStorage。
 * v1.x 的 `state` 之所以难维护，就是因为这两类混在一个可变对象里。
 *
 * ⚠️ 这里的 view / sort / filter 同时也是**账号级布局偏好**（服务端 `layout` 表里有同名字段）。
 * 处理方式是「本地先变、异步写服务端」：本地的目的是点击立刻见效（不等网络往返），
 * 服务端的目的是换设备/换浏览器后还是这个样子。只写本地 = 换设备就丢；
 * 只读服务端 = 每次点一下都等请求回来才变色。
 */

export interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'error';
}

/**
 * 确认框请求。用 Promise 而不是「打开/关闭两个状态」是为了让调用方保持
 * `if (!(await ask())) return;` 这种直线写法 —— 否则删除逻辑会被劈成两段，
 * 中间隔着一次重渲染，非常容易在「取消后仍然执行下一步」上出错。
 */
export interface ConfirmRequest {
  title: string;
  body?: string;
  /** 确认按钮文案，默认「确定」 */
  okText?: string;
  /** 危险操作（删除类）：确认按钮用警示色 */
  danger?: boolean;
}

/** 覆盖式面板。三者互斥（同一时刻只开一个），所以用一个字段而不是三个布尔。 */
export type Panel = 'settings' | 'digest' | 'admin';

/** 设置面板页签。`channels` 承载「频道分组 / 频道源管理」（从频道栏迁入）。 */
export type PrefsTab = 'appearance' | 'reading' | 'channels' | 'watch' | 'filter' | 'account';

/**
 * 列表筛选。`all` 之外的四档对应服务端的 unread / fav / watch 参数。
 */
export type ListFilter = 'all' | 'unread' | 'favorite' | 'watch' | 'block';
export type ListSort = 'new' | 'old' | 'name';
export type ListView = 'grid' | 'list';

interface UiState {
  /** 选中的频道 id（字符串，与契约一致）；null = 全部频道 */
  feedId: string | null;
  /**
   * 「只看这一组」的分组名；null = 不限分组。
   *
   * 与 `feedId` **互斥**：选频道会清掉分组、选分组会清掉频道。理由是这两者都决定
   * 「列表范围」，同时生效时用户无法从标题判断自己在看哪一批 —— 那正是 v1 里
   * 漏斗图标最容易被误解的地方（它同时承担折叠和筛选两种语义）。
   */
  groupName: string | null;
  /** 列表筛选（替代 v2 早期的 onlyUnread 布尔：那个只能表达「未读/全部」两档） */
  filter: ListFilter;
  /** 排序 */
  sort: ListSort;
  /** 卡片视图：grid = 封面网格，list = 一行一条的紧凑列表 */
  view: ListView;
  /** 标签筛选（服务端 `tag` 参数）；null = 不筛 */
  tag: string | null;
  /** 正在阅读的条目 id；null = 未打开阅读层 */
  readingId: string | null;
  /** 列表搜索词（服务端搜索，不是前端过滤）。空串 = 不搜 */
  search: string;
  /** 窄屏抽屉是否展开。桌面端不用它（侧栏常驻） */
  navOpen: boolean;
  /** 当前打开的覆盖式面板（设置 / 日报 / 管理）；null = 都关着 */
  panel: Panel | null;
  /** 打开设置时直接定位到哪个页签（如频道栏的「频道管理」→ channels）；null = 保持默认 */
  prefsTab: PrefsTab | null;
  /** 临时提示（写操作结果）。不持久化，3 秒后自动消失。 */
  toast: Toast | null;
  /** 当前挂着的确认框；null = 没有 */
  confirmState: ConfirmRequest | null;
  setFeedId: (id: string | null) => void;
  /** 只看某个分组；传 null 取消 */
  setGroupName: (name: string | null) => void;
  setFilter: (f: ListFilter) => void;
  setSort: (s: ListSort) => void;
  setView: (v: ListView) => void;
  setTag: (t: string | null) => void;
  setSearch: (q: string) => void;
  openEntry: (id: string) => void;
  closeEntry: () => void;
  openNav: () => void;
  closeNav: () => void;
  toggleNav: () => void;
  setPanel: (p: Panel | null) => void;
  /** 打开设置面板（可指定初始页签） */
  openSettings: (tab?: PrefsTab) => void;
  notify: (text: string, tone?: 'ok' | 'error') => void;
  dismissToast: () => void;
  /** 弹确认框并等用户选择 */
  askConfirm: (req: ConfirmRequest) => Promise<boolean>;
  /** 由对话框组件调用：结掉挂起的 Promise */
  resolveConfirm: (ok: boolean) => void;
}

let toastSeq = 0;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
/** 挂起中的确认请求。模块级而不是 state：它是个回调，进 state 会触发重渲染且没法序列化。 */
let confirmResolver: ((ok: boolean) => void) | null = null;

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      feedId: null,
      groupName: null,
      filter: 'all',
      sort: 'new',
      view: 'grid',
      tag: null,
      readingId: null,
      search: '',
      navOpen: false,
      panel: null,
      prefsTab: null,
      toast: null,
      confirmState: null,
      /* 选中频道后自动收起抽屉：手机上点频道的目的就是「看这个频道的列表」，
       * 抽屉不收起来会挡住刚点出来的内容，用户还得多点一次。 */
      setFeedId: (feedId) => set({ feedId, groupName: null, navOpen: false, tag: null }),
      /* 只看分组：同样收起抽屉、清掉频道与标签。
       * 清频道是「互斥」规则的一半（另一半在 setFeedId 里），见接口注释。 */
      setGroupName: (groupName) => set({ groupName, feedId: null, navOpen: false, tag: null }),
      /* 切筛选时也清掉标签：标签云是「当前频道范围」的统计，不支持与关注/屏蔽视图叠加
       * （服务端 tagCounts 不按 watch_state 过滤）。留着旧标签会出现一个谁都解释不清的空列表。 */
      setFilter: (filter) => set({ filter, tag: null }),
      setSort: (sort) => set({ sort }),
      setView: (view) => set({ view }),
      setTag: (tag) => set({ tag }),
      setSearch: (search) => set({ search }),
      openEntry: (readingId) => set({ readingId, navOpen: false }),
      closeEntry: () => set({ readingId: null }),
      openNav: () => set({ navOpen: true }),
      closeNav: () => set({ navOpen: false }),
      toggleNav: () => set((s) => ({ navOpen: !s.navOpen })),
      /* 通用打开/关闭：走这里时清空 prefsTab，避免「上次停在频道页签」被带到下次普通打开 */
      setPanel: (panel) => set({ panel, prefsTab: null }),
      openSettings: (tab) => set({ panel: 'settings', prefsTab: tab ?? null }),

      /* 写操作的提示必须集中一处：散在各组件里就会出现「有的失败静默、有的弹 alert」。 */
      notify: (text, tone = 'ok') => {
        toastSeq += 1;
        if (toastTimer) clearTimeout(toastTimer);
        set({ toast: { id: toastSeq, text, tone } });
        toastTimer = setTimeout(() => {
          set((s) => (s.toast && s.toast.id === toastSeq ? { toast: null } : s));
        }, tone === 'error' ? 6000 : 3000);
      },
      dismissToast: () => {
        if (toastTimer) clearTimeout(toastTimer);
        set({ toast: null });
      },

      /* 同一个时刻只该有一个确认框。已经挂着一个时把旧的那个按「取消」结掉 ——
       * 不结的话那次 await 永远不返回，调用方的后续（提示、刷新）就静默消失了。 */
      askConfirm: (req) => {
        if (confirmResolver) {
          const prev = confirmResolver;
          confirmResolver = null;
          prev(false);
        }
        return new Promise<boolean>((resolve) => {
          confirmResolver = resolve;
          set({ confirmState: req });
        });
      },
      resolveConfirm: (ok) => {
        const r = confirmResolver;
        confirmResolver = null;
        set({ confirmState: null });
        r?.(ok);
      },
    }),
    {
      name: 'feedlore.ui',
      version: 2,
      /* 阅读层与提示都是瞬时状态，刷新后不该自动弹回来。
       * tag 也不留：带着上次的标签刷新，看到的会是一个莫名其妙的空列表。
       *
       * 注意这里的定位：**URL 才是主真相源**（深链可分享、后退可恢复），
       * localStorage 只是「地址栏里什么都没有」时的兜底（登录跳转回来、
       * 用户手删 hash）。两者冲突时 URL 赢，见 lib/route.ts 的 hydrate。 */
      partialize: (s) => ({
        feedId: s.feedId,
        groupName: s.groupName,
        filter: s.filter,
        sort: s.sort,
        view: s.view,
      }),
      /* v2 早期只存了 `onlyUnread` 布尔。不迁移的话老用户的「只看未读」会静默关掉
       * （布尔字段被新代码忽略 = 变回全部），而这种「升级后设置被重置」没人会去查。
       *
       * 返回类型被 persist 收窄成 partialize 的返回形状，
       * 所以这里显式挑字段，而不是把整包 state 甩回去。 */
      migrate: (state, from) => {
        const old = (state ?? {}) as {
          feedId?: string | null;
          groupName?: string | null;
          onlyUnread?: boolean;
          filter?: ListFilter;
          sort?: ListSort;
          view?: ListView;
        };
        const pick = {
          feedId: old.feedId ?? null,
          groupName: old.groupName ?? null,
          sort: old.sort ?? 'new',
          view: old.view ?? 'grid',
        };
        if (from < 2) return { ...pick, filter: old.onlyUnread ? 'unread' : 'all' };
        return { ...pick, filter: old.filter ?? 'all' };
      },
    },
  ),
);
