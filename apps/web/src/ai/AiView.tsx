/* AI 视图（已 React 化）：探索页骨架与生成动作留在本组件；
 * 日报条目 / 正文 / 状态块在 AiView.parts.tsx，状态与读取逻辑在 AiView.hooks.ts。
 * 类名 / ID / data 属性与旧 DOM 一致，样式零改动。 */

import type { Digest } from '@feedlore/contract';
import { useRef } from 'react';
import { useTopbarHeight } from '../shell/useTopbarHeight.ts';
import { OverflowMenu } from '../ui/OverflowMenu.tsx';
import { ViewNav } from '../ui/ViewNav.tsx';
import { Dropdown } from '../views/Dropdown.tsx';
import { useAiVm } from './AiView.hooks.ts';
import { DigestStateBody } from './AiView.parts.tsx';
import { ExplorePane } from './ExplorePane.tsx';

/** 日报任务 result 的形状（entry_ai job 的 result 是 dynamic，这里按已知字段收窄）。 */
interface DigestJobResult {
  digest?: Digest;
  cached?: boolean;
}

export function AiView() {
  const vm = useAiVm();
  const {
    s,
    writable,
    pane,
    setPane,
    sessionKey,
    newSession,
    onTabKey,
    selected,
    view,
    setView,
    genKey,
    setGenKey,
    genElapsed,
    genBusy,
    reqGen,
    dateOptions,
    today,
    subtitle,
    showDigest,
    setDates,
    setSelected,
  } = vm;

  // 合并后第一行（标题 + ⋮）即吸顶条，由其写入 --topbar-h
  const headRef = useRef<HTMLDivElement | null>(null);
  useTopbarHeight(headRef);

  /* 日报生成已改异步：提交任务 → 轮询。请求从「挂 3 分钟」变成毫秒级。 */
  async function generate(force?: boolean, key?: string) {
    if (genBusy.current) return;
    if (!s || typeof s.submitAiJob !== 'function') {
      setView({ kind: 'genError', msg: 'AI 功能当前不可用' });
      return;
    }
    genBusy.current = true;
    const gen = ++reqGen.current; // 生成期间切日期：以最后一次操作为准
    setGenKey(key || (force ? 'regen' : 'gen'));
    setView({ kind: 'genLoading', phase: 'queued' });
    try {
      const job = await s.submitAiJob({ kind: 'digest', force: !!force });
      if (gen !== reqGen.current) return;
      setView({ kind: 'genLoading', phase: job.status || 'queued' });
      const done = await s.pollAiJob(job.id, {
        onStatus: /** @param {*} [j] */ (j) => {
          if (gen === reqGen.current)
            setView({ kind: 'genLoading', phase: j.status, at: j.createdAt });
        },
        isCancelled: () => gen !== reqGen.current,
      });
      if (gen !== reqGen.current) return;
      const raw = done && done.result;
      const r: DigestJobResult =
        typeof raw === 'object' && raw !== null ? (raw as DigestJobResult) : {};
      const d = r.digest;
      if (!d) throw new Error('生成失败：任务完成但没有返回日报');
      setDates((prev: string[]) => (prev.includes(d.date) ? prev : [d.date, ...prev]));
      setSelected(d.date);
      setView({ kind: 'ready', digest: d });
      const kept = (d.stats && d.stats.kept) || 0;
      const feeds = (d.stats && d.stats.feeds) || 0;
      s.toast(r.cached ? '已读取当日缓存摘要' : `摘要生成完成（${kept} 条 / ${feeds} 频道）`);
    } catch (err) {
      if (gen === reqGen.current) {
        setView({
          kind: 'genError',
          msg: s.errText ? s.errText(err, '生成失败') : String((err && err.message) || err),
        });
      }
    } finally {
      genBusy.current = false;
      setGenKey(null);
    }
  }

  return (
    <>
      {/* 顶栏与文章/卡片页同构：左端新对话，中间标题，右侧簇（视图导航 + ⋮）。 */}
      <div className="ai-head page-head view-toolbar" ref={headRef}>
        {pane === 'ask' ? (
          <button
            className="btn btn-ghost btn-sm ai-new-btn vt-channel"
            id="exploreNewBtn"
            type="button"
            aria-label="开始新一轮对话"
            title="开始新一轮对话（清空当前会话）"
            onClick={newSession}
          >
            <svg className="ico" aria-hidden="true" focusable="false">
              <use href="#i-plus" />
            </svg>
          </button>
        ) : null}
        <div className="ai-head-text">
          <h2 className="page-title vt-title">探索</h2>
        </div>
        <div className="head-right vt-tools">
          <ViewNav />
          <OverflowMenu
            view="ai"
            refreshLabel="刷新订阅"
            refreshHint="只更新订阅内容；重算日报请用「重新生成」"
          />
        </div>
      </div>
      <div className="ex-wrap">
        <div className="ai-tabs" role="tablist" aria-label="探索页模式">
          <button
            type="button"
            role="tab"
            id="exploreTabAsk"
            aria-selected={pane === 'ask' ? 'true' : 'false'}
            aria-controls="exploreAskPanel"
            tabIndex={pane === 'ask' ? 0 : -1}
            onKeyDown={onTabKey}
            className={'ai-tab' + (pane === 'ask' ? ' is-active' : '')}
            onClick={() => setPane('ask')}
          >
            问答
          </button>
          <button
            type="button"
            role="tab"
            id="exploreTabDigest"
            aria-selected={pane === 'digest' ? 'true' : 'false'}
            aria-controls="exploreDigestPanel"
            tabIndex={pane === 'digest' ? 0 : -1}
            onKeyDown={onTabKey}
            className={'ai-tab' + (pane === 'digest' ? ' is-active' : '')}
            hidden={s.digestIsEnabled && !s.digestIsEnabled()}
            onClick={() => setPane('digest')}
          >
            日报
          </button>
        </div>
        <ExplorePane
          key={sessionKey}
          hidden={pane !== 'ask'}
          onNewSession={newSession}
          panelProps={{
            id: 'exploreAskPanel',
            role: 'tabpanel',
            'aria-labelledby': 'exploreTabAsk',
          }}
        />
        <section
          className="ai-pane"
          data-ai-pane="digest"
          id="exploreDigestPanel"
          role="tabpanel"
          aria-labelledby="exploreTabDigest"
          hidden={pane !== 'digest'}
        >
          {/* 说明行与操作行分层：标题 → 说明 → 日期/动作，窄屏操作行自己换行 */}
          <div className="digest-head">
            <p className="ai-sub" id="digestSub">
              {subtitle}
            </p>
          </div>
          <div className="digest-actions">
            <Dropdown
              id="digestDate"
              wrapId="digestDateDD"
              title="选择日期"
              ariaLabel="选择日期"
              value={selected}
              onChange={/** @param {*} [v] */ (v) => showDigest(v)}
              options={dateOptions.map(
                /** @param {*} [d] */ (d) => ({
                  value: d,
                  label: (d === today ? '今天 · ' : '') + d,
                }),
              )}
            />
            {writable ? (
              <>
                <button
                  className="btn btn-ghost"
                  id="regenDigestBtn"
                  type="button"
                  title="忽略缓存，重新生成"
                  disabled={genKey !== null}
                  aria-busy={genKey === 'regen' ? 'true' : undefined}
                  onClick={() => generate(true, 'regen')}
                >
                  {genKey === 'regen' ? '生成中…' : '重新生成'}
                </button>
                <button
                  className="btn btn-primary"
                  id="genDigestBtn"
                  type="button"
                  disabled={genKey !== null}
                  aria-busy={genKey === 'gen' ? 'true' : undefined}
                  onClick={() => generate(false, 'gen')}
                >
                  {genKey === 'gen' ? '生成中…' : '生成摘要'}
                </button>
              </>
            ) : null}
          </div>
          <div id="digestBody">
            <DigestStateBody
              view={view}
              writable={writable}
              genElapsed={genElapsed}
              selected={selected}
              showDigest={showDigest}
              generate={generate}
            />
          </div>
          <footer className="foot">摘要由大模型生成，可能存在偏差，请以原始条目为准</footer>
        </section>
      </div>
    </>
  );
}
