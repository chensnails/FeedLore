/* 设置弹层「MCP 接口」面板。
 *
 * 职责：管理本账号的 MCP 访问令牌（创建 / 吊销 / 查看最近使用），并展示接入方式。
 * 服务端契约见 packages/contract/src/endpoints.ts 的 mcpTokens 组；`/mcp` 端点
 * 只认 `Authorization: Bearer flm_...`，与浏览器会话完全隔离。
 *
 * 交互约定（v2.5.0 设置 A 方案）：
 * - 令牌列表只留紧凑行（名称 / 前缀 / 最近使用），点行打开详情层看完整信息并吊销；
 * - 创建也收进详情层：名称输入 → 创建 → 同一层里展示明文 secret 与复制按钮，
 *   关闭层即再也看不到（明文只存在于这一层的内存里）；
 * - 复制**不复用** EntryActions 的 CopyIconButton —— 那条路径会把完整内容塞进 toast，
 *   对一枚长密钥等于把它又显示了一遍，这里只提示「已复制」。
 * - 无表单脏态（全部即时生效），不需要 onDirtyChange。
 */

import { core } from '@core';
import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../ui/Icon.jsx';
import { DetailSheet } from './DetailSheet.jsx';
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

const openOnKey = (fn) => (ev) => {
  if (ev.target !== ev.currentTarget) return;
  if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); fn(); }
};

/* ---------- 令牌详情层：查看 + 吊销 ---------- */
function TokenSheet({ token, busy, onClose, onRevoke, error }) {
  return (
    <DetailSheet
      title={token.name}
      subtitle={`${token.prefix}…`}
      onClose={onClose}
      foot={
        <button className="btn btn-danger" id="revokeTokenBtn" type="button"
          disabled={busy} onClick={() => onRevoke(token)}>
          {busy ? '吊销中…' : '吊销令牌'}
        </button>
      }>
      <div className="ds-stat">
        <div className="ds-stat-line">只读权限 · 可查询频道、文章与日报</div>
        <div className="ds-stat-line">最近使用 {fmtRel(token.lastUsedAt)}</div>
        {token.createdAt ? (
          <div className="ds-stat-line">创建于 {String(token.createdAt).slice(0, 10)}</div>
        ) : null}
      </div>
      <small className="form-tip">
        令牌与登录会话完全独立，吊销不影响网页登录；用它的 AI 客户端会立即失去访问权，需要换新令牌。
        同一时间可以有多枚令牌，建议按客户端分开创建，方便单独吊销。
      </small>
      <Result id="tokenSheetResult" result={error ? { ok: false, msg: error } : null} />
    </DetailSheet>
  );
}

/* ---------- 新建令牌详情层：创建后在同一层展示明文 ---------- */
function NewTokenSheet({ onClose, onCreated }) {
  const s = S();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState(null);   // {secret, prefix}
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState('');

  const create = async () => {
    const n = name.trim();
    if (!n) { setErr('先给令牌起个名字（比如接的客户端）'); return; }
    setBusy(true);
    setErr('');
    try {
      const res = await s.apiFetch('/api/mcp-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: n, scope: 'read' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(s.errText(data, '创建失败'));
      setFresh({ secret: data.secret, prefix: data.token.prefix });
      setCopied(false);
      s.toast('令牌已创建');
      onCreated();
    } catch (e) {
      setErr('创建失败：' + String((e && e.message) || e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!fresh) return;
    const ok = await s.copyText(fresh.secret);
    if (!ok) { setErr('复制失败，请手动选择文本复制'); return; }
    setCopied(true);
    s.toast('已复制令牌');
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <DetailSheet
      title={fresh ? '令牌已创建' : '创建访问令牌'}
      subtitle={fresh ? `${fresh.prefix}…` : '给接进来的 AI 客户端用'}
      onClose={onClose}
      foot={fresh ? (
        <button className="btn btn-primary" type="button" onClick={onClose}>我已保存</button>
      ) : (
        <>
          <button className="btn" type="button" onClick={onClose}>取消</button>
          <button className="btn btn-primary" id="createTokenBtn" type="button"
            disabled={busy} onClick={create}>
            {busy ? '创建中…' : '创建令牌'}
          </button>
        </>
      )}>
      {fresh ? (
        <div className="hint pane-msg" role="status">
          <strong>现在复制保存 —— 关闭后不再显示：</strong>
          <div style={{ wordBreak: 'break-all', margin: 'var(--sp-1) 0' }}>
            <code id="freshTokenSecret">{fresh.secret}</code>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" id="copyTokenBtn" onClick={copy}>
            <Icon n={copied ? 'check' : 'copy'} /> {copied ? '已复制' : '复制令牌'}
          </button>
          <span style={{ marginLeft: 'var(--sp-2)' }}>令牌等同密码，只发给可信的客户端。</span>
        </div>
      ) : (
        <div className="form-row">
          <label htmlFor="newTokenName">令牌名称</label>
          <input id="newTokenName" type="text" placeholder="令牌名称（如：我的 Claude）"
            aria-label="新令牌名称" maxLength={40} autoComplete="off"
            value={name} onChange={(ev) => setName(ev.target.value)}
            onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); create(); } }} />
          <small className="form-tip">
            名字只用来区分客户端，之后删改都按它找；令牌本身只读，不会改动你的数据。
          </small>
        </div>
      )}
      <Result id="tokenSheetResult" result={err ? { ok: false, msg: err } : null} />
    </DetailSheet>
  );
}

