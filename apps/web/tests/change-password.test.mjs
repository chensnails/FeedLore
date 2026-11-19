/* 强制改密页（change-password.html）的行为测试（node:test + jsdom）。
 *
 * 这是安全入口：未登录必须去登录页、已改过密的人不该停留、mustChangePassword 才能提交。
 * 现有 ui-regression 全是「登录后设置弹层改密」，这个独立文档的守卫流程 0 覆盖，
 * 曾靠真机手动验证。这里用 jsdom 真执行页面内联脚本，桩掉 fetch / 导航 / errText，
 * 断言用户可见行为（提示文案、焦点、按钮状态、导航目标），不读源码文本。
 *
 * 注：jsdom 的 location.replace 只读且会打出「Not implemented: navigation」，
 * 故在测试副本里把它替换成 window.__nav（不改源码），以便精确断言跳转目标。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(HERE, '..', 'change-password.html'), 'utf8');

/**
 * 载入改密页并执行其内联脚本。
 * @param {{session?: any, postStatus?: number, postBody?: any, fetchImpl?: Function}} opts
 */
async function mount(opts = {}) {
  const nav = [];
  const jsdomErrors = [];
  const session =
    opts.session === undefined
      ? { authenticated: true, mustChangePassword: true, username: 'admin' }
      : opts.session;
  const fetchCalls = [];
  const fetchImpl =
    opts.fetchImpl ||
    (async (url, init) => {
      fetchCalls.push({ url, init });
      if (url === '/api/session') return { ok: true, json: async () => session };
      if (url === '/api/account') {
        return {
          ok: (opts.postStatus ?? 200) < 400,
          status: opts.postStatus ?? 200,
          json: async () => opts.postBody ?? { ok: true },
        };
      }
      return { ok: false, json: async () => ({}) };
    });
  const html = HTML.replace(/location\.replace\(/g, 'window.__nav(');
  const vc = new VirtualConsole().on('jsdomError', (e) => jsdomErrors.push(e.message));
  const dom = new JSDOM(html, {
    url: 'http://localhost:3000/change-password.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      w.__nav = (u) => nav.push(u);
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      w.fetch = fetchImpl;
      // 真词典：验证 code → 中文这条链路，而不是测一个恒返回的桩
      w.errText = (input, fallback) => {
        const code = typeof input === 'string' ? input : input && input.code;
        return code === 'E_BAD_CREDENTIALS'
          ? '账号或密码不正确'
          : code
            ? '错误码 ' + code
            : fallback || '保存失败';
      };
    },
  });
  await new Promise((r) => setTimeout(r, 25));
  const d = dom.window.document;
  return {
    dom,
    nav,
    jsdomErrors,
    fetchCalls,
    d,
    form: d.getElementById('changeForm'),
    btn: d.getElementById('submitBtn'),
    errBox: d.getElementById('error'),
    subText: d.getElementById('subText'),
    cur: d.getElementById('current'),
    next: d.getElementById('next'),
    next2: d.getElementById('next2'),
    err: () => d.getElementById('error').textContent.trim(),
    active: () => d.activeElement && d.activeElement.id,
    submit: () =>
      d
        .getElementById('changeForm')
        .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
  };
}

test('守卫：未登录跳登录页并带 next 回跳地址', async () => {
  const x = await mount({ session: { authenticated: false } });
  assert.deepEqual(x.nav, ['/login.html?next=%2Fchange-password.html']);
  x.dom.window.close();
});

test('守卫：session 请求失败按未登录处理', async () => {
  const x = await mount({
    fetchImpl: async (u) => {
      if (u === '/api/session') throw new Error('network down');
      return { ok: false, json: async () => ({}) };
    },
  });
  assert.deepEqual(x.nav, ['/login.html?next=%2Fchange-password.html']);
  x.dom.window.close();
});

