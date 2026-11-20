/**
 * 规则面板（A 方案）：关注 / 屏蔽规则 + 入库前过滤，都是「紧凑列表 + 详情层」。
 *
 * 关注 / 屏蔽规则存 users.prefs.watchRules（整组替换），关键词一行一个、子串匹配不分大小写；
 * 保存只影响「以后新抓的文章」，点「应用到已有文章」才回溯存量条目（/api/watch/apply）。
 * 入库前过滤存 users.prefs.filters，在抓取写库前生效。
 * 两类规则都带 scope：新建时默认一个都不选 = 不生效；老数据缺 scope 视为全部频道。
 *
 * 列表行上的开关即改即存，附「撤销」toast；点行开详情层，改完关层时自动落库。
 * Webhook 与关注保留天数单独收在「通知与保留」里，失焦 / 回车即提交。
 *
 * 拆分为同目录模块：WatchPane.types.ts / WatchPane.utils.ts / WatchPane.controller.ts /
 * WatchPane.sections.tsx / WatchPane.sheets.tsx。
 */

import { Result, Section } from './primitives.tsx';
import { RulesEditor } from './RulesEditor.tsx';
import { useWatchController } from './WatchPane.controller.ts';
import { FilterRow, RuleRow } from './WatchPane.sections.tsx';
import { FilterSheet, RuleSheet } from './WatchPane.sheets.tsx';
import { blurOnEnter } from './WatchPane.utils.ts';

