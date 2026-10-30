import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { api } from '../lib/api';
import { flattenEntries, qk, type EntriesPages } from '../lib/query';
import { useSaveAppearance, useSetFavorite, useSetRead } from '../lib/mutations';
import { useSwipeDismiss } from '../lib/useSwipeDismiss';
import { useOverlayFocus } from '../lib/useOverlayFocus';
import { useUi } from '../store/ui';
import type { EntriesList } from '../lib/types';
import { ArticleBody } from './ArticleBody';
import { Icon } from './Icon';
import { Thumb } from './Thumb';

/** 正文块里有没有图片。字符串探测就够：块 JSON 由服务端生成，形状固定且不含嵌套。 */
function hasBodyImages(json: string | null): boolean {
  return typeof json === 'string' && json.includes('"t":"img"');
}

const FS_ORDER = ['s', 'm', 'l'] as const;
const FS_LABEL = { s: '小', m: '中', l: '大' } as const;

/**
 * 阅读层（覆盖式）：只在打开某条时才请求详情。
 *
 * 列表不带正文、详情才带 —— 这是服务端定下的契约，也是流量上的必然选择
 * （30 条 × 几千字会让列表响应大一个数量级）。所以这里是一次独立请求，
 * 点开即有缓存、再点开秒开（staleTime 30s）。
 *
 * 对齐 v1 阅读页的三件事（都是「读完一段才想起来要做」的动作）：
 * - **字号随手加减**：A- / A+ 直接改账号偏好，和设置里的「正文字号」是同一份数据；
 * - **复制链接 / 提取码**：网盘类条目最常做的操作，比「打开原文再复制」少两步；
 * - **下拉收起**：手机上整屏弹层没有遮罩可点，× / Esc / 下拉是全部出口。
 */
