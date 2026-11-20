/* 数据源面板的三大 JSX 区块（添加 / 采集参数 / 频道列表）：从 SourcePane.tsx 抽出，DOM 逐字对齐。 */

import React from 'react';
import type { Feed } from '../core/types.ts';
import { Dropdown } from '../views/Dropdown.tsx';
import { Result, Section } from './primitives.tsx';
import {
  AUTO_REFRESH_OPTIONS,
  IMG_KEEP_OPTIONS,
  IMG_TTL_OPTIONS,
  KEEP_DAYS_OPTIONS,
  REFRESH_OPTIONS,
} from './SourcePane.constants.ts';
import type { SourceController } from './SourcePane.controller.ts';
import { FeedAvatar, GRIP, Ico } from './SourcePane.parts.tsx';
import type { FeedGroup } from './SourcePane.types.ts';
import { feedStatusText, fmtBytes, S, withCurrentOption } from './SourcePane.utils.ts';

/* ==================== 添加订阅 ==================== */
export function SourceAdd({ c }: { c: SourceController }) {
  return (
    <div className="source-add">
      <div className="input-with-btn">
        <input
          id="rssUrl"
          type="url"
          placeholder="粘贴 RSS / Atom 地址"
          spellCheck={false}
          autoComplete="off"
          value={c.url}
          onChange={/** @param {*} [ev] */ (ev) => c.setUrl(ev.target.value)}
          onKeyDown={
            /** @param {*} [ev] */ (ev) => {
              if (ev.key === 'Enter') {
                ev.preventDefault();
                c.onAdd();
              }
            }
          }
          ref={c.urlRef}
        />
        <button
          className="btn btn-primary"
          id="addFeedBtn"
          type="button"
          disabled={c.busy === 'add'}
          onClick={c.onAdd}
        >
          {c.busy === 'add' ? '添加中…' : '添加'}
        </button>
      </div>
      <div className="source-add-foot">
        <small className="form-tip">
          支持 RSS 2.0 / Atom，例如 <code>https://rsshub.app/telegram/channel/example</code>
        </small>
        <button
          className="btn"
          id="importOpmlBtn"
          type="button"
          disabled={c.busy === 'import'}
          onClick={() => document.getElementById('opmlFile')?.click()}
        >
          {c.busy === 'import' ? '导入中…' : '导入 OPML'}
        </button>
        <button
          className="btn"
          id="exportOpmlBtn"
          type="button"
          onClick={() => {
            const s = S();
            if (s && s.exportOpml) s.exportOpml();
          }}
        >
          导出 OPML
        </button>
        <input
          type="file"
          id="opmlFile"
          accept=".opml,application/xml,text/xml"
          hidden
          onChange={c.onImport}
        />
      </div>
      <Result id="feedResult" result={c.result} />
    </div>
  );
}

