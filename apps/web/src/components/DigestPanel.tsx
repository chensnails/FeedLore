import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type { Digest, DigestConfig, PrefsResponse } from '@feedlore/contract';
import { api } from '../lib/api';
import { qk } from '../lib/query';
import { useGenerateDigest, useSavePrefs, useTestLlm } from '../lib/mutations';

/**
 * 日报面板（每个账号自己的，不是管理端）。
 *
 * 两个页签刻意分开：
 * - 日报：只读今天（或某个历史日期）的结果，操作只有「生成 / 重新生成」；
 * - 设置：日报开关 + 模型配置。放在同一个面板是因为它们**必须一起配**——
 *   「开了自动但没填 Key」是最常见的状态，配置入口离结果太远，用户永远找不到。
 *
 * 三个界面上的取舍：
 * 1. 生成是慢操作：pending 期间按钮禁用并显示「生成中…（可能几十秒）」，
 *    否则用户会连点，把额度烧三遍。
 * 2. 降级结果要显眼地说出来：`fallback=true` 意味着这段文字不是模型写的，
 *    混在正常日报里会让人以为模型质量差。
 * 3. apiKey 输入框**永远为空**：已存的只回显掩码。留空提交 = 不改，
 *    想清除要点明确的「清除密钥」——避免「只想改模型名」把 Key 冲掉。
 */

type Tab = 'read' | 'settings';

const fmtTs = (ms: number | null | undefined): string =>
  typeof ms === 'number' ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—';