test('守卫：已改过密的人直接回首页，不停留', async () => {
  const x = await mount({
    session: { authenticated: true, mustChangePassword: false, username: 'admin' },
  });
  assert.deepEqual(x.nav, ['/']);
  x.dom.window.close();
});

test('守卫：mustChangePassword 时回填用户名，不跳转', async () => {
  const x = await mount();
  assert.deepEqual(x.nav, []);
  assert.match(x.subText.textContent, /admin/);
  assert.match(x.subText.textContent, /首次登录/);
  x.dom.window.close();
});

test('校验：当前密码为空 → 提示 + 聚焦当前密码框', async () => {
  const x = await mount();
  x.next.value = 'newpass9';
  x.next2.value = 'newpass9';
  x.submit();
  assert.match(x.err(), /初始密码是 Admin2026/);
  assert.equal(x.active(), 'current');
  x.dom.window.close();
});

test('校验：新密码少于 4 位 → 提示 + 聚焦', async () => {
  const x = await mount();
  x.cur.value = 'Admin2026';
  x.next.value = 'abc';
  x.next2.value = 'abc';
  x.submit();
  assert.match(x.err(), /至少 4 位/);
  assert.equal(x.active(), 'next');
  x.dom.window.close();
});

test('校验：两次新密码不一致 → 提示 + 聚焦确认框', async () => {
  const x = await mount();
  x.cur.value = 'Admin2026';
  x.next.value = 'newpass9';
  x.next2.value = 'other99';
  x.submit();
  assert.match(x.err(), /两次输入的新密码不一致/);
  assert.equal(x.active(), 'next2');
  x.dom.window.close();
});

test('校验：新密码与初始相同 → 拒绝', async () => {
  const x = await mount();
  x.cur.value = 'Admin2026';
  x.next.value = 'Admin2026';
  x.next2.value = 'Admin2026';
  x.submit();
  assert.match(x.err(), /不能与初始密码相同/);
  assert.equal(x.active(), 'next');
  x.dom.window.close();
});

test('提交：校验通过后按契约 POST body，成功后跳首页', async () => {
  const x = await mount();
  x.cur.value = 'Admin2026';
  x.next.value = 'newpass9';
  x.next2.value = 'newpass9';
  x.submit();
  await new Promise((r) => setTimeout(r, 20));
  const account = x.fetchCalls.filter((c) => c.url === '/api/account');
  assert.equal(account.length, 1);
  assert.equal(account[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(account[0].init.body), {
    currentPassword: 'Admin2026',
    newPassword: 'newpass9',
  });
  assert.deepEqual(x.nav, ['/']);
  x.dom.window.close();
});

test('提交：403 错误码转中文，按钮恢复可重试', async () => {
  const x = await mount({ postStatus: 403, postBody: { code: 'E_BAD_CREDENTIALS' } });
  x.cur.value = 'wrong';
  x.next.value = 'newpass9';
  x.next2.value = 'newpass9';
  x.submit();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(x.err(), '账号或密码不正确');
  assert.equal(x.btn.disabled, false);
  assert.equal(x.btn.textContent.trim(), '保存并进入');
  assert.deepEqual(x.nav, []);
  x.dom.window.close();
});

test('提交：15 秒超时显示中文文案，不漏 AbortError 英文', async () => {
  const timeoutErr = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
  const x = await mount({
    fetchImpl: async (u) => {
      if (u === '/api/session')
        return {
          ok: true,
          json: async () => ({ authenticated: true, mustChangePassword: true, username: 'admin' }),
        };
      throw timeoutErr;
    },
  });
  x.cur.value = 'Admin2026';
  x.next.value = 'newpass9';
  x.next2.value = 'newpass9';
  x.submit();
  await new Promise((r) => setTimeout(r, 20));
  assert.match(x.err(), /保存超时（15 秒无响应）/);
  assert.doesNotMatch(x.err(), /abort|TimeoutError/i);
  assert.equal(x.btn.disabled, false);
  x.dom.window.close();
});
