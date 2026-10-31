import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { Appearance, FilterRule, WatchRule } from '@feedlore/contract';
import { api } from '../lib/api';
import { qk } from '../lib/query';
import { useApplyWatch, useSaveAppearance, useSavePrefs } from '../lib/mutations';
import { useOverlayFocus } from '../lib/useOverlayFocus';
import { useUi, type PrefsTab } from '../store/ui';
import { AccountForm } from './AccountForm';
import { ChannelsTab } from './ChannelsTab';
import { Icon } from './Icon';

/**
 * 设置面板（每个账号自己的）。
 *
 * 为什么单独开一个面板而不是塞进管理面板：管理面板 `role === 'admin'` 才可见，
 * 而「改主色 / 调正文字号 / 配关注规则」是**每个用户**都该有的。P8 之前这些能力
 * 全都写在 CSS 变量与后端接口里，却没有任何入口 —— 能力在、用户摸不到，等于没有。
 *
 * 四个页签按「改完之后影响什么」分：
 * - 外观：整站观感（主题 / 主色 / 界面字号 / 密度）
 * - 阅读：只管文章正文（字体 / 行高 / 字号 / 宽度）—— 与外观分开是因为它俩
 *   调的是完全不同的东西，混在一页会让人以为「正文字号」会把按钮也变大
 * - 关注规则：改完要**手动重算**历史条目才能看到效果，所以按钮就在旁边
 * - 账号：改密码（普通用户唯一的路径）
 */

type Tab = PrefsTab;