/* ==================== 采集参数 ==================== */
export function ParamsSection({ c }: { c: SourceController }) {
  return (
    <Section secKey="src-params" advanced title="采集参数" sub={c.paramsSub} subId="srcParamsSub">
      <div className="source-opts">
        <label>
          自动抓取{' '}
          <Dropdown
            id="srcRefresh"
            wrapId="srcRefreshDD"
            title="自动抓取"
            ariaLabel="自动抓取"
            value={c.cfg.refreshMinutes}
            onChange={c.setCfgVal('refreshMinutes')}
            options={REFRESH_OPTIONS.map(
              /** @param {*} arr */ ([v, t]) => ({ value: v, label: t }),
            )}
          />
        </label>
        <label htmlFor="srcKeep">
          每频道保留{' '}
          <input
            id="srcKeep"
            type="number"
            min="0"
            max="5000"
            step="20"
            value={c.cfg.keepPerFeed}
            placeholder="0 = 不限"
            onChange={c.setCfgField('keepPerFeed')}
          />{' '}
          条
        </label>
        <label>
          最长保留{' '}
          <Dropdown
            id="srcKeepDays"
            wrapId="srcKeepDaysDD"
            title="最长保留"
            ariaLabel="最长保留"
            value={c.cfg.keepDays}
            onChange={c.setCfgVal('keepDays')}
            options={KEEP_DAYS_OPTIONS.map(
              /** @param {*} arr */ ([v, t]) => ({ value: v, label: t }),
            )}
          />
        </label>
        <label htmlFor="srcTimeout">
          抓取超时{' '}
          <input
            id="srcTimeout"
            type="number"
            min="5"
            max="120"
            step="5"
            value={c.cfg.timeoutSeconds}
            onChange={c.setCfgField('timeoutSeconds')}
          />{' '}
          秒
        </label>
        <label htmlFor="srcConcurrency">
          抓取并发{' '}
          <input
            id="srcConcurrency"
            type="number"
            min="1"
            max="10"
            step="1"
            value={c.cfg.concurrency}
            onChange={c.setCfgField('concurrency')}
          />{' '}
          个
        </label>
        <label htmlFor="srcFeedFailLimit">
          连续失败自动停用{' '}
          <input
            id="srcFeedFailLimit"
            type="number"
            min="2"
            max="20"
            step="1"
            value={c.cfg.feedFailLimit}
            placeholder="5"
            onChange={c.setCfgField('feedFailLimit')}
          />{' '}
          次
        </label>
        <label className="src-proxy-row" htmlFor="srcProxy">
          出网代理{' '}
          <input
            id="srcProxy"
            type="text"
            placeholder="留空 = 直连"
            autoComplete="off"
            spellCheck={false}
            value={c.cfg.proxyUrl}
            onChange={c.setCfgField('proxyUrl')}
          />
        </label>
        <label>
          页面自动刷新{' '}
          <Dropdown
            id="srcAutoRefresh"
            wrapId="srcAutoRefreshDD"
            title="页面自动刷新"
            ariaLabel="页面自动刷新"
            value={c.cfg.autoRefreshMinutes}
            onChange={c.setCfgVal('autoRefreshMinutes')}
            options={AUTO_REFRESH_OPTIONS.map(
              /** @param {*} arr */ ([v, t]) => ({ value: v, label: t }),
            )}
          />
        </label>
        <label>
          图片回源窗口{' '}
          <Dropdown
            id="srcImgTtl"
            wrapId="srcImgTtlDD"
            title="图片回源窗口"
            ariaLabel="图片回源窗口"
            value={c.cfg.imgTtlDays}
            onChange={c.setCfgVal('imgTtlDays')}
            options={withCurrentOption(IMG_TTL_OPTIONS, c.cfg.imgTtlDays).map(
              /** @param {*} arr */ ([v, t]) => ({ value: v, label: t }),
            )}
          />
        </label>
        <label>
          图片保留{' '}
          <Dropdown
            id="srcImgKeep"
            wrapId="srcImgKeepDD"
            title="图片保留"
            ariaLabel="图片保留"
            value={c.cfg.imgKeepDays}
            onChange={c.setCfgVal('imgKeepDays')}
            options={withCurrentOption(IMG_KEEP_OPTIONS, c.cfg.imgKeepDays).map(
              /** @param {*} arr */ ([v, t]) => ({ value: v, label: t }),
            )}
          />
        </label>
        <label htmlFor="srcImgMaxDim">
          图片最长边{' '}
          <input
            id="srcImgMaxDim"
            type="number"
            min="320"
            max="4096"
            step="80"
            value={c.cfg.imgMaxDim}
            placeholder="1280"
            onChange={c.setCfgField('imgMaxDim')}
          />{' '}
          px
        </label>
        <label htmlFor="srcImgQuality">
          图片质量{' '}
          <input
            id="srcImgQuality"
            type="number"
            min="30"
            max="100"
            step="1"
            value={c.cfg.imgQuality}
            placeholder="78"
            onChange={c.setCfgField('imgQuality')}
          />{' '}
          / 100
        </label>
        <div className="src-img-cache">
          <span className="src-img-cache-stat">
            图片缓存 <strong>{c.imgStats.count}</strong> 张 · {fmtBytes(c.imgStats.bytes)}
          </span>
          <button
            className="btn btn-ghost"
            id="clearImgCacheBtn"
            type="button"
            title="删除全部已缓存图片（库 + 内存），下次访问按当前压缩参数重新缓存"
            disabled={c.busy === 'imgclear' || !c.imgStats.count}
            onClick={c.onClearImgCache}
          >
            {c.busy === 'imgclear' ? '清空中…' : '清空图片缓存'}
          </button>
        </div>
      </div>
      <small className="form-tip">
        <b>保留规则</b>
        <br />
        条目受两个上限约束：每个频道最多保留「每频道保留」条，早于「最长保留」的一律清理。
        <br />
        「每频道保留」填 0 = 不限条数，只按时长清理；「最长保留」选「不限时长」=
        只按条数清理。两项都设上限才会同时生效。
        <br />
        收藏的条目不受这两条限制，不会被清理。
        <br />
        <b>抓取与刷新</b>
        <br />
        「自动抓取」由服务端去源站取新内容；「页面自动刷新」只让打开的页面重读列表，不触发抓取。
        <br />
        每个频道可在详情层单独指定抓取频率，未设置的跟随全局。
        <br />
        「连续失败自动停用」：频道连续失败达到此次数就停止采集，不再每轮打扰源站。到「状态 →
        异常频道」重试成功会自动恢复，手动重开采集开关也会清零计数。
        <br />
        <b>出网代理</b>
        <br />抓 RSS 与代理图片都走这里，支持 <code>http://</code>、<code>https://</code>、
        <code>socks5://</code>（含账号可写 <code>http://user:pass@host:port</code>
        ）；留空走默认出网，保存后下次抓取生效。
        <br />
        <b>图片缓存</b>
        <br />
        全站图片（卡片图 / 阅读大图 / 频道头像 / 灯箱）统一代理、永久缓存在数据库。
        <br />
        「图片最长边」「图片质量」控制 WebP 压缩强度：越小越省空间，也越模糊。
        <br />
        「图片回源窗口」内的重复访问不再请求上游；超过窗口仍先返回旧图，后台静默刷新。
        <br />
        「图片保留」到期后由每日清理删除。
        <br />
        改动保存后对之后新缓存的图片生效；点「清空图片缓存」可按新参数立即重缓全部图片。
      </small>
    </Section>
  );
}