/** 上海时区的今天（与服务端 shanghaiDate 同口径，避免本地时区差一天）。 */
function shanghaiToday(): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function DigestPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('read');
  /** '' = 今天。用空串而不是硬编码日期，跨零点后「今天」仍然是对的。 */
  const [date, setDate] = useState('');

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="reader-backdrop" onClick={onClose} role="presentation">
      <section className="admin-sheet digest-sheet" onClick={(e) => e.stopPropagation()}>
        <button className="reader-close btn ghost" onClick={onClose} aria-label="关闭">
          ✕
        </button>

        <h2 className="admin-title">日报</h2>
        <div className="admin-tabs" role="tablist">
          {([
            { id: 'read' as const, label: '今日简报' },
            { id: 'settings' as const, label: '日报设置' },
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
          {tab === 'read' && <ReadTab date={date} onPickDate={setDate} />}
          {tab === 'settings' && <SettingsTab />}
        </div>
      </section>
    </div>
  );
}

/* ============================ 读取 ============================ */

function ReadTab({ date, onPickDate }: { date: string; onPickDate: (d: string) => void }) {
  const today = shanghaiToday();
  const datesQuery = useQuery({ queryKey: qk.digestDates, queryFn: () => api.ai.dates() });
  const digestQuery = useQuery({
    queryKey: [...qk.digest, date],
    queryFn: () => api.ai.get(date || undefined),
  });
  const generate = useGenerateDigest();

  const dates = useMemo(() => {
    const list = datesQuery.data ?? [];
    // 今天永远在选项里（哪怕还没生成），否则用户没法对「今天」点生成
    const out = list.includes(today) ? list : [today, ...list];
    // 正在看一个不在列表里的历史日期（比如列表还没刷新）时也要能选中它
    return date && !out.includes(date) ? [date, ...out] : out;
  }, [datesQuery.data, date, today]);

  const data: Digest | null = digestQuery.data?.digest ?? null;

  return (
    <>
      <div className="digest-bar">
        <label className="digest-date">
          <span className="admin-field-label">日期</span>
          <select value={date || today} onChange={(e) => onPickDate(e.target.value === today ? '' : e.target.value)}>
            {dates.map((d) => (
              <option key={d} value={d}>
                {d}
                {d === today ? '（今天）' : ''}
              </option>
            ))}
          </select>
        </label>

        <button
          className="btn primary"
          onClick={() => generate.mutate({ date: date || undefined, force: true })}
          disabled={generate.isPending}
        >
          {generate.isPending ? '生成中…（可能几十秒）' : data ? '重新生成' : '生成日报'}
        </button>

        {data && (
          <span className="hint tiny">
            {fmtTs(data.generatedAt)} · {data.model || '未配置模型'} · {data.stats.kept}/{data.stats.collected} 条 ·{' '}
            {data.stats.feeds} 个频道
            {data.usedMapReduce && ' · map-reduce'}
          </span>
        )}
      </div>

      {digestQuery.isPending && <p className="hint">读取日报…</p>}

      {digestQuery.isError && (
        <p className="hint error-text">读取失败：{String((digestQuery.error as Error)?.message ?? '未知错误')}</p>
      )}

      {!digestQuery.isPending && !digestQuery.isError && !data && (
        <p className="hint">
          这一天还没有日报。点上面的「生成日报」——它会把过去 24 小时的条目汇总成一份简报。
          {!date && '（需要先在「日报设置」里配好模型）'}
        </p>
      )}

      {data && (
        <article className="digest-body">
          {data.fallback && (
            <p className="admin-alert">
              这是<strong>规则摘要</strong>，不是模型生成的：{data.error ?? '模型不可用'}。
              配好模型后点「重新生成」即可。
            </p>
          )}

          <p className="digest-overview">{data.overview}</p>

          {data.highlights.length > 0 && (
            <>
              <h3 className="admin-h3">今日看点</h3>
              <ul className="digest-highlights">
                {data.highlights.map((h, i) => (
                  <li key={i}>
                    <span className="digest-comment">{h.text}</span>
                    {h.item && <DigestItemLine item={h.item} />}
                  </li>
                ))}
              </ul>
            </>
          )}

          {data.sections.map((s, i) => (
            <section key={i} className="digest-section">
              <h3 className="admin-h3">{s.title}</h3>
              <ul className="digest-list">
                {s.items.map((it, j) => (
                  <li key={j}>
                    <span className="digest-comment">{it.comment}</span>
                    {it.item && <DigestItemLine item={it.item} />}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </article>
      )}
    </>
  );
}

function DigestItemLine({ item }: { item: NonNullable<Digest['highlights'][number]['item']> }) {
  return (
    <span className="digest-item">
      <span className="digest-item-name">{item.name}</span>
      <span className="digest-item-meta">
        {item.feedName}
        {item.size ? ` · ${item.size}` : ''}
        {item.tags.length > 0 ? ` · ${item.tags.slice(0, 3).map((t) => `#${t}`).join(' ')}` : ''}
      </span>
      {item.link && (
        <a href={item.link} target="_blank" rel="noreferrer noopener" className="digest-link">
          打开
        </a>
      )}
    </span>
  );
}

/* ============================ 设置 ============================ */

interface FormState {
  digest: DigestConfig;
  llm: {
    baseUrl: string;
    model: string;
    temperature: number;
    thinking: boolean;
    thinkingDepth: number;
  };
  /** 只在用户真的输入了东西时才有值；空串 = 不改。 */
  apiKey: string;
}

function formFromPrefs(p: PrefsResponse): FormState {
  return {
    digest: { ...p.digest },
    llm: {
      baseUrl: p.llm.baseUrl,
      model: p.llm.model,
      temperature: p.llm.temperature,
      thinking: p.llm.thinking,
      thinkingDepth: p.llm.thinkingDepth,
    },
    apiKey: '',
  };
}

function SettingsTab() {
  const prefsQuery = useQuery({ queryKey: qk.prefs, queryFn: () => api.prefs.get() });
  const save = useSavePrefs();
  const testLlm = useTestLlm();
  const [form, setForm] = useState<FormState | null>(null);

  // 首次拿到偏好时填表。之后**不**跟着查询结果覆盖，否则用户正在输入时会被冲掉
  useEffect(() => {
    if (prefsQuery.data && !form) setForm(formFromPrefs(prefsQuery.data));
  }, [prefsQuery.data, form]);

  if (prefsQuery.isPending || !form) return <p className="hint">读取设置…</p>;
  if (prefsQuery.isError) {
    return <p className="hint error-text">读取失败：{String((prefsQuery.error as Error)?.message ?? '未知错误')}</p>;
  }

  const view = prefsQuery.data;
  const d = form.digest;

  const setDigest = <K extends keyof DigestConfig>(key: K, value: DigestConfig[K]): void =>
    setForm((s) => (s ? { ...s, digest: { ...s.digest, [key]: value } } : s));

  const setLlm = <K extends keyof FormState['llm']>(key: K, value: FormState['llm'][K]): void =>
    setForm((s) => (s ? { ...s, llm: { ...s.llm, [key]: value } } : s));

  const onSubmit = (): void => {
    const llm: Record<string, unknown> = { ...form.llm };
    // 留空 = 不改已存的 Key（见文件头第 3 条）
    if (form.apiKey.trim()) llm.apiKey = form.apiKey.trim();
    save.mutate(
      {
        digest: {
          auto: d.auto,
          time: d.time,
          mode: d.mode,
          feeds: d.feeds,
          maxPerFeed: Number(d.maxPerFeed),
          maxTotal: Number(d.maxTotal),
          keepDays: Number(d.keepDays),
          style: d.style,
        },
        // lastAuto 由服务端调度器独占写，这里不提交
        llm: llm as never,
      },
      { onSuccess: () => setForm((s) => (s ? { ...s, apiKey: '' } : s)) },
    );
  };

  return (
    <>
      <h3 className="admin-h3">日报</h3>
      <div className="admin-fields">
        <label className="admin-field">
          <span className="admin-field-label">自动生成</span>
          <label className="digest-check">
            <input type="checkbox" checked={d.auto} onChange={(e) => setDigest('auto', e.target.checked)} />
            <span>每天到点自动生成</span>
          </label>
          <span className="hint tiny">没配模型时会跳过（不会每分钟重试烧额度）</span>
        </label>

        <label className="admin-field">
          <span className="admin-field-label">生成时间</span>
          <input type="time" value={d.time} onChange={(e) => setDigest('time', e.target.value)} />
          <span className="hint tiny">上海时区</span>
        </label>

        <label className="admin-field">
          <span className="admin-field-label">摘要范围</span>
          <select value={d.mode} onChange={(e) => setDigest('mode', e.target.value as DigestConfig['mode'])}>
            <option value="enabled">仅开启采集的频道</option>
            <option value="all">全部频道</option>
            <option value="custom">自定义（在频道面板里选）</option>
          </select>
        </label>

        <label className="admin-field">
          <span className="admin-field-label">每个频道上限（条）</span>
          <input
            type="number"
            value={d.maxPerFeed}
            onChange={(e) => setDigest('maxPerFeed', Number(e.target.value))}
          />
        </label>

        <label className="admin-field">
          <span className="admin-field-label">总量上限（条）</span>
          <input type="number" value={d.maxTotal} onChange={(e) => setDigest('maxTotal', Number(e.target.value))} />
          <span className="hint tiny">超过 90 条会自动走 map-reduce</span>
        </label>

        <label className="admin-field">
          <span className="admin-field-label">日报保留（天）</span>
          <input type="number" value={d.keepDays} onChange={(e) => setDigest('keepDays', Number(e.target.value))} />
        </label>

        <label className="admin-field wide">
          <span className="admin-field-label">风格要求（可选）</span>
          <textarea
            rows={3}
            value={d.style}
            placeholder="例如：优先挑影视资源，少提工具类；每条点评尽量短。"
            onChange={(e) => setDigest('style', e.target.value)}
          />
          <span className="hint tiny">只影响选材、语气与篇幅，不会改动输出结构</span>
        </label>
      </div>

      <h3 className="admin-h3">模型（OpenAI 兼容接口）</h3>
      <div className="admin-fields">
        <label className="admin-field wide">
          <span className="admin-field-label">接口地址</span>
          <input
            type="text"
            placeholder="https://api.openai.com/v1 或完整的 …/chat/completions"
            value={form.llm.baseUrl}
            onChange={(e) => setLlm('baseUrl', e.target.value)}
          />
          <span className="hint tiny">只能是公网地址（内网/回环会被服务端拒绝，防 SSRF）</span>
        </label>

        <label className="admin-field">
          <span className="admin-field-label">模型名</span>
          <input
            type="text"
            placeholder="gpt-4o-mini / qwen-plus / …"
            value={form.llm.model}
            onChange={(e) => setLlm('model', e.target.value)}
          />
        </label>

        <label className="admin-field">
          <span className="admin-field-label">API Key</span>
          <input
            type="password"
            autoComplete="off"
            placeholder={view.llm.apiKeySet ? `已保存：${view.llm.apiKeyHint || '（无法解密，请重填）'}` : 'sk-…'}
            value={form.apiKey}
            onChange={(e) => setForm((s) => (s ? { ...s, apiKey: e.target.value } : s))}
          />
          <span className="hint tiny">
            留空表示不改动
            {view.llm.apiKeySet && (
              <>
                {' · '}
                <button
                  type="button"
                  className="linkish"
                  onClick={() => save.mutate({ llm: { apiKey: '' } })}
                >
                  清除已保存的密钥
                </button>
              </>
            )}
          </span>
        </label>

        <label className="admin-field">
          <span className="admin-field-label">温度</span>
          <input
            type="number"
            step="0.1"
            min={0}
            max={1.5}
            value={form.llm.temperature}
            onChange={(e) => setLlm('temperature', Number(e.target.value))}
          />
          <span className="hint tiny">0–1.5；日报要稳定，建议 0.2–0.5</span>
        </label>

        <label className="admin-field">
          <span className="admin-field-label">思考模式</span>
          <label className="digest-check">
            <input type="checkbox" checked={form.llm.thinking} onChange={(e) => setLlm('thinking', e.target.checked)} />
            <span>开启（仅部分模型支持）</span>
          </label>
          <select value={form.llm.thinkingDepth} onChange={(e) => setLlm('thinkingDepth', Number(e.target.value))}>
            <option value={1}>浅（512 token）</option>
            <option value={2}>中（2048 token）</option>
            <option value={3}>深（8192 token）</option>
          </select>
        </label>
      </div>

      <div className="admin-actions">
        <button className="btn primary" onClick={onSubmit} disabled={save.isPending}>
          {save.isPending ? '保存中…' : '保存设置'}
        </button>
        <button
          className="btn ghost"
          onClick={() =>
            testLlm.mutate({
              baseUrl: form.llm.baseUrl,
              model: form.llm.model,
              ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
              thinking: form.llm.thinking,
              thinkingDepth: form.llm.thinkingDepth,
            })
          }
          disabled={testLlm.isPending}
        >
          {testLlm.isPending ? '测试中…' : '测试连接'}
        </button>
        <span className="hint tiny">测试用的是表单当前值，不要求先保存</span>
      </div>
    </>
  );
}