export function EntryReader() {
  const readingId = useUi((s) => s.readingId);
  const close = useUi((s) => s.closeEntry);
  const setFavorite = useSetFavorite();
  const saveAppearance = useSaveAppearance();
  const setRead = useSetRead();
  const qc = useQueryClient();

  const { data, isPending, isError, error } = useQuery({
    queryKey: [...qk.entry, readingId],
    queryFn: () => api.entries.detail(readingId as string),
    enabled: readingId !== null,
  });

  /* 阅读层的字号只读一次偏好、之后以本地点击为准是不可能的（偏好是服务端状态），
   * 所以这里从 prefs 缓存读当前档位，点 A- / A+ 时按档位增减。 */
  const prefsQuery = useQuery({
    queryKey: qk.prefs,
    queryFn: () => api.prefs.get(),
    staleTime: 5 * 60_000,
  });
  const fs = prefsQuery.data?.appearance.readerFs ?? 'm';

  const { panelRef, handlers } = useSwipeDismiss(close);
  useOverlayFocus(!!readingId, panelRef);

  /* 上一条 / 下一条：按**当前列表的顺序**走（不是按时间重新排）。
   *
   * 为什么从缓存里找位置而不是另开一个「相邻条目」接口：列表数据本来就在缓存里，
   * 顺序、筛选、排序都已经是用户看到的那一份；再让服务端算一次「相邻」，
   * 两边在筛选条件上稍有出入就会出现「下一篇」跳到用户根本没在看的范围内。
   *
   * 缓存形状是无限滚动的 `{ pages }`，统一用 flattenEntries 拍平 —— 不能让
   * 「翻篇」这条链路自己知道分页细节（否则调一次 limit 就要改两处）。
   *
   * 已知边界：翻到**已加载的最后一页末尾**时 next 为 null。此时不自动追加下一页 ——
   * 阅读层里再触发一次分页会把「正在读的东西」和「列表在加载」耦合起来，
   * 关掉阅读层滚一下即可，代价小且不会出错。
   *
   * `data` 进依赖是有意的：切换条目后详情变了，说明当前条目在列表里的位置要重算。 */
  const neighbors = useMemo(() => {
    if (!readingId) return null;
    const lists = qc.getQueriesData<EntriesList | EntriesPages>({ queryKey: qk.entries });
    for (const [, list] of lists) {
      const all = flattenEntries(list);
      if (!all.length) continue;
      const i = all.findIndex((e) => e.id === readingId);
      if (i < 0) continue;
      return {
        prev: all[i - 1]?.id ?? null,
        next: all[i + 1]?.id ?? null,
        pos: i + 1,
        total: all.length,
      };
    }
    return null;
  }, [qc, readingId, data]);

  /** 切到相邻条目：同时补一次已读标记（在阅读层里翻篇，同样算读过了）。 */
  function step(to: string | null): void {
    if (!to) return;
    useUi.getState().openEntry(to);
    setRead.mutate({ id: to, isRead: true });
  }

  /* 键盘：Esc 关闭 · ← / → 翻篇（与 v1 的 ReaderView 一致）。
   *
   * 三条必须处理的情况：
   * 1. **灯箱开着时要让路**：灯箱的监听也挂在 window 上，这里不退出的话按一次 →
   *    会「翻一张图 + 翻一篇」—— 用户看到的是图片换了、文章也没了。
   *    用 DOM 存在性判断而不是共享 state：灯箱在 ArticleBody 内部，为了一个按键
   *    把它的开关提到阅读层，只会多一条不必要的状态链。
   * 2. 焦点在输入框里不劫持方向键。
   * 3. 到头了（第一篇/最后一篇）什么都不做，也不 preventDefault —— 让浏览器
   *    的默认滚动还能用。 */
  const setReadRef = useRef(setRead);
  setReadRef.current = setRead;
  useEffect(() => {
    if (!readingId) return;
    const onKey = (e: KeyboardEvent): void => {
      if (document.querySelector('.lightbox')) return;
      // 确认框在最上层：它的 Esc 只该关它自己
      if (useUi.getState().confirmState) return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;

      if (e.key === 'Escape') {
        close();
        return;
      }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const to = e.key === 'ArrowLeft' ? neighbors?.prev : neighbors?.next;
      if (!to) return;
      e.preventDefault();
      useUi.getState().openEntry(to);
      setReadRef.current.mutate({ id: to, isRead: true });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [readingId, close, neighbors]);

  if (!readingId) return null;

  function stepFont(dir: -1 | 1): void {
    const i = FS_ORDER.indexOf(fs);
    const next = FS_ORDER[Math.min(FS_ORDER.length - 1, Math.max(0, i + dir))];
    if (!next || next === fs) return;
    saveAppearance.mutate({ readerFs: next });
  }

  async function copy(text: string, okText: string): Promise<void> {
    /* clipboard 在纯 HTTP 页面（局域网调试）不可用，此时退回 execCommand —— 不退回的话
     * 用户在测试环境点「复制」只会看到一句报错，以为功能坏了。 */
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(text);
      else legacyCopy(text);
      useUi.getState().notify(okText);
    } catch {
      try {
        legacyCopy(text);
        useUi.getState().notify(okText);
      } catch {
        useUi.getState().notify('复制失败，请手动选择文本', 'error');
      }
    }
  }

  return (
    <div className="reader-backdrop" onClick={close} role="presentation">
      <article
        className="reader-sheet"
        ref={panelRef as React.RefObject<HTMLElement>}
        onClick={(e) => e.stopPropagation()}
        {...handlers}
      >
        {/* 窄屏的下拉把手：给「可以往下拖」一个可见提示，否则没人会试 */}
        <div className="reader-grip" aria-hidden />

        <div className="reader-tools">
          <span className="reader-fs" role="group" aria-label="正文字号">
            <button
              className="btn ghost icon"
              title={`正文字号：${FS_LABEL[fs]}（点击变小）`}
              aria-label="正文字号变小"
              disabled={fs === 's'}
              onClick={() => stepFont(-1)}
            >
              A-
            </button>
            <button
              className="btn ghost icon"
              title={`正文字号：${FS_LABEL[fs]}（点击变大）`}
              aria-label="正文字号变大"
              disabled={fs === 'l'}
              onClick={() => stepFont(1)}
            >
              A+
            </button>
          </span>
          <button className="reader-close btn ghost icon" onClick={close} aria-label="关闭">
            <Icon name="close" size={16} />
          </button>
        </div>

        {isPending && <p className="hint">加载正文…</p>}
        {isError && <p className="hint error-text">加载失败：{error instanceof Error ? error.message : '未知错误'}</p>}

        {data && (
          <>
            <h2 className="reader-title">{data.name}</h2>
            <p className="reader-meta">
              <span>{data.feedName}</span>
              {data.date && <span>{new Date(data.date).toLocaleString('zh-CN')}</span>}
              {data.size && <span>{data.size}</span>}
              {data.tags.map((t) => (
                <span key={t} className="tag">{t}</span>
              ))}
            </p>

            {/* 提取码单独一行并一眼可见：网盘条目的正文里它可能藏在很后面 */}
            {data.pwd && (
              <p className="reader-pwd">
                提取码 <code>{data.pwd}</code>
                <button className="btn ghost sm" onClick={() => void copy(data.pwd ?? '', '提取码已复制')}>
                  复制
                </button>
              </p>
            )}

            {/* 正文分层渲染：bodyJson 的图文块按原文顺序排开，没有块数组才回退纯文本分段 */}
            <ArticleBody bodyJson={data.bodyJson} content={data.content} desc={data.desc} title={data.name} />

            {/* 图集是「封面的放大版」：正文块里已经有图时不再重复列一遍
                （否则一篇图集文章会把同一批图渲染两次）。 */}
            {data.images.length > 0 && !hasBodyImages(data.bodyJson) && (
              <div className="reader-gallery">
                {data.images.map((u) => (
                  <Thumb key={u} src={u} className="reader-shot" decorative />
                ))}
              </div>
            )}

            <p className="reader-actions">
              {(data.sourceUrl || data.link) && (
                <a className="btn" href={data.sourceUrl ?? data.link ?? '#'} target="_blank" rel="noreferrer noopener">
                  <Icon name="external" size={14} />
                  打开原文
                </a>
              )}
              <button
                className={`btn ghost${data.isFavorite ? ' on' : ''}`}
                onClick={() => setFavorite.mutate({ id: data.id, isFavorite: !data.isFavorite })}
                disabled={setFavorite.isPending}
              >
                <Icon name={data.isFavorite ? 'star-filled' : 'star'} size={14} />
                {data.isFavorite ? '已收藏' : '收藏'}
              </button>
              <button
                className="btn ghost"
                title="复制链接与提取码"
                onClick={() => {
                  const { text, count } = buildCopyText(data);
                  // 没有提取码时别硬说「与提取码」，提示要跟实际复制到的内容一致
                  const tail = data.pwd ? '与提取码' : '';
                  void copy(text, count > 1 ? `已复制 ${count} 个链接${tail}` : `已复制链接${tail}`);
                }}
              >
                <Icon name="link" size={14} />
                复制链接
              </button>
            </p>

            {/* 翻篇放在正文末尾，而不是顶部：读完一篇才需要去下一篇。
                位置同时显示「第几条 / 共几条」，让人知道自己在列表里的哪儿。 */}
            {neighbors && (
              <nav className="reader-nav" aria-label="相邻条目">
                <button
                  className="btn ghost sm"
                  disabled={!neighbors.prev}
                  title="上一条（键盘 ←）"
                  onClick={() => step(neighbors.prev)}
                >
                  <Icon name="arrow-left" size={13} />
                  上一条
                </button>
                <span className="reader-nav-pos">
                  {neighbors.pos} / {neighbors.total}
                </span>
                <button
                  className="btn ghost sm"
                  disabled={!neighbors.next}
                  title="下一条（键盘 →）"
                  onClick={() => step(neighbors.next)}
                >
                  下一条
                  <Icon name="arrow-right" size={13} />
                </button>
              </nav>
            )}
          </>
        )}
      </article>
    </div>
  );
}

/** 图片类链接的判定：扩展名命中、data:image、以及本站图片代理 /api/img?u=…。
 *  复制链接是为了分享资源（网盘/文章），图片地址混进来只会让人觉得复制错了。 */
const IMG_EXT_RE = /\.(?:jpe?g|png|gif|webp|avif|svg|bmp|ico|tiff?|heic)(?:[?#].*)?$/i;
/** 图片站/静态资源站的域名（img. / static. / cdn. / p3. 之流）。
 *  这类主机上挂的多是配图、挂件、播放器壳子（如 img.ithome.com/app/…html 的日历卡片），
 *  虽然扩展名不是图片，复制出去同样是噪音，一并排掉。主链接有兜底，不会被误删。 */
const ASSET_HOST_RE =
  /^(?:img|image|images|pic|pics|photo|photos|static|cdn|assets?|res|thumb|thumbnails?|p\d+|s\d+)(?:[.-][\w-]+)*\./i;
function isImageUrl(u: string): boolean {
  if (/^data:image\//i.test(u)) return true;
  try {
    const url = new URL(u);
    if (/\/api\/img\b/i.test(url.pathname)) return true;
    if (IMG_EXT_RE.test(url.pathname)) return true;
    if (ASSET_HOST_RE.test(url.hostname)) return true;
  } catch {
    return IMG_EXT_RE.test(u);
  }
  return false;
}

/**
 * 复制用的文本：**只要链接 + 提取码，不带标题**。
 *
 * 网盘/资源帖常含多个链接，逐个一行展示（粘到聊天窗口就是一条条可点的地址）；
 * 图片类链接一律排除。`links` 已按「主链接优先、其余按出现顺序」排好，
 * 这里再补一次 sourceUrl/link 兜底（links 可能因上限被截断）。
 */
function buildCopyText(d: {
  name: string;
  link: string | null;
  sourceUrl: string | null;
  links: string[];
  pwd: string | null;
}): { text: string; count: number } {
  const primary = d.sourceUrl ?? d.link;
  const all = primary ? [primary, ...d.links] : [...d.links];
  const seen = new Set<string>();
  const picked: string[] = [];
  for (const raw of all) {
    const s = (raw ?? '').trim();
    if (!s || !/^https?:\/\//i.test(s)) continue;
    if (isImageUrl(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    picked.push(s);
  }
  // 全被过滤掉（极端情况：只有图片链接）时，至少把主链接带上。
  // ⚠️ 这里必须是 picked 的**副本**：若直接 push 到 picked，下面 count 会把
  // 「提取码」那一行也算成链接（曾出现 2 个链接提示「已复制 3 个链接」）。
  const lines = picked.length ? [...picked] : primary ? [primary] : [];
  const count = lines.length;
  if (d.pwd) lines.push(`提取码：${d.pwd}`);
  return { text: lines.join('\n'), count };
}

/** execCommand 兜底：只在非安全上下文（纯 HTTP）下走到这条路，不追求完美，能用就行。 */
function legacyCopy(text: string): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } finally {
    ta.remove();
  }
}