export function WatchPane({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const c = useWatchController(onDirtyChange);
  const {
    rules,
    filters,
    webhook,
    expireDays,
    busy,
    result,
    prefsError,
    sheet,
    setSheet,
    feedsList,
    groupOrder,
    paneRef,
    loaded,
    loadPrefs,
    openRule,
    toggleRule,
    saveRuleDraft,
    deleteRule,
    onApply,
    openFilter,
    toggleFilter,
    saveFilterDraft,
    deleteFilter,
    commitWebhook,
    commitExpire,
    setWebhook,
    setExpireDays,
  } = c;

  const notifySub = `${webhook ? 'Webhook 已配置' : '未配置 Webhook'} · 关注保留 ${Number(expireDays) === 0 ? '永久' : expireDays + ' 天'}`;
  const sheetBusy = busy === 'rules' || busy === 'filters';

  return (
    <div className="tab-pane" data-pane="watch" ref={paneRef}>
      <div className="pane-scroll">
        {prefsError ? (
          <div className="hint pane-msg lg" role="alert">
            {prefsError}，规则和过滤暂时不能编辑
            <button type="button" className="btn btn-ghost btn-sm ml-3" onClick={() => loadPrefs()}>
              重试
            </button>
          </div>
        ) : null}
        <Section
          secKey="watch-rules"
          title="关注 / 屏蔽规则"
          open
          sub={rules.length ? `${rules.length} 条` : '未配置'}
        >
          <div className="sl-toolbar">
            <button
              className="btn btn-ghost btn-sm"
              id="addWatchRuleBtn"
              type="button"
              disabled={busy === 'rules' || rules.length >= 30 || !!prefsError}
              onClick={() => openRule(null, true)}
            >
              <svg className="ico" aria-hidden="true" focusable="false">
                <use href="#i-plus" />
              </svg>
              添加规则
            </button>
            <button
              className="btn btn-ghost btn-sm"
              id="applyWatchBtn"
              type="button"
              disabled={busy === 'apply' || !rules.length || !!prefsError}
              title="按当前规则重新判定全部已有文章"
              onClick={onApply}
            >
              <svg className="ico" aria-hidden="true" focusable="false">
                <use href="#i-refresh" />
              </svg>
              {busy === 'apply' ? '回溯中…' : '应用到已有文章'}
            </button>
            <span className="sl-toolbar-note">只对之后新抓取的文章生效</span>
          </div>

          {rules.length ? (
            <div className="sl-list">
              {rules.map((r) => (
                <RuleRow
                  key={r.id}
                  r={r}
                  busy={busy}
                  onOpen={(row) => openRule(row, false)}
                  onToggle={toggleRule}
                />
              ))}
            </div>
          ) : prefsError ? (
            <div className="sl-empty">规则读取失败，点上方「重试」后再编辑</div>
          ) : (
            <div className="sl-empty">
              还没有规则。点「添加规则」新建一条，比如把标题含「OpenAI」的文章加入关注。
            </div>
          )}

          <small className="form-tip">
            每行一个关键词，标题、摘要或正文中出现即命中（不区分大小写）。同一篇文章同时命中关注和屏蔽规则时，以「屏蔽」为准。
            点行可编辑；行上的开关即改即存，误操作可在提示条里撤销。
          </small>
          <Result id="watchResult" result={result} />
        </Section>

        <Section secKey="watch-notify" advanced title="通知与保留" sub={notifySub}>
          <div className="form-row">
            <label htmlFor="watchWebhook">Webhook 通知地址（可选）</label>
            <input
              id="watchWebhook"
              type="url"
              placeholder="https://…"
              spellCheck="false"
              autoComplete="off"
              value={webhook}
              onChange={/** @param {*} [ev] */ (ev) => setWebhook(ev.target.value)}
              onBlur={commitWebhook}
              onKeyDown={blurOnEnter}
            />
            <small className="form-tip">
              新抓取的文章命中关注规则时，向该地址 POST 一条 JSON；同一轮多条合并成一条。
              <br />
              留空则不推送；改完自动保存。
            </small>
          </div>

          <div className="form-row form-row-inline">
            <label htmlFor="watchExpireDays">关注保留天数</label>
            <input
              id="watchExpireDays"
              type="number"
              inputMode="numeric"
              min="0"
              max="3650"
              step="1"
              style={{ width: '6.5em', flex: '0 0 auto' }}
              value={expireDays}
              onChange={/** @param {*} [ev] */ (ev) => setExpireDays(ev.target.value)}
              onBlur={commitExpire}
              onKeyDown={blurOnEnter}
            />
            <span className="muted">天后自动取消关注（0 表示永久保留，默认 90 天）</span>
            <small className="form-tip">
              只取消「关注」标记：文章仍留在原频道，已读 / 收藏状态不变，屏蔽不受影响。
              <br />
              改完自动保存。
            </small>
          </div>
        </Section>

        <Section
          secKey="watch-filters"
          title="入库前过滤"
          open
          sub={!loaded ? '读取中…' : filters.length ? `${filters.length} 条` : '未配置'}
        >
          <div className="sl-toolbar">
            <button
              className="btn btn-ghost btn-sm"
              id="addFilterBtn"
              type="button"
              disabled={busy === 'filters' || filters.length >= 50 || !!prefsError}
              onClick={() => openFilter(null, true)}
            >
              <svg className="ico" aria-hidden="true" focusable="false">
                <use href="#i-plus" />
              </svg>
              添加过滤规则
            </button>
            <span className="sl-toolbar-note">写入数据库之前过滤</span>
          </div>

          {!loaded ? (
            <div className="sl-empty">正在读取规则…</div>
          ) : prefsError ? (
            <div className="sl-empty">规则读取失败，点上方「重试」后再编辑</div>
          ) : !filters.length ? (
            <div className="sl-empty">
              还没有规则。点「添加过滤规则」试试，比如丢弃标题含「广告」的文章。
            </div>
          ) : (
            <div className="sl-list">
              {filters.map((f) => (
                <FilterRow
                  key={f.id}
                  f={f}
                  busy={busy}
                  onOpen={(row) => openFilter(row, false)}
                  onToggle={toggleFilter}
                />
              ))}
            </div>
          )}

          <small className="form-tip">
            只影响之后新抓的文章，已入库的历史文章不动。
            <br />
            <b>丢弃</b>：命中即不入库；<b>只收</b>
            ：只保留命中的文章（白名单）。两者同时存在时，先丢弃、再只收。
            <br />
            关键词不区分大小写；范围「全部」= 标题 + 摘要 + 正文；非法正则在保存时会被忽略。
          </small>
        </Section>

        <RulesEditor />
      </div>

      {sheet && sheet.type === 'rule' ? (
        <RuleSheet
          key={'rule-' + sheet.value.id}
          rule={sheet.value}
          isNew={sheet.isNew}
          busy={sheetBusy}
          feeds={feedsList}
          groupOrder={groupOrder}
          onClose={() => setSheet(null)}
          onSave={saveRuleDraft}
          onDelete={deleteRule}
        />
      ) : null}
      {sheet && sheet.type === 'filter' ? (
        <FilterSheet
          key={'filter-' + sheet.value.id}
          filter={sheet.value}
          isNew={sheet.isNew}
          busy={sheetBusy}
          feeds={feedsList}
          groupOrder={groupOrder}
          onClose={() => setSheet(null)}
          onSave={saveFilterDraft}
          onDelete={deleteFilter}
        />
      ) : null}
    </div>
  );
}
