import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { SourceConfig } from '@feedlore/contract';
import { api } from '../lib/api';
import { qk } from '../lib/query';
import { useSaveSourceConfig } from '../lib/mutations';

/**
 * 全局采集参数（设置页签，**仅管理员可见**）。
 *
 * 从旧 AdminPanel（981f9a9）的 ConfigTab 原样恢复：9f37f41 按「admin 面板精简为
 * 仅用户管理」把它连同 状态/关于 一起移除了，但服务端 GET/POST /api/config 一直都在
 * —— 这里只把「写库即生效」的参数表单接回来，不恢复状态页与关于页。
 *
 * 交互口径（旧版定下的，照搬）：
 * - 保存后用**服务端返回值**回填表单 —— 越界值会被服务端夹回区间而不是报错，
 *   不回填的话界面还显示着用户刚敲的 9999，让人以为真的存进去了；
 * - 每个频道可以在「频道」页签单独设间隔（跟随全局 / 自定），这页只管全局默认值。
 */

/** 采集参数的定义表：一处维护「标签 / 单位 / 提示」，界面与提交都从这里读。 */
const FIELDS: Array<{ key: keyof SourceConfig; label: string; unit?: string; hint?: string }> = [
  { key: 'refreshMinutes', label: '全局采集间隔', unit: '分钟', hint: '5–1440；单个频道可在「频道」页签另设' },
  { key: 'autoRefreshMinutes', label: '前端自动刷新', unit: '分钟', hint: '0 = 关闭；只影响界面' },
  { key: 'timeoutSeconds', label: '抓取超时', unit: '秒', hint: '5–120' },
  { key: 'concurrency', label: '抓取并发', unit: '个', hint: '1–10，按 URL 组计' },
  { key: 'keepPerFeed', label: '每频道保留', unit: '条', hint: '0 = 不限；收藏的不清' },
  { key: 'keepDays', label: '条目保留', unit: '天', hint: '0 = 不限' },
  { key: 'feedFailLimit', label: '失败自动停用', unit: '次', hint: '2–20，成功一次即清零' },
  { key: 'imgTtlDays', label: '图片回源窗口', unit: '天', hint: '超过此期限先返旧图再后台刷新' },
  { key: 'imgKeepDays', label: '图片保留', unit: '天', hint: '超期由定时清理删除' },
  { key: 'imgMaxDim', label: '图片长边上限', unit: 'px', hint: '320–4096，只缩不放' },
  { key: 'imgQuality', label: 'WebP 质量', unit: '', hint: '30–100' },
];

export function CollectionTab() {
  const configQuery = useQuery({ queryKey: qk.adminConfig, queryFn: () => api.admin.config() });
  const save = useSaveSourceConfig();
  const [form, setForm] = useState<Record<string, string>>({});

  // 服务端值到达（或保存后刷新）时重置表单 —— 夹取后的真实值必须回填到界面
  useEffect(() => {
    const src = configQuery.data?.source;
    if (!src) return;
    const next: Record<string, string> = {};
    for (const f of FIELDS) next[f.key] = String(src[f.key] ?? '');
    next.proxyUrl = String(src.proxyUrl ?? '');
    setForm(next);
  }, [configQuery.data]);

  if (configQuery.isPending) return <p className="hint">读取参数…</p>;
  if (configQuery.isError || !configQuery.data) {
    return (
      <p className="hint error-text">
        参数读取失败：{String((configQuery.error as Error)?.message ?? '未知错误')}
      </p>
    );
  }

  const submit = (): void => {
    const source: Record<string, number | string> = {};
    for (const f of FIELDS) source[f.key] = Number(form[f.key] ?? 0);
    source.proxyUrl = form.proxyUrl ?? '';
    save.mutate(source as never);
  };

  return (
    <div className="admin-fields-wrap">
      <p className="hint tiny">
        这里是<strong>全站默认</strong>抓取行为；单个频道想抓得更勤（或更省），去「频道」页签给那一行单独设间隔。
        保存即生效，越界值会被服务端夹回合法区间并回填为真实值。
      </p>

      <div className="admin-fields">
        {FIELDS.map((f) => (
          <label key={f.key} className="admin-field">
            <span className="admin-field-label">
              {f.label}
              {f.unit ? `（${f.unit}）` : ''}
            </span>
            <input
              className="input"
              type="number"
              value={form[f.key] ?? ''}
              onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
            />
            {f.hint && <span className="hint tiny">{f.hint}</span>}
          </label>
        ))}

        <label className="admin-field wide">
          <span className="admin-field-label">出网代理</span>
          <input
            className="input"
            type="text"
            placeholder="http://127.0.0.1:7890（留空 = 直连）"
            value={form.proxyUrl ?? ''}
            onChange={(e) => setForm((s) => ({ ...s, proxyUrl: e.target.value }))}
          />
          <span className="hint tiny">
            ⚠️ v2 的出网层（safeFetch）尚未接代理，填了不会生效；保留该字段是为了从 legacy 迁移配置。
          </span>
        </label>
      </div>

      <div className="admin-actions">
        <button className="btn" onClick={submit} disabled={save.isPending}>
          {save.isPending ? '保存中…' : '保存'}
        </button>
        <span className="hint tiny">保存后表单会自动刷新为服务端夹取后的真实值。</span>
      </div>
    </div>
  );
}