export function PrefsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('appearance');
  const prefsTab = useUi((s) => s.prefsTab);
  const sheetRef = useRef<HTMLElement>(null);
  useOverlayFocus(open, sheetRef);

  // 从频道栏「频道管理」入口打开时，直接落到「频道」页签
  useEffect(() => {
    if (open && prefsTab) setTab(prefsTab);
  }, [open, prefsTab]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="reader-backdrop" onClick={onClose} role="presentation">
      <section className="admin-sheet prefs-sheet" ref={sheetRef} onClick={(e) => e.stopPropagation()}>
        <button className="reader-close btn ghost icon" onClick={onClose} aria-label="关闭">
          <Icon name="close" size={16} />
        </button>

        <h2 className="admin-title">设置</h2>
        <div className="admin-tabs" role="tablist">
          {([
            { id: 'appearance' as const, label: '外观' },
            { id: 'reading' as const, label: '阅读' },
            { id: 'channels' as const, label: '频道' },
            { id: 'watch' as const, label: '关注' },
            { id: 'filter' as const, label: '过滤' },
            { id: 'account' as const, label: '账号' },
          ]).map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`chip${tab === t.id ? ' on' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="admin-body">
          {tab === 'appearance' && <AppearanceTab />}
          {tab === 'reading' && <ReadingTab />}
          {tab === 'channels' && <ChannelsTab />}
          {tab === 'watch' && <WatchTab />}
          {tab === 'filter' && <FilterTab />}
          {tab === 'account' && <AccountTab />}
        </div>
      </section>
    </div>
  );
}

/* ============================ 外观 / 阅读 ============================ */

/** 分段控件：一行 label + 一行互斥按钮（比 select 少一次点击，也能直接看出有多少档） */
function Seg<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  hint?: string;
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="seg-row">
      <div className="seg-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="seg" role="group" aria-label={label}>
        {options.map(([v, text]) => (
          <button
            key={v}
            className={`seg-btn${value === v ? ' on' : ''}`}
            aria-pressed={value === v}
            disabled={disabled}
            onClick={() => onChange(v)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

const THEMES = [
  ['auto', '跟随系统'],
  ['light', '浅色'],
  ['dark', '深色'],
  ['github', 'GitHub 暗黑'],
] as const;

const ACCENTS = [
  ['blue', '蓝', '#5b8def'],
  ['violet', '靛紫', '#9a7bf0'],
  ['teal', '青', '#43b3a3'],
  ['green', '翠绿', '#5cba6a'],
  ['amber', '琥珀', '#d8a86e'],
  ['rose', '玫红', '#e0708f'],
] as const;

function useAppearance(): { a: Appearance | null; save: ReturnType<typeof useSaveAppearance> } {
  const q = useQuery({ queryKey: qk.prefs, queryFn: () => api.prefs.get(), staleTime: 5 * 60_000 });
  const save = useSaveAppearance();
  return { a: q.data?.appearance ?? null, save };
}

function AppearanceTab() {
  const { a, save } = useAppearance();
  if (!a) return <p className="hint">加载偏好…</p>;

  /* github 主题自带整套配色，这里把主色调板禁用（legacy 同规则）：
   * 让它可选但点了没反应，比直接禁用更让人困惑。 */
  const fixedAccent = a.theme === 'github';

  return (
    <>
      <Seg label="主题" value={a.theme} options={THEMES} onChange={(v) => save.mutate({ theme: v })} />
      <Seg label="界面字号" hint="整站等比缩放，按钮和列表一起变" value={a.fontSize}
        options={[['s', '小'], ['m', '中'], ['l', '大']] as const}
        onChange={(v) => save.mutate({ fontSize: v })} />
      <Seg label="卡片密度" hint="紧凑 = 同屏更多卡片" value={a.density}
        options={[['cozy', '舒适'], ['compact', '紧凑']] as const}
        onChange={(v) => save.mutate({ density: v })} />

      <div className="seg-row">
        <div className="seg-label">
          <span>主色</span>
          <small>{fixedAccent ? 'GitHub 暗黑是整套配色，主色固定为 GitHub 蓝' : '只换强调色，底色不变'}</small>
        </div>
        <div className="accent-row" role="group" aria-label="主色">
          {ACCENTS.map(([v, name, hex]) => (
            <button
              key={v}
              className={`accent-dot${a.accent === v && !fixedAccent ? ' on' : ''}`}
              style={{ background: hex }}
              aria-label={name}
              aria-pressed={a.accent === v}
              title={name}
              disabled={fixedAccent}
              onClick={() => save.mutate({ accent: v })}
            />
          ))}
        </div>
      </div>

      <p className="hint tiny">
        主题、主色与界面字号都在这页改；顶栏不再放单独的快捷开关，所有外观设置统一从这里进入。
      </p>
    </>
  );
}

function ReadingTab() {
  const { a, save } = useAppearance();
  if (!a) return <p className="hint">加载偏好…</p>;

  return (
    <>
      <Seg label="正文字体" hint="只作用于文章正文，界面字体不变" value={a.readerFont}
        options={[['sans', '无衬线'], ['serif', '衬线']] as const}
        onChange={(v) => save.mutate({ readerFont: v })} />
      <Seg label="正文字号" value={a.readerFs}
        options={[['s', '小'], ['m', '中'], ['l', '大']] as const}
        onChange={(v) => save.mutate({ readerFs: v })} />
      <Seg label="正文行高" value={a.readerLh}
        options={[['s', '紧凑'], ['m', '标准'], ['l', '宽松']] as const}
        onChange={(v) => save.mutate({ readerLh: v })} />
      <Seg label="阅读宽度" hint="越窄每行字数越少，读起来越省力" value={a.readerWidth}
        options={[['s', '窄'], ['m', '标准'], ['l', '宽'], ['full', '全宽']] as const}
        onChange={(v) => save.mutate({ readerWidth: v })} />

      <p className="hint tiny">打开任一篇文章即可看到效果，改动会立即保存并在所有设备生效。</p>
    </>
  );
}

/* ============================ 关注规则 ============================ */

const emptyRule = (): WatchRule => ({
  id: `r_${Date.now().toString(36)}`,
  name: '',
  keywords: [],
  act: 'watch',
  notify: false,
  on: true,
});

function WatchTab() {
  const q = useQuery({ queryKey: qk.prefs, queryFn: () => api.prefs.get(), staleTime: 5 * 60_000 });
  const save = useSavePrefs();
  const apply = useApplyWatch();
  const [rules, setRules] = useState<WatchRule[] | null>(null);
  const [hook, setHook] = useState<string | null>(null);

  // 首次拿到服务端规则时灌进本地（之后以本地为准，避免每次 invalidate 冲掉正在编辑的内容）
  useEffect(() => {
    if (rules === null && q.data) setRules(q.data.watchRules);
  }, [q.data, rules]);

  if (rules === null) return <p className="hint">加载规则…</p>;

  const patch = (id: string, p: Partial<WatchRule>): void =>
    setRules((rs) => (rs ?? []).map((r) => (r.id === id ? { ...r, ...p } : r)));

  const dirty = JSON.stringify(rules) !== JSON.stringify(q.data?.watchRules ?? []);

  /* webhook 与规则**分开保存**（legacy 同口径）：规则是一张列表，改一半就提交会把
   * 正在编辑的其它行一起发出去；地址是一条字符串，改完立刻能存，不该被规则的 dirty 拦住。 */
  const savedHook = q.data?.webhookUrl ?? '';
  const hookValue = hook ?? savedHook;
  const hookDirty = hookValue.trim() !== savedHook;

  const notifyCount = rules.filter((r) => r.act === 'watch' && r.notify && r.on !== false).length;

  return (
    <>
      <p className="hint tiny">
        规则决定条目被打上「关注」还是「屏蔽」标记。<strong>只对新抓到的条目生效</strong>；
        改完历史条目要按下面的「重算」。
      </p>

      <ul className="rule-list">
        {rules.map((r) => (
          <li className="rule-row" key={r.id}>
            <input
              className="input sm rule-name"
              placeholder="规则名（随便起，只给自己看）"
              value={r.name}
              onChange={(e) => patch(r.id, { name: e.target.value })}
            />
            <input
              className="input sm rule-kw"
              placeholder="关键词，用逗号分隔"
              value={r.keywords.join(',')}
              onChange={(e) =>
                patch(r.id, {
                  keywords: e.target.value
                    .split(/[,，]/)
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
            <select
              className="input sm"
              aria-label="动作"
              value={r.act}
              onChange={(e) => patch(r.id, { act: e.target.value as WatchRule['act'] })}
            >
              <option value="watch">关注</option>
              <option value="block">屏蔽</option>
            </select>
            {/* 推送勾选只在「关注」下有意义：屏蔽的条目不推（推了等于把噪音发到手机上）。
                这个字段一直在契约里、服务端也认，但一直没有入口 —— 默认 false，
                于是「配了 webhook 却从没收到推送」是必然结果。 */}
            <label className={`rule-on${r.act === 'watch' ? '' : ' off'}`} title={r.act === 'watch' ? '命中时推送 webhook' : '屏蔽规则不推送'}>
              <input
                type="checkbox"
                checked={r.notify && r.act === 'watch'}
                disabled={r.act !== 'watch'}
                onChange={(e) => patch(r.id, { notify: e.target.checked })}
              />
              推送
            </label>
            <label className="rule-on" title="关掉只是停用，不删除">
              <input type="checkbox" checked={r.on} onChange={(e) => patch(r.id, { on: e.target.checked })} />
              启用
            </label>
            <button
              className="btn ghost sm icon"
              aria-label="删除规则"
              title="删除这条规则"
              onClick={() => setRules((rs) => (rs ?? []).filter((x) => x.id !== r.id))}
            >
              <Icon name="trash" size={14} />
            </button>
          </li>
        ))}
      </ul>

      {rules.length === 0 && <p className="hint">还没有规则。加一条就能把关键词相关的条目单独标出来。</p>}

      <p className="admin-actions">
        <button className="btn ghost sm" onClick={() => setRules((rs) => [...(rs ?? []), emptyRule()])}>
          <Icon name="plus" size={14} />
          添加规则
        </button>
        <button
          className="btn sm"
          disabled={save.isPending || !dirty}
          onClick={() => save.mutate({ watchRules: rules })}
        >
          {save.isPending ? '保存中…' : dirty ? '保存规则' : '已保存'}
        </button>
        {/* 重算读的是**服务端**已保存的规则，所以未保存时禁用并说明原因，
            否则用户会得到「重算完了但没变化」这种最难排查的结果。 */}
        <button
          className="btn ghost sm"
          disabled={apply.isPending || dirty}
          title={dirty ? '先保存规则再重算' : '按当前规则重新标记历史条目'}
          onClick={() => apply.mutate()}
        >
          {apply.isPending ? '重算中…' : '重算历史条目'}
        </button>
      </p>
      {dirty && <p className="hint tiny">规则有改动，先保存再重算。</p>}

      <h3 className="admin-h3">推送通知（webhook）</h3>
      <div className="hook-row">
        <input
          className="input sm"
          type="url"
          spellCheck={false}
          autoComplete="off"
          placeholder="https://example.com/hook（留空则不推送）"
          value={hookValue}
          onChange={(e) => setHook(e.target.value)}
        />
        <button
          className="btn sm"
          disabled={save.isPending || !hookDirty}
          onClick={() => save.mutate({ webhookUrl: hookValue.trim() })}
        >
          {hookDirty ? '保存地址' : '已保存'}
        </button>
      </div>
      <p className="hint tiny">
        命中<strong>勾了「推送」的关注规则</strong>时，服务端把新条目 POST 成一条 JSON（含标题 / 链接 / 频道）。
        屏蔽规则不推送，未勾「推送」的规则也不推送 —— 当前会推送的规则：{notifyCount} 条。
        <br />
        地址必须是公网 http(s)：内网地址会被拒绝，保存后 DNS 变化也会在发送前再校验一次。
      </p>
    </>
  );
}

/* ============================ 条目过滤规则 ============================ */

const FILTER_ACTS = [
  ['block', '屏蔽'],
  ['allow', '只收'],
] as const;

const FILTER_FIELDS = [
  ['all', '全部'],
  ['title', '标题'],
  ['desc', '摘要'],
  ['content', '正文'],
] as const;

const FILTER_KINDS = [
  ['kw', '关键词'],
  ['re', '正则'],
] as const;

/** 规则 id：时间戳 + 随机后缀。只用时间戳的话，连点两次「添加」会拿到同一个 id，
 * 服务端 `sanitizeFilters` 遇到重复 id 会改名，于是本地这条的编辑对象就变了。 */
const emptyFilter = (): FilterRule => ({
  id: `f_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
  on: true,
  act: 'block',
  field: 'all',
  kind: 'kw',
  pattern: '',
});

