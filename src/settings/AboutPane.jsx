/* 设置弹层「关于」面板（v1.3.0 起 React 化，原 index.html 内联 DOM + app.js 绑定迁移至此）。
 * 行为与旧实现等价：进入面板拉一次 /api/version，检查更新 POST /api/version/check，
 * 三态结果（upd / ok / err）复用旧 test-result 类名，样式零改动。
 * v1.1.0：新增「一键更新」（POST /api/update → watchtower 拉镜像重启，仅管理员）：
 * 触发后轮询 /api/version 直到版本号变化（请求失败视为容器重启中），完成后刷新。 */

import { core } from '@core';
import React, { useEffect, useState } from 'react';

const S = () => core;   // 核心逻辑单例（@core，v2.0.0 起改为模块引用）

const GH_REPO = 'https://github.com/chensnails/feedlore';

export function AboutPane() {
  const [version, setVersion] = useState('读取中…');
  // result: { kind: 'upd', latest, current, releaseUrl } | { kind: 'ok', current } | { kind: 'err', msg }
  const [result, setResult] = useState(null);
  const isAdmin = S().isAdmin ? S().isAdmin() : false;
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);   // 一键更新：已触发，等 watchtower 拉镜像重启
  const [updateEnabled, setUpdateEnabled] = useState(null); // 是否接入一键更新通道（镜像+watchtower）；null=未知

  // 进入「关于」页拉一次版本号（旧 loadAboutPage 的迁移）；
  // 面板随 tab 切换挂载/卸载，每次进入都会重新拉取，与旧行为一致
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const res = await S().apiFetch('/api/version');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const d = await res.json();
        if (!dead) setVersion('v' + (d.version || '—'));
        if (!dead && d.updateEnabled !== undefined) setUpdateEnabled(!!d.updateEnabled);
      } catch (err) {
        if (!dead) setVersion('读取失败');
      }
    })();
    return () => { dead = true; };
  }, []);

  const check = async () => {
    setChecking(true);
    setResult(null);
    try {
      const res = await S().apiFetch('/api/version/check', { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      if (!d.ok) throw new Error(d.error || ('HTTP ' + res.status));
      if (d.hasUpdate) {
        setResult({ kind: 'upd', latest: d.latest, current: d.current, releaseUrl: d.releaseUrl || '' });
      } else {
        setResult({ kind: 'ok', current: d.current });
      }
    } catch (err) {
      setResult({ kind: 'err', msg: '检测失败：' + String((err && err.message) || err) });
    } finally {
      setChecking(false);
    }
  };

  /* 一键更新（v1.1.0）：触发 watchtower 立即检查 → 拉新镜像 → 重启容器。
   * 轮询 /api/version 直至版本号变化；期间请求失败 = 容器正在重启，继续等。 */
  const doUpdate = async () => {
    if (!window.confirm('将拉取最新镜像并重启容器（约 1~2 分钟），期间页面短暂不可用。确定更新？')) return;
    setUpdating(true);
    try {
      const res = await S().apiFetch('/api/update', { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + res.status));
    } catch (err) {
      setUpdating(false);
      S().toast('更新失败：' + String((err && err.message) || err), false);
      return;
    }
    const from = result.current;
    const started = Date.now();
    const poll = async () => {
      try {
        const res = await S().apiFetch('/api/version');
        const d = await res.json();
        if (d.version && d.version !== from) {
          S().toast('已更新到 v' + d.version + '，正在刷新…');
          setTimeout(() => window.location.reload(), 1200);
          return;
        }
      } catch (_) { /* 重启中：连接失败继续等 */ }
      if (Date.now() - started > 5 * 60 * 1000) {
        setUpdating(false);
        S().toast('更新等待超时（5 分钟），请稍后手动刷新查看版本', false);
        return;
      }
      setTimeout(poll, 3000);
    };
    setTimeout(poll, 3000);
  };

  return (
    <div className="about-body pane-scroll">
      <div className="about-brand">
        <img className="about-logo" src="/favicon.svg" alt="笺川" width="56" height="56" />
        <div className="about-brand-txt">
          <h3 className="about-name">笺川 <span className="about-en">FeedLore</span></h3>
          <p className="about-slogan">拾取值得读的 —— 自托管 RSS 阅读器 · 卡片墙</p>
        </div>
      </div>
      <dl className="about-kv">
        <div className="about-kv-row">
          <dt>当前版本</dt>
          <dd id="aboutVersion">{version}</dd>
        </div>
        <div className="about-kv-row">
          <dt>仓库地址</dt>
          <dd><a href={GH_REPO} target="_blank" rel="noopener">github.com/chensnails/feedlore</a></dd>
        </div>
        <div className="about-kv-row">
          <dt>开源许可</dt>
          <dd>MIT</dd>
        </div>
      </dl>
      <div className="about-check">
        <button
          className="btn btn-primary"
          id="aboutCheckBtn"
          type="button"
          disabled={checking || updating}
          onClick={check}
        >
          {checking ? '检测中…' : '检查更新'}
        </button>
      </div>
      {isAdmin && updateEnabled === false && (
        <p className="about-note">当前部署未接入一键更新通道（仅镜像模式 + Watchtower 支持）。检测到新版本时，请手动更新部署。</p>
      )}
      {result && result.kind === 'upd' && (
        <div className="test-result show upd" role="status">
          发现新版本 <b>v{result.latest}</b>（当前 v{result.current}）
          {result.releaseUrl && (
            <>
              {' · '}
              <a href={result.releaseUrl} target="_blank" rel="noopener">查看发布</a>
            </>
          )}
          {isAdmin && updateEnabled && !updating && (
            <button
              className="btn btn-primary btn-sm"
              id="aboutUpdateBtn"
              type="button"
              style={{ marginLeft: 'var(--sp-3)' }}
              onClick={doUpdate}
            >
              一键更新
            </button>
          )}
        </div>
      )}
      {updating && (
        <div className="test-result show upd" role="status">
          正在更新：拉取镜像并重启容器，页面会自动刷新（期间连接失败属正常现象）…
        </div>
      )}
      {result && result.kind === 'ok' && (
        <div className="test-result show ok" role="status">已是最新版本（v{result.current}）</div>
      )}
      {result && result.kind === 'err' && (
        <div className="test-result show err" role="status">{result.msg}</div>
      )}
      <p className="about-note">版本检测会向 GitHub 查询最新的 Release / Tag（结果缓存 10 分钟，不会频繁请求）。</p>
    </div>
  );
}
