import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '../lib/api';
import { qk } from '../lib/query';
import { useSetFavorite } from '../lib/mutations';
import { useUi } from '../store/ui';
import { ArticleBody } from './ArticleBody';
import { Thumb } from './Thumb';

/** 正文块里有没有图片。字符串探测就够：块 JSON 由服务端生成，形状固定且不含嵌套。 */
function hasBodyImages(json: string | null): boolean {
  return typeof json === 'string' && json.includes('"t":"img"');
}

/**
 * 阅读层（覆盖式）：只在打开某条时才请求详情。
 *
 * 列表不带正文、详情才带 —— 这是服务端定下的契约，也是流量上的必然选择
 * （30 条 × 几千字会让列表响应大一个数量级）。所以这里是一次独立请求，
 * 点开即有缓存、再点开秒开（staleTime 30s）。
 */
export function EntryReader() {
  const readingId = useUi((s) => s.readingId);
  const close = useUi((s) => s.closeEntry);
  const setFavorite = useSetFavorite();

  const { data, isPending, isError, error } = useQuery({
    queryKey: [...qk.entry, readingId],
    queryFn: () => api.entries.detail(readingId as string),
    enabled: readingId !== null,
  });

  // Esc 关闭：阅读层是模态的，键盘用户不该只能找那个小叉
  useEffect(() => {
    if (!readingId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [readingId, close]);

  if (!readingId) return null;

  return (
    <div className="reader-backdrop" onClick={close} role="presentation">
      <article className="reader-sheet" onClick={(e) => e.stopPropagation()}>
        <button className="reader-close btn ghost" onClick={close} aria-label="关闭">
          ✕
        </button>

        {isPending && <p className="hint">加载正文…</p>}
        {isError && <p className="hint error-text">加载失败：{error instanceof Error ? error.message : '未知错误'}</p>}

        {data && (
          <>
            <h2 className="reader-title">{data.name}</h2>
            <p className="reader-meta">
              <span>{data.feedName}</span>
              {data.date && <span>{new Date(data.date).toLocaleString('zh-CN')}</span>}
              {data.tags.map((t) => (
                <span key={t} className="tag">{t}</span>
              ))}
            </p>

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
                  打开原文
                </a>
              )}
              <button
                className={`btn ghost${data.isFavorite ? ' on' : ''}`}
                onClick={() => setFavorite.mutate({ id: data.id, isFavorite: !data.isFavorite })}
                disabled={setFavorite.isPending}
              >
                {data.isFavorite ? '★ 已收藏' : '☆ 收藏'}
              </button>
            </p>
          </>
        )}
      </article>
    </div>
  );
}
