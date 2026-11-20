/* 设置弹层「数据源」面板（v2.5.0 起按 A 方案重做：列表 + 详情两层）。
 *
 * 结构约定：
 * - 列表只留紧凑行（头像 + 标题 + 状态，整行命中 ≥64px）；点行打开 DetailSheet
 *   （桌面 = 面板内右侧抽屉，移动 = 贴底弹层），名称 / 地址 / 分组 / 频率 / 序号 /
 *   采集 / 卡片 / 全文 / 立即抓取 / 删除全部收进详情层。
 * - 桌面保留行内「采集 / 卡片」快捷开关（高频动作不必进详情）；移动端收进详情层。
 * - 命名分组默认收起，展开态按账号持久化：桥 setLayout('srcGroupsOpen', …)；
 *   搜索时强制展开命中分组；批量模式下全部展开便于勾选。
 * - 行级修改即改即生效，toast 带「撤销」（6 秒）；删除可撤销（重建订阅，
 *   条目需重抓，已读 / 收藏状态会丢失——确认框里明说）。
 * - 批量模式：多选后在页脚统一 开/关采集、开/关卡片、移组、删除，均可撤销。
 *
 * 沿用旧实现的机制：
 * - 频道数据以 core.state 为单一数据源：组件每次渲染实时读 core.state
 *   （feedList / feedMeta / groupOrder 均原地修改、实时引用），原地改动后 bump tick
 *   触发重绘；服务端往返（增 / 删 / 改）统一走桥 loadFeeds() 刷新共享 state 再 bump。
 * - 采集参数（管理员专属）：进入面板拉 /api/config 回填；cfgLoaded 复刻旧 srcFormReady
 *   语义——没加载完禁止保存，避免把兜底值当成用户设置存下去。
 * - 可折叠分组（details.sec）的开合按账号持久化：挂载后经桥 bindSections(容器)。
 * - 拖拽排序：Pointer 事件（桌面 + 触屏通用）；频道重排 / 跨组落库
 *   /api/feeds/reorder，分组重排落库 /api/prefs（groupOrder）。拖拽结束 250ms 内
 *   抑制行点击，避免松手误开详情层。
 *
 * 拆分为同目录模块：SourcePane.types.ts / constants.ts / utils.ts / parts.tsx /
 * sheet.tsx / controller.ts / sections.tsx。刷新全部与卸载收尾留在本文件，
 * 因为源码守卫钉住了进度端点与定时器清理的字面文本。
 */

import { useEffect } from 'react';
import { NO_AUTOFILL_PROPS } from '../ui/noAutofill.ts';
import { PaneFoot } from './primitives.tsx';
import { useSourceController } from './SourcePane.controller.ts';
import { FeedList, ParamsSection, SourceAdd } from './SourcePane.sections.tsx';
import { FeedSheet } from './SourcePane.sheet.tsx';
import { S } from './SourcePane.utils.ts';

/**
 * @param {*} opts
 */