export function McpPane() {
  const s = S();
  const paneRef = useRef(null);
  const [result, show] = useResult();
  const [tokens, setTokens] = useState(null); // null = 读取中
  const [listError, setListError] = useState('');
  const [revoking, setRevoking] = useState('');
  const [sheet, setSheet] = useState(null);   // {type:'new'} | {type:'token', id}
  const [sheetError, setSheetError] = useState('');
  const openSheet = (next) => { setSheetError(''); setSheet(next); };

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

  async function revoke(t) {
    const ok = await s.confirm({
      title: '吊销这个令牌？',
      desc: `${t.name}（${t.prefix}…）会立即失去访问权，用它的 AI 客户端需要换新令牌。`,
      confirmText: '吊销',
      danger: true,
    });
    if (!ok) return;
    setRevoking(t.id);
    setSheetError('');
    try {
      const res = await s.apiFetch('/api/mcp-tokens/' + encodeURIComponent(t.id), { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(s.errText(data, 'HTTP ' + res.status));
      setSheet(null);
      s.toast('已吊销 ' + t.name);
      await load();
    } catch (err) {
      const msg = '吊销失败：' + String((err && err.message) || err);
      setSheetError(msg);
      show(false, msg);
    } finally {
      setRevoking('');
    }
  }

  const token = sheet && sheet.type === 'token' ? (tokens || []).find((t) => t.id === sheet.id) : null;

  const renderTokenRow = (t) => (
    <div className="sl-row" key={t.id} data-token-id={t.id}
      role="button" tabIndex={0} aria-label={`${t.name}：查看令牌详情`}
      onClick={() => openSheet({ type: 'token', id: t.id })}
      onKeyDown={openOnKey(() => openSheet({ type: 'token', id: t.id }))}>
      <span className="sl-ava">
        <Icon n="link" />
      </span>
      <div className="sl-main">
        <div className="sl-name">{t.name}</div>
        <div className="sl-sub">{t.prefix}… · {fmtRel(t.lastUsedAt)}</div>
      </div>
      <svg className="ico feed-caret" aria-hidden="true" focusable="false"><use href="#i-chevron-right" /></svg>
    </div>
  );

  return (
    <div ref={paneRef} className="tab-pane" data-pane="mcp" role="group" aria-label="MCP 接口设置">
      <div className="pane-scroll">
        <Section secKey="mcp-usage" title="接入方式" open>
          <p className="hint" style={{ margin: '0 0 var(--sp-2)' }}>
            把你的 RSS 数据开放给外部 AI 客户端（Claude、Cherry Studio 等支持 MCP 的应用）。
            在客户端里添加一个 MCP 服务器，类型选「HTTP / Streamable HTTP」：
          </p>
          <p className="hint" style={{ margin: '0 0 var(--sp-2)', wordBreak: 'break-all' }}>
            地址 <code>{location.origin}/mcp</code>
            <button type="button" className="u-btn" title="复制接入地址" aria-label="复制接入地址"
              onClick={async () => { if (await s.copyText(location.origin + '/mcp')) s.toast('已复制接入地址'); }}>
              <Icon n="link" />
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
            <div className="sl-empty">还没有令牌。点「创建令牌」，填进 AI 客户端就能开始使用。</div>
          ) : null}

          {Array.isArray(tokens) && tokens.length > 0 ? (
            <div className="sl-list" id="mcpTokenList">{tokens.map(renderTokenRow)}</div>
          ) : null}

          <div className="sl-toolbar">
            <button className="btn btn-ghost btn-sm" id="newMcpTokenBtn" type="button"
              onClick={() => openSheet({ type: 'new' })}>
              <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-plus" /></svg>
              创建令牌
            </button>
            <span className="sl-toolbar-note">按客户端分开建，吊销时互不影响</span>
          </div>

          <small className="form-tip">
            明文令牌只在创建时显示一次，之后只能看到前缀。点行可看详情并吊销。
          </small>
          <Result id="mcpResult" result={result} />
        </Section>
      </div>

      {sheet && sheet.type === 'new' ? (
        <NewTokenSheet onClose={() => setSheet(null)} onCreated={load} />
      ) : null}
      {token ? (
        <TokenSheet key={'tok-' + token.id} token={token} busy={revoking === token.id}
          error={sheetError} onClose={() => setSheet(null)} onRevoke={revoke} />
      ) : null}
    </div>
  );
}