/* ==================== 频道列表 ==================== */
export function FeedList({ c }: { c: SourceController }) {
  const rowDropCls = (f: Feed) =>
    c.drop && c.drop.type === 'row' && String(c.drop.id) === String(f.id)
      ? c.drop.before
        ? ' drag-over-before'
        : ' drag-over-after'
      : '';
  const headDropCls = (g: FeedGroup) =>
    c.drop && (c.drop.type === 'head' || c.drop.type === 'group') && c.drop.group === g.name
      ? c.drop.before
        ? ' drag-over-before'
        : ' drag-over-after'
      : '';

  /* 紧凑行：整行命中开详情（批量模式下改为勾选）。
   * 桌面保留「采集 / 卡片」快捷开关；拖拽手柄 hover 显现。 */
  const renderRow = (f: Feed) => {
    const s = S();
    const pend = c.pendingIds.has(String(f.id));
    const name = s.shortFeedName(s.feedTitle(f));
    const sel = c.selected.has(String(f.id));
    const activate = () => {
      if (Date.now() - c.lastDragEnd.current < 250) return; // 拖拽松手抑制
      if (c.bulk) c.toggleSelect(f.id);
      else c.setSheetId(f.id);
    };
    return (
      <div
        key={f.id}
        className={
          'feed-row' +
          (f.enabled ? '' : ' off') +
          (f.cardEnabled ? '' : ' no-card') +
          (sel ? ' selected' : '') +
          rowDropCls(f)
        }
        data-id={f.id}
        {...(c.bulk ? {} : { role: 'button', tabIndex: 0, 'aria-label': `查看「${name}」详情` })}
        onClick={activate}
        onKeyDown={
          /** @param {*} [ev] */ (ev) => {
            if (ev.target !== ev.currentTarget) return;
            if (ev.key === 'Enter' || ev.key === ' ') {
              ev.preventDefault();
              activate();
            }
          }
        }
      >
        {c.bulk ? (
          <input
            className="feed-check"
            type="checkbox"
            checked={sel}
            aria-label={`选择「${name}」`}
            onClick={/** @param {*} [ev] */ (ev) => ev.stopPropagation()}
            onChange={() => c.toggleSelect(f.id)}
          />
        ) : (
          <span
            className="drag-handle"
            title="拖动排序：组内重排，或拖到其它分组"
            aria-label="拖动排序"
            onPointerDown={/** @param {*} [ev] */ (ev) => c.onGripDown(ev, 'feed', { id: f.id })}
            onClick={/** @param {*} [ev] */ (ev) => ev.stopPropagation()}
          >
            {GRIP}
          </span>
        )}
        <FeedAvatar icon={f.icon} name={name} />
        <div className="feed-info">
          <div className="feed-title" title={s.feedTitle(f)}>
            {name}
          </div>
          <div className="feed-stat">
            {feedStatusText(f)}{' '}
            {f.status === 'error' ? (
              <span className="err" title={s.errText(f.error)}>
                <Ico name="alert" /> 抓取失败
              </span>
            ) : null}
          </div>
        </div>
        {!c.bulk && (
          <div className="feed-quick" onClick={/** @param {*} [ev] */ (ev) => ev.stopPropagation()}>
            <label className="feed-sw" title="采集：开启后定时抓取这个频道的新条目">
              <span className="feed-sw-label">采集</span>
              <span className="switch">
                <input
                  type="checkbox"
                  data-toggle={f.id}
                  aria-label="采集"
                  checked={f.enabled}
                  disabled={pend}
                  onChange={
                    /** @param {*} [ev] */ (ev) =>
                      c.onToggle(
                        f,
                        'enabled',
                        ev.target.checked,
                        ev.target.checked ? '已开启采集' : '已停止采集',
                      )
                  }
                />
                <span className="switch-slider"></span>
              </span>
            </label>
            <label className="feed-sw" title="卡片：开启后在「卡片」页展示这个频道的条目">
              <span className="feed-sw-label">卡片</span>
              <span className="switch">
                <input
                  type="checkbox"
                  data-card-toggle={f.id}
                  aria-label="卡片"
                  checked={f.cardEnabled}
                  disabled={pend}
                  onChange={
                    /** @param {*} [ev] */ (ev) =>
                      c.onToggle(
                        f,
                        'cardEnabled',
                        ev.target.checked,
                        ev.target.checked ? '已在卡片页展示' : '已从卡片页隐藏',
                      )
                  }
                />
                <span className="switch-slider"></span>
              </span>
            </label>
          </div>
        )}
        {!c.bulk && (
          <svg className="ico feed-caret" aria-hidden="true" focusable="false">
            <use href="#i-chevron-right" />
          </svg>
        )}
      </div>
    );
  };

  return (
    <div className="feed-list" id="feedList">
      {c.fq && !c.displayGroups.length ? <div className="hint pane-msg">没有匹配的频道</div> : null}
      {c.loadError ? (
        <div className="hint pane-msg lg">{`读取失败：${c.loadError}`}</div>
      ) : c.feedsLoading && !c.feeds.length ? (
        <div className="hint pane-msg empty-tip">正在读取频道…</div>
      ) : !c.feeds.length ? (
        <div className="hint pane-msg empty-tip">还没有订阅源，在上方粘贴一个 RSS 地址试试</div>
      ) : (
        c.displayGroups.map(
          /** @param {*} [g] */ (g) => {
            // 命名分组默认收起；搜索命中 / 批量模式强制展开；未分组常开
            const isOpen = c.bulk || !g.name || c.openGroups.has(g.name) || !!c.fq;
            const isCollapsed = !isOpen;
            // 「未分组」标题只在确实存在命名分组时才渲染（否则一行标题挺突兀）
            const showHead =
              !!g.name ||
              c.feeds.some(/** @param {*} [f] */ (f) => String(f.groupName || '').trim());
            return (
              <React.Fragment key={g.name || '__ungrouped'}>
                {showHead && (
                  <div
                    className={
                      'feed-group-head' + (isCollapsed ? ' collapsed' : '') + headDropCls(g)
                    }
                    data-group={g.name}
                    /* 分组头是可点开关，得让键盘和读屏也能用：补按钮语义与展开态。
                     重命名态下有 <input>，此时不能挂 role=button（button 套 input
                     语义不合法），退化成普通容器，输入框自己处理按键。 */
                    {...(c.renamingGroup === g.name
                      ? {}
                      : {
                          role: 'button',
                          tabIndex: 0,
                          'aria-expanded': isCollapsed ? 'false' : 'true',
                          'aria-label':
                            (g.name || '未分组') +
                            '，' +
                            (g.feeds || []).length +
                            ' 个频道，' +
                            (isCollapsed ? '已收起' : '已展开'),
                        })}
                    onClick={/** @param {*} [ev] */ (ev) => c.onHeadClick(ev, g)}
                    onKeyDown={
                      /** @param {*} [ev] */ (ev) => {
                        if (ev.target !== ev.currentTarget) return; // 手柄 / 重命名按钮 / 输入框各自处理
                        if (ev.key === 'Enter' || ev.key === ' ') {
                          ev.preventDefault();
                          c.onHeadClick(ev, g);
                        }
                      }
                    }
                  >
                    {g.name && c.renamingGroup === g.name ? (
                      <input
                        ref={c.groupRenameInputRef}
                        className="feed-group-edit"
                        type="text"
                        maxLength={40}
                        value={c.renamingGroupDraft}
                        spellCheck={false}
                        autoComplete="off"
                        aria-label="重命名分组"
                        onChange={
                          /** @param {*} [ev] */ (ev) => c.setRenamingGroupDraft(ev.target.value)
                        }
                        onKeyDown={
                          /** @param {*} [ev] */ (ev) => {
                            if (ev.key === 'Enter') {
                              ev.preventDefault();
                              ev.currentTarget.blur();
                            } else if (ev.key === 'Escape') {
                              ev.preventDefault();
                              c.setRenamingGroup(null);
                            }
                          }
                        }
                        onBlur={
                          /** @param {*} [ev] */ (ev) => c.commitGroupRename(g, ev.target.value)
                        }
                        onClick={/** @param {*} [ev] */ (ev) => ev.stopPropagation()}
                      />
                    ) : (
                      <>
                        {g.name ? (
                          <span
                            className="drag-handle"
                            title="拖动排序分组"
                            aria-label="拖动排序分组"
                            onPointerDown={
                              /** @param {*} [ev] */ (ev) =>
                                c.onGripDown(ev, 'group', { group: g.name })
                            }
                          >
                            {GRIP}
                          </span>
                        ) : null}
                        <svg className="ico feed-group-caret" aria-hidden="true" focusable="false">
                          <use href="#i-chevron-down" />
                        </svg>
                        <span className={'feed-group-name' + (g.name ? '' : ' muted')}>
                          {g.name || '未分组'}
                        </span>
                        <span className="feed-group-n">{(g.feeds || []).length}</span>
                        {g.name ? (
                          <button
                            className="feed-icon-btn feed-group-rename"
                            data-group-rename={g.name}
                            title="重命名分组（组内频道一并改名）"
                            type="button"
                            onClick={
                              /** @param {*} [ev] */ (ev) => {
                                ev.stopPropagation();
                                c.startGroupRename(g);
                              }
                            }
                          >
                            <Ico name="edit" />
                          </button>
                        ) : null}
                      </>
                    )}
                  </div>
                )}
                {isOpen && (g.feeds || []).map((f) => renderRow(f))}
              </React.Fragment>
            );
          },
        )
      )}
    </div>
  );
}
