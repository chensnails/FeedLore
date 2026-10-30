import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { bodyParagraphs, dropTitleEcho, fallbackText, parseBlocks, type BodyBlock } from '../lib/article';
import { Icon } from './Icon';

/**
 * 正文渲染：块数组 → 段落 + 内联图片；没有块数组时退回纯文本分段。
 *
 * **这是「v2 能不能当阅读器用」的那一块。** P8 之前正文是 `{data.content}` 直出，
 * 一个几百字的 HTML 字符串被当成纯文本塞进一个 div：段落挤成一整块、
 * 正文里的图全丢（因为 `data.images` 只是封面组）、首行与标题重复。
 *
 * 为什么不 sanitize + innerHTML：服务端 `buildBlocks` 在抓取时就把 HTML 拆成了
 * 图文块，**内联标签（a/b/i/span）只保留文字、块级标签只保留边界**。
 * 也就是说进入本组件的数据里根本没有标签 —— 是「结构化数据」，不是「待净化的 HTML」。
 * 所以不需要 dompurify 这类新依赖，React 的默认转义就是完整的 XSS 防线。
 * 反过来说：如果有人想绕过 buildBlocks 把原始 HTML 塞进 bodyJson，本组件也不会执行它。
 */
export function ArticleBody({
  bodyJson,
  content,
  desc,
  title,
}: {
  bodyJson: string | null | undefined;
  content?: string | undefined;
  desc?: string | undefined;
  title?: string | undefined;
}) {
  /** 灯箱：srcs 是同一组的全部图片，idx 是当前这张（多图可左右翻） */
  const [box, setBox] = useState<{ srcs: string[]; idx: number } | null>(null);

  useEffect(() => {
    if (!box) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setBox(null);
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        setBox((b) => {
          if (!b || b.srcs.length < 2) return b;
          const step = e.key === 'ArrowRight' ? 1 : -1;
          return { ...b, idx: (b.idx + step + b.srcs.length) % b.srcs.length };
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [box]);

  const blocks = dropTitleEcho(parseBlocks(bodyJson) ?? [], title);
  const hasBlocks = blocks.length > 0;
  const text = fallbackText(content, desc);

  /* ---------------- 有块数组：按原文顺序渲染 ---------------- */
  if (hasBlocks) {
    const nodes: ReactNode[] = [];
    let buf: string[] = [];
    let key = 0;

    /* 连续的图片块合并成一组网格。为什么要合并：源站图集常连排 3~9 张，
     * 逐张按「单图」渲染会让每张都占满整栏，一篇图集要滚好几屏。 */
    const flush = (): void => {
      if (!buf.length) return;
      const srcs = buf;
      buf = [];
      if (srcs.length === 1) {
        nodes.push(
          <LightImg
            key={`i${key++}`}
            src={srcs[0] as string}
            onZoom={() => setBox({ srcs, idx: 0 })}
          />,
        );
      } else {
        nodes.push(
          <div className="art-imgs" key={`g${key++}`}>
            {srcs.map((s, k) => (
              <LightImg key={s} src={s} tile onZoom={() => setBox({ srcs, idx: k })} />
            ))}
          </div>,
        );
      }
    };

    for (const b of blocks) {
      if (b.t === 'img') {
        buf.push(b.src);
        continue;
      }
      flush();
      for (const p of bodyParagraphs(b.text)) {
        nodes.push(
          <p className={p.cls || undefined} key={`p${key++}`}>
            {p.text}
          </p>,
        );
      }
    }
    flush();

    return (
      <div className="reader-body">
        {nodes}
        {/*
         * 灯箱必须 portal 到 body：`.reader-sheet` 上有 backdrop-filter，按规范它会给
         * `position: fixed` 的后代新建包含块——灯箱留在树里就只会铺满阅读层那一列，
         * 且 50% 按整张长 sheet 算，左右翻页箭头会被推到视口下方看不见。
         */}
        {box &&
          createPortal(
            <Lightbox box={box} onClose={() => setBox(null)} onIdx={(idx) => setBox({ ...box, idx })} />,
            document.body,
          )}
      </div>
    );
  }

  /* ---------------- 没有块数组：纯文本分层兜底 ---------------- */
  const paras = bodyParagraphs(text);
  return (
    <div className="reader-body">
      {paras.length ? (
        paras.map((p, i) => (
          <p className={p.cls || undefined} key={i}>
            {p.text}
          </p>
        ))
      ) : (
        <p className="reader-empty">（这条没有正文，可以点下面的「打开原文」）</p>
      )}
    </div>
  );
}

/** 正文图片：加载失败即消失（代理 403 / 源站删图都很常见，裂图比不显示更难看） */
function LightImg({ src, tile = false, onZoom }: { src: string; tile?: boolean; onZoom: () => void }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      className={`art-img${tile ? ' tile' : ''}`}
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      title="点击查看大图"
      onClick={onZoom}
      onError={() => setFailed(true)}
    />
  );
}

function Lightbox({
  box,
  onClose,
  onIdx,
}: {
  box: { srcs: string[]; idx: number };
  onClose: () => void;
  onIdx: (i: number) => void;
}) {
  const cur = box.srcs[box.idx];
  const many = box.srcs.length > 1;
  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-modal="true" aria-label="查看大图">
      {many && (
        <button
          className="lightbox-nav prev"
          aria-label="上一张"
          onClick={(e) => {
            e.stopPropagation();
            onIdx((box.idx - 1 + box.srcs.length) % box.srcs.length);
          }}
        >
          <Icon name="chevron-left" size={24} />
        </button>
      )}
      {cur && (
        <img
          className="lightbox-img"
          src={cur}
          alt=""
          referrerPolicy="no-referrer"
          onClick={(e) => e.stopPropagation()}
        />
      )}
      {many && (
        <button
          className="lightbox-nav next"
          aria-label="下一张"
          onClick={(e) => {
            e.stopPropagation();
            onIdx((box.idx + 1) % box.srcs.length);
          }}
        >
          <Icon name="chevron-right" size={24} />
        </button>
      )}
      <p className="lightbox-hint">
        {many ? `${box.idx + 1} / ${box.srcs.length} · ← → 切换 · ` : ''}点击空白处或 Esc 关闭
      </p>
    </div>
  );
}

export type { BodyBlock };