/**
 * 非法正则的判断必须在**提交前**做。
 *
 * 服务端 `sanitizeFilters` 对编译不过的正则是 `catch { continue }` —— 静默丢弃。
 * 用户点「保存」看到「已保存」，回头发现规则少了一条，只会以为界面在骗他。
 */
function badRegex(r: FilterRule): boolean {
  if (r.kind !== 're' || !r.pattern.trim()) return false;
  try {
    new RegExp(r.pattern);
    return false;
  } catch {
    return true;
  }
}

function FilterTab() {
  const q = useQuery({ queryKey: qk.prefs, queryFn: () => api.prefs.get(), staleTime: 5 * 60_000 });
  const save = useSavePrefs();
  const [filters, setFilters] = useState<FilterRule[] | null>(null);

  useEffect(() => {
    if (filters === null && q.data) setFilters(q.data.filters);
  }, [q.data, filters]);

  if (filters === null) return <p className="hint">加载规则…</p>;

  const patch = (id: string, p: Partial<FilterRule>): void =>
    setFilters((fs) => (fs ?? []).map((f) => (f.id === id ? { ...f, ...p } : f)));

  const dirty = JSON.stringify(filters) !== JSON.stringify(q.data?.filters ?? []);
  const broken = filters.filter(badRegex);
  const empty = filters.filter((f) => !f.pattern.trim());
  const blocked = filters.filter((f) => f.act === 'block' && f.on !== false && f.pattern.trim()).length;
  const allowed = filters.filter((f) => f.act === 'allow' && f.on !== false && f.pattern.trim()).length;

  return (
    <>
      <p className="hint tiny">
        在<strong>抓取写库之前</strong>按规则过滤：命中的条目不进数据库。
        <strong>屏蔽</strong> = 命中即丢；<strong>只收</strong> = 只留命中的（白名单）。
        两者同时存在时<span className="nowrap">先按屏蔽拉黑、再按只收拉白</span>。
      </p>

      <ul className="filter-list">
        {filters.map((f) => {
          const bad = badRegex(f);
          return (
            <li className={`filter-rule${bad ? ' bad' : ''}`} key={f.id}>
              <input
                type="checkbox"
                className="filter-check"
                checked={f.on !== false}
                title="启用这条规则"
                aria-label="启用这条规则"
                onChange={(e) => patch(f.id, { on: e.target.checked })}
              />
              <select
                className="input sm"
                aria-label="动作"
                value={f.act}
                onChange={(e) => patch(f.id, { act: e.target.value as FilterRule['act'] })}
              >
                {FILTER_ACTS.map(([v, t]) => (
                  <option key={v} value={v}>
                    {t}
                  </option>
                ))}
              </select>
              <select
                className="input sm"
                aria-label="匹配范围"
                value={f.field}
                onChange={(e) => patch(f.id, { field: e.target.value as FilterRule['field'] })}
              >
                {FILTER_FIELDS.map(([v, t]) => (
                  <option key={v} value={v}>
                    {t}
                  </option>
                ))}
              </select>
              <select
                className="input sm"
                aria-label="匹配方式"
                value={f.kind}
                onChange={(e) => patch(f.id, { kind: e.target.value as FilterRule['kind'] })}
              >
                {FILTER_KINDS.map(([v, t]) => (
                  <option key={v} value={v}>
                    {t}
                  </option>
                ))}
              </select>
              <input
                className="input sm filter-pattern"
                spellCheck={false}
                autoComplete="off"
                placeholder={f.kind === 're' ? '如：v\\d+\\.\\d+' : '关键词，不区分大小写'}
                value={f.pattern}
                onChange={(e) => patch(f.id, { pattern: e.target.value })}
              />
              <button
                className="btn ghost sm icon"
                aria-label="删除规则"
                title="删除这条规则"
                onClick={() => setFilters((fs) => (fs ?? []).filter((x) => x.id !== f.id))}
              >
                <Icon name="trash" size={14} />
              </button>
              {bad && <span className="filter-err">正则写错了，保存时会被丢弃</span>}
            </li>
          );
        })}
      </ul>

      {filters.length === 0 && (
        <p className="hint">还没有规则。加一条试试，比如屏蔽标题含「广告」的条目。</p>
      )}

      <p className="admin-actions">
        <button
          className="btn ghost sm"
          disabled={filters.length >= 50}
          title={filters.length >= 50 ? '最多 50 条' : '再加一条'}
          onClick={() => setFilters((fs) => [...(fs ?? []), emptyFilter()])}
        >
          <Icon name="plus" size={14} />
          添加规则
        </button>
        <button
          className="btn sm"
          disabled={save.isPending || !dirty || broken.length > 0}
          title={broken.length ? '先修正标红的正则' : undefined}
          onClick={() => save.mutate({ filters: filters.filter((f) => f.pattern.trim()) })}
        >
          {save.isPending ? '保存中…' : dirty ? '保存规则' : '已保存'}
        </button>
        <span className="hint tiny">
          {filters.length}/50 条
          {blocked ? ` · 屏蔽 ${blocked}` : ''}
          {allowed ? ` · 只收 ${allowed}` : ''}
        </span>
      </p>

      {empty.length > 0 && <p className="hint tiny">有 {empty.length} 条规则没填内容，保存时会自动跳过。</p>}
      <p className="hint tiny">
        只影响<strong>之后新抓</strong>的条目，已入库的文章不会被删（想清掉得手动删频道重抓）。
        关键词不区分大小写；匹配范围「全部」= 标题 + 摘要 + 正文。单条关键词上限 200 字。
      </p>
    </>
  );
}

/* ============================ 账号 ============================ */

function AccountTab() {
  return (
    <>
      <h3 className="admin-h3">我的账号</h3>
      <AccountForm />
    </>
  );
}
