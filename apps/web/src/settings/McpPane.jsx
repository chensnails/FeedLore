/* 设置弹层「MCP 接口」面板。
 *
 * 职责：管理本账号的 MCP 访问令牌（创建 / 吊销 / 查看最近使用），并展示接入方式。
 * 服务端契约见 packages/contract/src/endpoints.ts 的 mcpTokens 组；`/mcp` 端点
 * 只认 `Authorization: Bearer flm_...`，与浏览器会话完全隔离。
 *
 * 交互约定：
 * - 明文 secret 只在创建响应出现一次：创建成功后高亮展示 + 复制按钮，提示「关闭后不可再看」。
 *   复制**不复用** EntryActions 的 CopyIconButton —— 那条路径会把完整内容塞进 toast，
 *   对一枚长密钥等于把它又显示了一遍，这里只提示「已复制」。
 * - 吊销走 confirm（与设备管理同款），成功后刷新列表。
 * - 无表单脏态（全部即时生效），不需要 onDirtyChange。
 * - 样式复用设备管理的 dev-list / dev-row 与 user-add，零新 CSS。
 */

import { core } from '@core';
import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../ui/Icon.jsx';
import { Result, Section, useResult } from './primitives.jsx';

const S = () => core;

function fmtRel(iso) {
  if (!iso) return '从未使用';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
  if (diff < 30 * 86400e3) return Math.floor(diff / 86400e3) + ' 天前';
  return iso.slice(0, 10);
}

export function McpPane() {
  const s = S();
  const paneRef = useRef(null);
  const [result, show] = useResult();
  const [tokens, setTokens] = useState(null); // null = 读取中
  const [listError, setListError] = useState('');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState('');
  const [copied, setCopied] = useState(false);
  // 刚创建的明文：只存在于这一次会话内存里，重新拉列表不会清掉，关闭设置弹层后自然消失
  const [freshSecret, setFreshSecret] = useState(null);

  useEffect(() => {
    if (s && s.bindSections && paneRef.current) s.bindSections(paneRef.current);
  }, []);

  async function load() {
    try {
      const res = await s.apiFetch('/api/mcp-tokens');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(s.errText(data, 'HTTP ' + res.status));
      setTokens(data.tokens || []);
      setListError('');
    } catch (err) {
      setListError('读取令牌失败：' + String((err && err.message) || err));
      setTokens([]);
    }
  }

  useEffect(() => { load(); }, []);

  async function create() {
    const n = name.trim();
    if (!n) { show(false, '先给令牌起个名字（比如接的客户端）'); return; }
    setCreating(true);
    try {
      const res = await s.apiFetch('/api/mcp-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: n, scope: 'read' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(s.errText(data, 'HTTP ' + res.status));
      setFreshSecret({ secret: data.secret, prefix: data.token.prefix });
      setCopied(false);
      setName('');
      show(true, '令牌已创建');
      await load();
    } catch (err) {
      show(false, '创建失败：' + String((err && err.message) || err));
    } finally {
      setCreating(false);
    }
  }

  async function copySecret() {
    if (!freshSecret) return;
    const ok = await s.copyText(freshSecret.secret);
    if (!ok) { show(false, '复制失败，请手动选择文本复制'); return; }
    setCopied(true);
    s.toast('已复制令牌');
    setTimeout(() => setCopied(false), 1600);
  }

  async function revoke(t) {
    const ok = await s.confirm({
      title: '吊销这个令牌？',
      desc: `${t.name}（${t.prefix}…）会立即失去访问权，用它的 AI 客户端需要换新令牌。`,
      confirmText: '吊销',
      danger: true,
    });
    if (!ok) return;
    setRevoking(t.id);
    try {
      const res = await s.apiFetch('/api/mcp-tokens/' + encodeURIComponent(t.id), { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(s.errText(data, 'HTTP ' + res.status));
      s.toast('已吊销 ' + t.name);
      if (freshSecret && freshSecret.prefix === t.prefix) setFreshSecret(null);
      await load();
    } catch (err) {
      show(false, '吊销失败：' + String((err && err.message) || err));
    } finally {
      setRevoking('');
    }
  }

  return (
    <div ref={paneRef} className="pane" role="group" aria-label="MCP 接口设置">
      <Section secKey="mcp-usage" title="接入方式" open>
        <p className="hint" style={{ margin: '0 0 var(--sp-2)' }}>
          把你的 RSS 数据开放给外部 AI 客户端（Claude、Cherry Studio 等支持 MCP 的应用）。
          在客户端里添加一个 MCP 服务器，类型选「HTTP / Streamable HTTP」：
        </p>
        <p className="hint" style={{ margin: '0 0 var(--sp-2)', wordBreak: 'break-all' }}>
          地址 <code>{location.origin}/mcp</code>
          <button type="button" className="u-btn" title="复制接入地址" aria-label="复制接入地址"
            onClick={async () => { if (await s.copyText(location.origin + '/mcp')) s.toast('已复制接入地址'); }}>
            <Icon n={copied ? 'check' : 'link'} />
          </button>
          ，请求头加 <code>Authorization: Bearer 你的令牌</code>。
        </p>
        <p className="hint" style={{ margin: 0 }}>
          令牌与登录会话完全独立，吊销不影响网页登录。当前版本只开放只读工具
          （频道列表、文章检索与全文、日报）；管理类操作不接受 MCP 调用。
        </p>
      </Section>

      <Section secKey="mcp-tokens" title="访问令牌" sub={tokens ? `${tokens.length} 枚` : ''} open>
        {tokens === null && !listError ? <div className="hint">正在读取令牌…</div> : null}
        {listError ? (
          <div className="hint pane-msg">
            {listError}
            <button className="btn btn-ghost btn-sm" type="button" onClick={load}>重试</button>
          </div>
        ) : null}

        {Array.isArray(tokens) && tokens.length === 0 && !listError ? (
          <div className="hint">还没有令牌。在下面创建一枚，填进 AI 客户端就能开始使用。</div>
        ) : null}

        {Array.isArray(tokens) && tokens.length > 0 ? (
          <div className="dev-list" id="mcpTokenList">
            {tokens.map((t) => (
              <div className="dev-row" key={t.id}>
                <div className="dev-main">
                  <span className="dev-name">{t.name}</span>
                  <span className="dev-meta">{t.prefix}… · {fmtRel(t.lastUsedAt)}</span>
                </div>
                <button type="button" className="u-btn danger" aria-label={'吊销令牌 ' + t.name}
                  disabled={revoking === t.id} onClick={() => revoke(t)}>
                  {revoking === t.id ? '吊销中…' : '吊销'}
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <div className="user-add">
          <input
            type="text"
            placeholder="令牌名称（如：我的 Claude）"
            aria-label="新令牌名称"
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') create(); }}
          />
          <button type="button" className="btn primary" disabled={creating} aria-busy={creating} onClick={create}>
            {creating ? '创建中…' : '创建令牌'}
          </button>
        </div>

        {freshSecret ? (
          <div className="hint pane-msg" role="status">
            <strong>令牌已创建，现在复制保存 —— 关闭后不再显示：</strong>
            <div style={{ wordBreak: 'break-all', margin: 'var(--sp-1) 0' }}>
              <code>{freshSecret.secret}</code>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={copySecret}>
              <Icon n={copied ? 'check' : 'copy'} /> {copied ? '已复制' : '复制令牌'}
            </button>
            <span style={{ marginLeft: 'var(--sp-2)' }}>令牌等同密码，只发给可信的客户端。</span>
          </div>
        ) : null}
      </Section>

      <Result result={result} />
    </div>
  );
}
