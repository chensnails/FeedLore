import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { qk } from '../lib/query';
import { useSaveAppearance, useSetFavorite } from '../lib/mutations';
import { useSwipeDismiss } from '../lib/useSwipeDismiss';
import { useOverlayFocus } from '../lib/useOverlayFocus';
import { useUi } from '../store/ui';
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
  const tag = useUi((s) => s.tag);
  const setTag = useUi((s) => s.setTag);
  const setFavorite = useSetFavorite();
  const saveAppearance = useSaveAppearance();

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

  /* 可复制的链接清单（主链接 + 正文链接，去重去图片）。
   * 只有 1 条时「复制链接」直接复制；多条时先弹选择菜单。 */
  const copyLinks = useMemo(() => (data ? pickLinks(data) : []), [data]);

  const { panelRef, handlers } = useSwipeDismiss(close);
  useOverlayFocus(!!readingId, panelRef);

  /* 复制链接的选择菜单：多链接时展开，点谁复制谁。
   * 切换条目必须重置 —— 上一篇展开的菜单不能「跟」到下一篇。 */
  const [copyMenuOpen, setCopyMenuOpen] = useState(false);
  useEffect(() => setCopyMenuOpen(false), [readingId]);

  /* 菜单开着时点外面收起（与溢出菜单同一套 contains 判定）。 */
  useEffect(() => {
    if (!copyMenuOpen) return;
    const onDown = (e: MouseEvent): void => {
      const t = e.target as HTMLElement | null;
      if (!t?.closest('.copy-wrap')) setCopyMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [copyMenuOpen]);

  /* 键盘：只负责 Esc 关闭。
   *
   * v1 在 1.7.1 按产品决策移除了全部阅读器式快捷键（j/k/o/s/u/?、`/` 聚焦搜索、
   * 以及上下篇），v2 照同一口径不做翻篇快捷键与相邻条目导航；这里保留的三件事是
   * v1 也没删的：⌘K 命令面板（另在 Shell 里）、Esc 关浮层、灯箱的 ←/→ 翻图。
   *
   * 两条必须处理的让路：
   * 1. **灯箱开着时不抢 Esc**：灯箱在 ArticleBody 内部自管开关，这里用 DOM 存在性
   *    判断，而不是为了一个按键把它的状态提到阅读层（那只会多一条状态链）。
   * 2. 确认框 / 复制菜单在最上层，Esc 只该关它们自己。
   * 3. 焦点在输入框里时不劫持 Esc（正在打字）。 */
  useEffect(() => {
    if (!readingId) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('.lightbox')) return;
      // 确认框在最上层：它的 Esc 只该关它自己
      if (useUi.getState().confirmState) return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      /* 复制菜单开着时 Esc 只关菜单 —— 不让路就会「关个菜单把整篇文章也关了」。 */
      if (document.querySelector('.copy-menu')) {
        setCopyMenuOpen(false);
        return;
      }
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [readingId, close]);

  if (!readingId) return null;

  /** 点正文标签 = 用这个标签去筛列表，所以顺带关掉阅读层（留着就挡住了刚筛出来的结果）。 */
  function gotoTag(t: string): void {
    setTag(tag === t ? null : t);
    close();
  }

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
              {/* 标签是阅读层里唯一的「按分类再看一批」入口（v1 在 1.6.0 撤掉顶部标签云后，
                  列表上的标签筛选全靠这里点进来）。点一下关掉阅读层、列表换成该标签的范围。 */}
              {data.tags.map((t) => (
                <button
                  key={t}
                  type="button"
                  className="mini-tag"
                  title={tag === t ? `取消 #${t} 筛选` : `只看 #${t}`}
                  onClick={() => gotoTag(t)}
                >
                  #{t}
                </button>
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
              {/* 多链接不一次性全拷：展开清单点谁复制谁；单链接保持一步到位 */}
              <span className="copy-wrap">
                <button
                  className="btn ghost"
                  title={copyLinks.length > 1 ? '选择要复制的链接' : '复制链接与提取码'}
                  onClick={() => {
                    if (copyLinks.length > 1) {
                      setCopyMenuOpen((v) => !v);
                      return;
                    }
                    const { text } = buildCopyText(data);
                    void copy(text, data.pwd ? '已复制链接与提取码' : '已复制链接');
                  }}
                >
                  <Icon name="link" size={14} />
                  复制链接{copyLinks.length > 1 ? `（${copyLinks.length}）` : ''}
                </button>
                {copyMenuOpen && (
                  <div className="copy-menu" role="menu" aria-label="选择要复制的链接">
                    <button
                      className="copy-all"
                      role="menuitem"
                      onClick={() => {
                        setCopyMenuOpen(false);
                        const { text, count } = buildCopyText(data);
                        void copy(text, `已复制 ${count} 个链接${data.pwd ? '与提取码' : ''}`);
                      }}
                    >
                      <Icon name="copy" size={14} />
                      全部复制（{copyLinks.length} 个链接）
                    </button>
                    {copyLinks.map((u) => (
                      <button
                        key={u}
                        className="copy-url"
                        role="menuitem"
                        title={u}
                        onClick={() => {
                          setCopyMenuOpen(false);
                          void copy(u, '已复制链接');
                        }}
                      >
                        <Icon name="link" size={13} />
                        {urlLabel(u)}
                      </button>
                    ))}
                  </div>
                )}
              </span>
            </p>
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
 * 复制链接的可选清单：主链接 + 正文里的其它链接，去重、去图片。
 * 「复制链接」按钮在多个链接时先弹选择菜单（点谁复制谁），单个时直接复制。
 */
function pickLinks(d: {
  link: string | null;
  sourceUrl: string | null;
  links: string[];
}): string[] {
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
  return picked.length ? picked : primary ? [primary] : [];
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
  // ⚠️ lines 必须是 picked 的**副本**：若直接 push 到 picked，下面 count 会把
  // 「提取码」那一行也算成链接（曾出现 2 个链接提示「已复制 3 个链接」）。
  const lines = [...pickLinks(d)];
  const count = lines.length;
  if (d.pwd) lines.push(`提取码：${d.pwd}`);
  return { text: lines.join('\n'), count };
}

/** 菜单里每条链接的展示文案：host + 路径，截短；完整地址挂在 title 上。 */
function urlLabel(u: string): string {
  let s: string;
  try {
    const url = new URL(u);
    s = url.host + url.pathname;
  } catch {
    s = u;
  }
  return s.length > 46 ? `${s.slice(0, 45)}…` : s;
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
