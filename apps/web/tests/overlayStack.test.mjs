/* 弹层栈与浏览器返回键的回归（node --test）
 *
 * 守的是四件事：
 * 1. 第一个弹层打开时压一条历史哨兵，最后一个关闭时把它退回去（历史不留垃圾）；
 * 2. 用户按返回只关栈顶，并且不会顺手把视图切走；
 * 3. 脏态确认选「继续编辑」时这一层必须留下，哨兵补回；
 * 4. 关闭前应用改过 hash（卡片详情「在文章页查看」）时，地址栏纠正回关闭前那一刻。
 *
 * 用假 history / location 直接驱动；每个用例重新加载模块，栈状态互不污染。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

let caseNo = 0;

/** 重新加载模块：哨兵 / expected / 栈都是模块级状态 */
function fresh() {
  return import('../src/ui/overlayStack.js?case=' + (++caseNo));
}

function mountEnv(hash = '#cards') {
  const calls = [];
  // 极简会话历史：push 记一条、back 退回上一条并恢复 hash
  const stack = [hash];
  const loc = { hash, href: 'http://localhost/' + hash };
  globalThis.location = loc;
  globalThis.history = {
    state: null,
    pushState(_state, _title, url) { calls.push('push:' + url); stack.push(loc.hash); },
    replaceState(_state, _title, url) {
      calls.push('replace:' + url);
      const cut = String(url).indexOf('#');
      loc.hash = cut >= 0 ? String(url).slice(cut) : '';
      stack[stack.length - 1] = loc.hash;
    },
    back() {
      calls.push('back');
      if (stack.length > 1) stack.pop();
      loc.hash = stack[stack.length - 1] || '';
    },
  };
  return { calls, loc };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test.afterEach(() => {
  delete globalThis.location;
  delete globalThis.history;
});

test('第一个弹层打开压一条哨兵，最后一个关闭再退回去', async () => {
  const { registerLayer, handleOverlayPop } = await fresh();
  const { calls, loc } = mountEnv();

  const off = registerLayer(() => { throw new Error('正常关闭不该再走 dismiss'); });
  assert.deepEqual(calls, ['push:http://localhost/#cards']);

  // 关闭前应用改过 hash：卡片详情跳到文章页就是这条路径
  loc.hash = '#reader/art/9';
  calls.length = 0;
  off();
  await tick();
  assert.deepEqual(calls, ['back'], '关最后一层要把哨兵退回去');

  // 这一次 pop 是栈自己引起的，必须吞掉（否则视图会被旧 hash 带跑）
  assert.equal(handleOverlayPop(), true);
  assert.ok(calls.indexOf('replace:#reader/art/9') >= 0, '地址栏应纠正回关闭前那一刻');
});

test('关闭后同一帧又开一层：哨兵复用，不白退一趟历史', async () => {
  const { registerLayer } = await fresh();
  const { calls } = mountEnv();
  const off = registerLayer(() => {});
  calls.length = 0;
  off();
  registerLayer(() => {});   // StrictMode 重复挂载 / 关一个立刻开另一个
  await tick();
  assert.deepEqual(calls, [], '新的层还在，历史不该动');
});

test('没有弹层时返回键归视图处理', async () => {
  const { handleOverlayPop } = await fresh();
  mountEnv();
  assert.equal(handleOverlayPop(), false);
});

test('用户按返回只关栈顶，下面那层不动', async () => {
  const { registerLayer, handleOverlayPop } = await fresh();
  const { calls } = mountEnv();
  let a = 0;
  let b = 0;
  registerLayer(() => { a++; });
  const offB = registerLayer(() => { b++; });

  calls.length = 0;
  assert.equal(handleOverlayPop(), true);
  // 下面还有层：返回键这一击落到栈顶后，立刻补一条新哨兵
  assert.deepEqual(calls, ['push:http://localhost/#cards']);
  await tick();
  assert.equal(b, 1);
  assert.equal(a, 0);

  offB();
  assert.equal(handleOverlayPop(), true);
  await tick();
  assert.equal(a, 1);
});

test('脏态确认选「继续编辑」：这一层留下，哨兵补回', async () => {
  const { registerLayer, handleOverlayPop } = await fresh();
  const { calls } = mountEnv();
  registerLayer(() => Promise.resolve(false));

  assert.equal(handleOverlayPop(), true);
  await tick();
  await tick();
  assert.ok(calls.indexOf('push:http://localhost/#cards') >= 0, '保留弹层必须重新压哨兵');
});

test('dismiss 还没返回时连按返回：只补哨兵，不重复关同一层', async () => {
  const { registerLayer, handleOverlayPop } = await fresh();
  mountEnv();
  let calls = 0;
  registerLayer(() => { calls++; return new Promise(() => {}); });

  handleOverlayPop();
  handleOverlayPop();
  await tick();
  assert.equal(calls, 1, '同一层不能被连按两次关两遍');
});

test('用户返回关掉最后一层后不再多退一次历史', async () => {
  const { registerLayer, handleOverlayPop } = await fresh();
  const { calls } = mountEnv();
  const offA = registerLayer(() => {});
  const offB = registerLayer(() => {});

  calls.length = 0;
  assert.equal(handleOverlayPop(), true);
  await tick();
  offB();   // 模拟组件随关闭卸载
  assert.deepEqual(calls, ['push:http://localhost/#cards'], '下面还有层：先补一条新哨兵');

  // 底下那层还开着：再按一次返回照常关它，且不吃历史
  calls.length = 0;
  assert.equal(handleOverlayPop(), true);
  await tick();
  offA();
  assert.deepEqual(calls, []);
});

test('栈里只剩一层时，用户返回关掉它不回退历史', async () => {
  const { registerLayer, handleOverlayPop } = await fresh();
  const { calls } = mountEnv();
  registerLayer(() => {});
  calls.length = 0;
  assert.equal(handleOverlayPop(), true);
  await tick();
  assert.deepEqual(calls, []);
});