export function SourcePane({
  admin,
  onDirtyChange,
}: {
  admin: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const c = useSourceController(admin, onDirtyChange);
  // 进度定时器需在本文件收尾（源码守卫钉住 clearInterval(progressTimer.current) 两处）
  const { progressTimer, moveRef, endRef, dragRef } = c;

  const onRefreshAll = async () => {
    const s = S();
    c.setBusy('all');
    // 进度条：POST 要等整轮抓完才回，期间每 1.5s 拉一次轻量 GET 显示 done/total。
    // 这是旁路只读请求；失败不影响主刷新，卸载/收尾时一律清掉定时器。
    c.setRefreshProgress(null);
    progressTimer.current = setInterval(async () => {
      try {
        const pr = await s.apiFetch('/api/feeds/refresh-progress');
        if (!pr.ok) return;
        const p = await pr.json();
        if (p && p.running) c.setRefreshProgress({ done: p.done, total: p.total });
      } catch {
        /* 进度轮询失败静默：主请求照常完成 */
      }
    }, 1500);
    try {
      const res = await s.apiFetch('/api/feeds/refresh', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const failed = (data.failed || []).length;
      c.setResult({
        ok: !failed,
        msg: failed
          ? `抓取完成，新增 ${data.added} 条，${failed} 个频道失败`
          : `抓取完成，新增 ${data.added} 条`,
      });
      await c.reloadFeeds();
      s.state.tag = null;
      if (s.loadPage) await s.loadPage(true);
    } catch (err) {
      c.setResult({ ok: false, msg: '抓取失败：' + (err.message || err) });
    } finally {
      if (progressTimer.current) {
        clearInterval(progressTimer.current);
        progressTimer.current = null;
      }
      c.setRefreshProgress(null);
      c.setBusy('');
    }
  };

  // 卸载时收尾：拖拽中的 document 监听 / body 类名 / 源元素命中恢复
  useEffect(
    () => () => {
      const mv = moveRef.current;
      if (mv) document.removeEventListener('pointermove', mv);
      const ed = endRef.current;
      if (ed) {
        document.removeEventListener('pointerup', ed);
        document.removeEventListener('pointercancel', ed);
      }
      document.body.classList.remove('is-dragging-feeds');
      if (progressTimer.current) clearInterval(progressTimer.current);
      const ctx = dragRef.current;
      if (ctx && ctx.el) ctx.el.style.pointerEvents = '';
    },
    [],
  );

  return (
    <div className="tab-pane" data-pane="source" ref={c.paneRef}>
      <div className="pane-scroll">
        {/* 添加订阅：高频动作，常显，不折进分组里 */}
        <SourceAdd c={c} />

        {/* 采集参数：设置一次就不常动，默认收起；收起时标题右侧直接显示当前值（仅管理员） */}
        {c.admin && <ParamsSection c={c} />}

        {/* 列表工具条：搜索 + 批量入口，吸顶 */}
        <div className="src-toolbar">
          <div className="feed-filter">
            <svg className="feed-filter-ico" aria-hidden="true" focusable="false">
              <use href="#i-search" />
            </svg>
            <input
              className="feed-filter-input"
              type="search"
              value={c.feedQuery}
              placeholder="搜索频道（名称 / 地址 / 分组）"
              aria-label="搜索频道"
              onChange={/** @param {*} [ev] */ (ev) => c.setFeedQuery(ev.target.value)}
              {...NO_AUTOFILL_PROPS}
            />
          </div>
          <button
            className={'btn' + (c.bulk ? ' active' : '')}
            id="bulkToggleBtn"
            type="button"
            aria-pressed={c.bulk}
            onClick={c.bulk ? c.exitBulk : c.enterBulk}
          >
            {c.bulk ? '完成' : '批量'}
          </button>
        </div>
        <div className="src-list-hint hint" id="feedToolbarHint">
          {c.total
            ? `${c.total} 个频道${c.groupNames.length ? ` · ${c.groupNames.length} 个分组` : ''}` +
              `${c.ownFreqCount ? ` · ${c.ownFreqCount} 个单独设了频率` : ''}` +
              (c.bulk ? ' · 勾选后在底部统一操作' : ' · 点行编辑')
            : ''}
        </div>

        {/* 频道列表：紧凑行，点行开详情层 */}
        <FeedList c={c} />
      </div>

      <PaneFoot
        dirty={c.sourceDirty}
        lead={
          c.bulk ? (
            <span className="hint bulk-lead">
              已选 <strong>{c.selectedFeeds.length}</strong>
              {` / ${c.total}`}
              {c.fq ? ` · 当前筛选 ${c.visibleIds.length} 个` : ''}
              {c.hiddenSelected ? ` · 其中 ${c.hiddenSelected} 个不在筛选结果内` : ''}
            </span>
          ) : (
            <span className="hint" id="settingsHint">
              {c.total ? (
                <>
                  <strong>{c.onCount}</strong>
                  {` / ${c.total} 个频道在定时采集 · `}
                  <strong>{c.cardCount}</strong>
                  {` 个在「卡片」页展示`}
                  {c.groupNames.length ? ` · ${c.groupNames.length} 个分组` : ''}
                </>
              ) : (
                '添加一个 RSS 地址即可开始'
              )}
            </span>
          )
        }
      >
        {c.bulk ? (
          <>
            <button className="btn" type="button" onClick={c.toggleSelectAll}>
              {c.allSelected ? '全不选' : '全选'}
            </button>
            <button
              className="btn"
              type="button"
              disabled={c.bulkDisabled}
              onClick={() => c.bulkPatch('enabled', true, '开启采集')}
            >
              开采集
            </button>
            <button
              className="btn"
              type="button"
              disabled={c.bulkDisabled}
              onClick={() => c.bulkPatch('enabled', false, '停止采集')}
            >
              关采集
            </button>
            <button
              className="btn"
              type="button"
              disabled={c.bulkDisabled}
              onClick={() => c.bulkPatch('cardEnabled', true, '加入卡片页')}
            >
              开卡片
            </button>
            <button
              className="btn"
              type="button"
              disabled={c.bulkDisabled}
              onClick={() => c.bulkPatch('cardEnabled', false, '移出卡片页')}
            >
              关卡片
            </button>
            <button className="btn" type="button" disabled={c.bulkDisabled} onClick={c.bulkMove}>
              移组
            </button>
            <button
              className="btn btn-danger"
              type="button"
              disabled={c.bulkDisabled}
              onClick={c.bulkDelete}
            >
              删除
            </button>
          </>
        ) : (
          <>
            <button
              className="btn btn-ghost"
              id="refreshAllFeedsBtn"
              type="button"
              disabled={c.busy === 'all'}
              onClick={onRefreshAll}
            >
              {c.busy === 'all'
                ? c.refreshProgress && c.refreshProgress.total
                  ? `抓取中 ${c.refreshProgress.done}/${c.refreshProgress.total}…`
                  : '抓取中…'
                : '刷新全部'}
            </button>
            <button
              className="btn btn-primary"
              id="saveSourceBtn"
              type="button"
              hidden={!c.admin}
              disabled={c.busy === 'save' || (c.cfgLoaded && !c.cfgDirty)}
              onClick={c.onSaveCfg}
            >
              {c.busy === 'save' ? '保存中…' : '保存设置'}
            </button>
          </>
        )}
      </PaneFoot>

      {c.sheetFeed && (
        <FeedSheet
          key={c.sheetId}
          feed={c.sheetFeed}
          order={c.sheetOrder}
          globalMins={c.globalMins}
          groupNames={c.groupNames}
          busyFeed={c.busyFeed}
          pending={c.pendingIds.has(String(c.sheetId))}
          onClose={() => c.setSheetId(null)}
          onToggle={c.onToggle}
          onFreq={c.onFreqChange}
          onOrder={c.applyNumericOrder}
          onName={c.onCommitName}
          onUrl={c.onCommitUrl}
          onGroup={c.onCommitGroup}
          onRefresh={c.onRefreshFeed}
          onDelete={c.onDelete}
        />
      )}
    </div>
  );
}
