/* 笺川后端纯函数单测（node:test，零依赖零外部服务）。
 *
 * 运行：`npm run test:server`
 *
 * 背景：v2.2.0 之前这些逻辑全埋在 server.js 里，而 server.js 一 require 就
 * listen + 连库，**根本无法被测试触及**。v2.2.0 把它们抽到 lib/ 下的无副作用模块
 * （密钥、站点默认等原本读模块级 settings 的，改为由调用方显式传入），
 * 于是可以在不启服务、不连库的前提下真跑一遍。
 *
 * 覆盖的是「改错一行就出事、但手点测不出来」的部分：
 *   数值夹取边界 / SSRF 拦截 / OPML 正则解析 / 偏好白名单清洗 /
 *   AES-GCM 加解密往返与密钥漂移 / 版本比较 / DTO 的图片代理改写。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { int, bool, clampInt, clampNum, normUrl, compareVersion, isPrivateHost, groupsOf } = require('../../lib/util');
const { parseOpml, parseOpmlAttrs } = require('../../lib/opml');
const {
  APPEARANCE_DEFAULTS, sanitizeAppearance, userAppearance,
  LAYOUT_DEFAULTS, sanitizeLayout, userLayout, clampReaderSide,
  READER_SIDE_MIN, READER_SIDE_MAX, READER_SIDE_DEFAULT,
} = require('../../lib/prefs');
const { proxyBodyJson, toCard, toFeedDto, proxied } = require('../../lib/dto');
const { encryptSecret, decryptSecret, maskSecret, hashPassword, safeEqual, ENC_PREFIX } = require('../../lib/crypto');
const { llmForStore, sanitizeUserLlm, userLlmForStore, userLlmForView, resolveUserLlm } = require('../../lib/llm');

/* ============================================================
 * 数值
 * ============================================================ */
test('int：能解析就取整，不能解析回落默认值', () => {
  assert.equal(int('42', 0), 42);
  assert.equal(int(7.9, 0), 7);          // parseInt 截断小数
  assert.equal(int('-3', 0), -3);
  assert.equal(int('abc', 5), 5);
  assert.equal(int(undefined, 5), 5);
  assert.equal(int(null, 5), 5);
  assert.equal(int('', 5), 5);
});

test('bool：宽松求值，空值回落默认', () => {
  for (const v of [true, '1', 'true', 'yes']) assert.equal(bool(v, false), true, String(v));
  for (const v of [false, '0', 'false', 'no', 'anything']) assert.equal(bool(v, true), false, String(v));
  // undefined / null / '' 一律用默认值 —— 表单里空复选框提交上来就是这个形态
  assert.equal(bool(undefined, true), true);
  assert.equal(bool(null, true), true);
  assert.equal(bool('', false), false);
});

test('clampInt / clampNum：夹到 [lo, hi] 且不因脏值崩掉', () => {
  assert.equal(clampInt('999', 30, 1, 10), 10);
  assert.equal(clampInt('-5', 30, 1, 10), 1);
  assert.equal(clampInt('5', 30, 1, 10), 5);
  assert.equal(clampInt('x', 7, 1, 10), 7);          // 解析失败用默认值，默认值本身也再夹一次
  assert.equal(clampInt('x', 99, 1, 10), 10);        // 默认值超界也要夹住

  assert.equal(clampNum(0.3, 0.3, 0, 1.5), 0.3);
  assert.equal(clampNum(9, 0.3, 0, 1.5), 1.5);
  assert.equal(clampNum(-9, 0.3, 0, 1.5), 0);
  assert.equal(clampNum('nope', 0.3, 0, 1.5), 0.3);
  assert.equal(clampNum(NaN, 0.42, 0, 1.5), 0.42);
  assert.equal(clampNum(Infinity, 0.3, 0, 1.5), 0.3);   // Infinity 非有限 → 回落
});

test('normUrl：去空白并小写，用于去重比较', () => {
  assert.equal(normUrl('  HTTPS://Example.COM/Feed  '), 'https://example.com/feed');
  assert.equal(normUrl(null), '');
  assert.equal(normUrl(undefined), '');
});

/* ============================================================
 * SSRF —— /api/img 图片代理的安全边界
 * ============================================================ */
test('isPrivateHost：拦下内网 / 环回 / 链路本地 / 保留段', () => {
  const blocked = [
    'localhost', 'foo.localhost', 'printer.local', '0.0.0.0',
    '127.0.0.1', '127.1.2.3',            // 整个 127/8
    '10.0.0.1', '10.255.255.254',
    '172.16.0.1', '172.20.10.1', '172.31.255.254',   // 172.16/12
    '192.168.1.1',
    '169.254.169.254',                   // 云元数据，最关键的一条
    '0.1.2.3',                            // 0/8
    '224.0.0.1', '255.255.255.255',       // 多播 / 广播
    '::1', '[::1]',
    'fd00::1', 'fe80::1',                 // IPv6 唯一本地 / 链路本地
  ];
  for (const h of blocked) {
    assert.equal(isPrivateHost(h), true, '应拦下: ' + h);
  }
});

test('isPrivateHost：放行公网地址', () => {
  const allowed = [
    'example.com', 'www.example.com', 'cdn.jsdelivr.net',
    '8.8.8.8', '1.1.1.1',
    '11.0.0.1',                          // 11.x 不在私有段
    '172.15.0.1', '172.32.0.1',          // 172.16/12 之外
    '192.169.1.1',                       // 192.168 之外
    '169.253.1.1',                       // 169.254 之外
    '223.255.255.255',                   // 224 以下
  ];
  for (const h of allowed) {
    assert.equal(isPrivateHost(h), false, '应放行: ' + h);
  }
});

test('isPrivateHost：大小写不敏感 + 空值安全', () => {
  assert.equal(isPrivateHost('LOCALHOST'), true);
  assert.equal(isPrivateHost('LocalHost'), true);
  assert.equal(isPrivateHost('127.0.0.1'), true);
  assert.equal(isPrivateHost(''), false);
  assert.equal(isPrivateHost(null), false);
});

/* ============================================================
 * 版本比较
 * ============================================================ */
test('compareVersion：逐段数值比较，忽略 v 前缀', () => {
  assert.equal(compareVersion('2.1.0', '2.0.0'), 1);
  assert.equal(compareVersion('2.0.0', '2.1.0'), -1);
  assert.equal(compareVersion('2.0.0', '2.0.0'), 0);
  assert.equal(compareVersion('v2.0.0', '2.0.0'), 0);
  assert.equal(compareVersion('2.0', '2.0.0'), 0);          // 缺段视作 0
  assert.equal(compareVersion('2.0.1', '2.0'), 1);
  assert.equal(compareVersion('10.0.0', '9.9.9'), 1);        // 不是字符串比较
  assert.equal(compareVersion('', '0'), 0);
  assert.equal(compareVersion(null, undefined), 0);
});

/* ============================================================
 * 分组
 * ============================================================ */
test('groupsOf：去重、去空白、按中文排序', () => {
  const got = groupsOf([
    { groupName: '技术' }, { groupName: '技术' },
    { groupName: '  设计  ' }, { groupName: '' }, { groupName: '   ' },
    {}, { groupName: null }, { groupName: '金融' },
  ]);
  assert.deepEqual(got.sort(), ['技术', '设计', '金融'].sort());
  assert.equal(got.length, 3);
  assert.deepEqual(groupsOf([]), []);
  assert.deepEqual(groupsOf(null), []);
});

/* ============================================================
 * OPML 解析
 * ============================================================ */
test('parseOpmlAttrs：抽属性、键小写、忽略单引号写法', () => {
  assert.deepEqual(parseOpmlAttrs(' title="A" xmlUrl="http://x/f.xml" '), {
    title: 'A', xmlurl: 'http://x/f.xml',
  });
  assert.deepEqual(parseOpmlAttrs(''), {});
});

test('parseOpml：平铺订阅，group 为 null', () => {
  const feeds = parseOpml(`<?xml version="1.0"?>
    <opml version="2.0"><head><title>sub</title></head><body>
      <outline type="rss" text="博客" title="某博客" xmlUrl="https://a.com/f.xml"/>
      <outline type="rss" text="只给 text" xmlUrl="https://b.com/f.xml"/>
    </body></opml>`);
  assert.equal(feeds.length, 2);
  assert.equal(feeds[0].url, 'https://a.com/f.xml');
  assert.equal(feeds[0].title, '某博客');     // title 优先于 text
  assert.equal(feeds[0].group, null);
  assert.equal(feeds[1].title, '只给 text'); // text 是 title 的回落
});

test('parseOpml：单层与多层文件夹路径', () => {
  // 注意：有 xmlUrl 的 outline 本身就是订阅源，**不是**它自己的文件夹。
  // 所以「前端」这条订阅的 group 只有它外层的「技术」；「Go」在「后端」里，故为两层。
  const feeds = parseOpml(`<opml><body>
    <outline title="技术">
      <outline title="前端" xmlUrl="https://t.com/a.xml"/>
      <outline title="后端">
        <outline title="Go" xmlUrl="https://t.com/b.xml"/>
      </outline>
    </outline>
    <outline xmlUrl="https://root.com/c.xml"/>
  </body></opml>`);
  const byUrl = Object.fromEntries(feeds.map((f) => [f.url, f.group]));
  assert.equal(byUrl['https://t.com/a.xml'], '技术');
  assert.equal(byUrl['https://t.com/b.xml'], '技术 / 后端');
  assert.equal(byUrl['https://root.com/c.xml'], null);   // 文件夹弹栈后不残留
});

test('parseOpml：空文件夹（自闭合）不污染后续订阅', () => {
  const feeds = parseOpml(`<opml><body>
    <outline title="空文件夹"/>
    <outline xmlUrl="https://x.com/f.xml"/>
  </body></opml>`);
  assert.equal(feeds.length, 1);
  assert.equal(feeds[0].group, null);
});

test('parseOpml：url 是 xmlUrl 的别名；无属性的 outline 忽略', () => {
  const feeds = parseOpml(`<opml><body>
    <outline url="https://u.com/f.xml"/>
    <outline/>
    <outline title="有标题但没链接"/>
  </body></opml>`);
  assert.equal(feeds.length, 1);
  assert.equal(feeds[0].url, 'https://u.com/f.xml');
});

test('parseOpml：脏输入不抛异常', () => {
  for (const bad of ['', 'not xml at all', '<opml><body><outline title="x"', '<<<>>']) {
    assert.ok(Array.isArray(parseOpml(bad)));
  }
  assert.deepEqual(parseOpml(''), []);
});

/* ============================================================
 * 外观 / 布局偏好清洗（不可信输入）
 * ============================================================ */
test('sanitizeAppearance：白名单过滤，非法值回落默认', () => {
  assert.deepEqual(sanitizeAppearance(undefined), APPEARANCE_DEFAULTS);
  assert.deepEqual(sanitizeAppearance({}), APPEARANCE_DEFAULTS);
  assert.deepEqual(sanitizeAppearance('not an object'), APPEARANCE_DEFAULTS);

  const got = sanitizeAppearance({ theme: 'github', accent: 'teal', fontSize: 'l' });
  assert.equal(got.theme, 'github');
  assert.equal(got.accent, 'teal');
  assert.equal(got.fontSize, 'l');
});

test('sanitizeAppearance：越权键被丢弃、非法值被回落', () => {
  const got = sanitizeAppearance({
    theme: 'neon',            // 不在白名单 → 默认
    accent: '__proto__',      // 经典原型污染尝试
    fontSize: 'xxl',
    evil: 'x',                // 不认识的键整个丢掉
    __proto__: { polluted: true },
  });
  assert.equal(got.theme, APPEARANCE_DEFAULTS.theme);
  assert.equal(got.accent, APPEARANCE_DEFAULTS.accent);
  assert.equal(got.fontSize, APPEARANCE_DEFAULTS.fontSize);
  assert.equal('evil' in got, false);
  assert.equal({}.polluted, undefined);       // 没污染 Object.prototype
});

test('userAppearance：从 user.prefs 取，缺路径安全', () => {
  assert.deepEqual(userAppearance(null), APPEARANCE_DEFAULTS);
  assert.deepEqual(userAppearance({}), APPEARANCE_DEFAULTS);
  assert.deepEqual(userAppearance({ prefs: null }), APPEARANCE_DEFAULTS);
  assert.equal(userAppearance({ prefs: { appearance: { theme: 'dark' } } }).theme, 'dark');
});

test('sanitizeLayout：枚举字段白名单', () => {
  assert.deepEqual(sanitizeLayout(undefined), LAYOUT_DEFAULTS);
  const got = sanitizeLayout({
    view: 'list', tab: 'cards', aiPage: 'settings',
    sort: 'old', rdScope: 'unread',
  });
  assert.equal(got.view, 'list');
  assert.equal(got.tab, 'cards');
  assert.equal(got.aiPage, 'settings');
  assert.equal(got.sort, 'old');
  assert.equal(got.rdScope, 'unread');

  const bad = sanitizeLayout({ view: 'grid-3col', tab: 'evil' });
  assert.equal(bad.view, LAYOUT_DEFAULTS.view);
  assert.equal(bad.tab, LAYOUT_DEFAULTS.tab);
});

test('sanitizeLayout：accordion 只有显式 false 才关', () => {
  assert.equal(sanitizeLayout({ accordion: false }).accordion, false);
  // undefined / 'false' 字符串 / 0 都**不**该把用户已开的设置关掉
  assert.equal(sanitizeLayout({}).accordion, true);
  assert.equal(sanitizeLayout({ accordion: undefined }).accordion, true);
  assert.equal(sanitizeLayout({ accordion: 'false' }).accordion, true);
  assert.equal(sanitizeLayout({ accordion: 0 }).accordion, true);
});

test('sanitizeLayout：collapsedGroups 只留字符串且截断到 40 字符', () => {
  const long = 'g'.repeat(200);
  const got = sanitizeLayout({ collapsedGroups: ['甲组', 123, null, long, { a: 1 }] });
  assert.equal(got.collapsedGroups.length, 2);
  assert.equal(got.collapsedGroups[0], '甲组');
  assert.equal(got.collapsedGroups[1].length, 40);
});

test('sanitizeLayout：频道栏折叠与设置面板折叠各存一份，互不牵连', () => {
  const got = sanitizeLayout({ collapsedGroups: ['设置面板'], rdCollapsedGroups: ['频道栏', 7, 'x'.repeat(60)] });
  assert.deepEqual(got.collapsedGroups, ['设置面板']);
  assert.equal(got.rdCollapsedGroups.length, 2);
  assert.equal(got.rdCollapsedGroups[0], '频道栏');
  assert.equal(got.rdCollapsedGroups[1].length, 40);
  // 没传就该回落空数组，而不是把设置面板那份带过来
  assert.deepEqual(sanitizeLayout({ collapsedGroups: ['甲'] }).rdCollapsedGroups, []);
});

test('sanitizeLayout：频道栏宽度收在硬边界内，非法值回落默认', () => {
  assert.equal(sanitizeLayout({ readerSideWidth: 300 }).readerSideWidth, 300);
  assert.equal(sanitizeLayout({ readerSideWidth: '300' }).readerSideWidth, 300);
  assert.equal(sanitizeLayout({ readerSideWidth: 9999 }).readerSideWidth, READER_SIDE_MAX);
  assert.equal(sanitizeLayout({ readerSideWidth: 10 }).readerSideWidth, READER_SIDE_MIN);
  assert.equal(sanitizeLayout({ readerSideWidth: 299.6 }).readerSideWidth, 300);   // 取整
  for (const bad of [undefined, null, 'abc', 0, -5, NaN, {}, []]) {
    assert.equal(sanitizeLayout({ readerSideWidth: bad }).readerSideWidth, READER_SIDE_DEFAULT, String(bad));
  }
  // 自适应上限（40vw）只在渲染时收，持久化值不该因屏幕窄而被改写
  assert.equal(clampReaderSide(400), 400);
});

test('sanitizeLayout：collapsedGroups 不是数组时回落空数组', () => {
  for (const v of ['abc', 123, null, {}]) {
    assert.deepEqual(sanitizeLayout({ collapsedGroups: v }).collapsedGroups, []);
  }
});

test('sanitizeLayout：sections 强制转布尔', () => {
  const got = sanitizeLayout({ sections: { 采集参数: true, 模型: 0, 账号: 'yes', 外观: {} } });
  assert.equal(got.sections['采集参数'], true);
  assert.equal(got.sections['模型'], false);
  assert.equal(got.sections['账号'], false);   // 只有严格 === true 才算开
  assert.equal(got.sections['外观'], false);
  assert.deepEqual(sanitizeLayout({}).sections, {});
  assert.deepEqual(sanitizeLayout({ sections: 'x' }).sections, {});
});

test('userLayout：从 user.prefs 取，缺路径安全', () => {
  assert.deepEqual(userLayout(null), LAYOUT_DEFAULTS);
  assert.deepEqual(userLayout({ prefs: {} }), LAYOUT_DEFAULTS);
  assert.equal(userLayout({ prefs: { layout: { tab: 'ai' } } }).tab, 'ai');
});

/* ============================================================
 * 加密：AES-256-GCM
 * ============================================================ */
const SECRET = 'test-crypto-secret-abc';

test('encryptSecret / decryptSecret：往返一致', () => {
  const plain = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
  const enc = encryptSecret(plain, SECRET);
  assert.ok(enc.startsWith(ENC_PREFIX));
  assert.ok(!enc.includes(plain));            // 密文里绝不能出现明文片段
  assert.equal(decryptSecret(enc, SECRET), plain);
});

test('encryptSecret：空值返回空串，不产生密文', () => {
  for (const v of ['', null, undefined]) assert.equal(encryptSecret(v, SECRET), '');
});

test('decryptSecret：密钥漂移时返回空串（GCM 认证失败）', () => {
  const enc = encryptSecret('my-key-value', SECRET);
  assert.equal(decryptSecret(enc, '另一个密钥'), '');
});

test('decryptSecret：密文被篡改时返回空串', () => {
  const enc = encryptSecret('my-key-value', SECRET);
  const parts = enc.slice(ENC_PREFIX.length).split('.');
  parts[2] = Buffer.from('tampered').toString('base64url');
  assert.equal(decryptSecret(ENC_PREFIX + parts.join('.'), SECRET), '');
});

test('decryptSecret：格式不对一律空串，不抛', () => {
  for (const bad of ['', 'plain-text', ENC_PREFIX, ENC_PREFIX + 'a.b', ENC_PREFIX + 'a.b.c.d', null, undefined]) {
    assert.equal(decryptSecret(bad, SECRET), '', JSON.stringify(bad));
  }
});

test('decryptSecret：每次加密的 iv 都不同（同明文不同密文）', () => {
  const a = encryptSecret('same', SECRET);
  const b = encryptSecret('same', SECRET);
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a, SECRET), 'same');
  assert.equal(decryptSecret(b, SECRET), 'same');
});

test('maskSecret：短值全掩码，长值露头 3 尾 4', () => {
  assert.equal(maskSecret(''), '');
  assert.equal(maskSecret(null), '');
  assert.equal(maskSecret('12345678'), '••••••••');            // ≤8 全掩
  const m = maskSecret('sk-abcdefghijklmnopqrstuvwxyz');
  assert.ok(m.startsWith('sk-'));
  assert.ok(m.endsWith('wxyz'));
  assert.ok(m.includes('•'));
  assert.ok(!m.includes('abcdefghij'));
});

test('hashPassword：同 salt 同结果，不同 salt 不同结果', () => {
  const salt = 'abc123';
  assert.equal(hashPassword('pw', salt), hashPassword('pw', salt));
  assert.notEqual(hashPassword('pw', salt), hashPassword('pw', 'other'));
  assert.notEqual(hashPassword('pw', salt), hashPassword('pw2', salt));
  assert.equal(hashPassword('pw', salt).length, 128);   // 64 字节 hex
});

test('safeEqual：相等为真，长度不等为假，无时序侧信道', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
});

/* ============================================================
 * 模型配置：落库形态 / 前端视图 / 有效配置解析
 * ============================================================ */
test('llmForStore：明文转密文，内存副本不留明文', () => {
  const out = llmForStore({ baseUrl: 'https://api.x.com', model: 'm', apiKey: 'sk-secret' }, SECRET);
  assert.equal(out.apiKey, undefined);
  assert.ok(out.apiKeyEnc.startsWith(ENC_PREFIX));
  assert.equal(decryptSecret(out.apiKeyEnc, SECRET), 'sk-secret');
  assert.equal(out.model, 'm');
});

test('llmForStore：没传明文 Key 时沿用原密文（不误抹）', () => {
  const enc = encryptSecret('keep-me', SECRET);
  const out = llmForStore({ baseUrl: 'u', apiKeyEnc: enc }, SECRET);
  assert.equal(out.apiKeyEnc, enc);
});

test('llmForStore：显式空 apiKeyEnc 表示「清除」', () => {
  const out = llmForStore({ apiKeyEnc: '' }, SECRET);
  assert.equal(out.apiKeyEnc, '');
});

test('sanitizeUserLlm：字段清洗 + temperature 夹取', () => {
  // 非对象输入直接返回空对象（与 v2.2.0 之前的行为一致）：
  // userLlmForStore 会在这之上补 apiKeyEnc，所以这里刻意不填默认值。
  assert.deepEqual(sanitizeUserLlm(null), {});
  assert.deepEqual(sanitizeUserLlm('x'), {});
  const got = sanitizeUserLlm({
    baseUrl: '  https://api.x.com///  ',   // 去空白 + 去尾部斜杠
    model: '  gpt-4o  ',
    temperature: 9,                          // 夹到上界
  });
  assert.equal(got.baseUrl, 'https://api.x.com');
  assert.equal(got.model, 'gpt-4o');
  assert.equal(got.temperature, 1.5);

  const bad = sanitizeUserLlm({ baseUrl: 123, model: {}, temperature: 'x' });
  assert.equal(bad.baseUrl, '');
  assert.equal(bad.model, '');
  assert.equal(bad.temperature, 0.3);
});

test('userLlmForStore：clearApiKey 优先于新 Key', () => {
  const out = userLlmForStore({ apiKey: 'sk-new', clearApiKey: true }, SECRET);
  assert.equal(out.apiKeyEnc, '');
});

test('userLlmForStore：无新 Key 时沿用原密文', () => {
  const enc = encryptSecret('old', SECRET);
  assert.equal(userLlmForStore({ apiKeyEnc: enc }, SECRET).apiKeyEnc, enc);
});

test('userLlmForView：只回「是否设置 + 掩码」，绝不含明文/密文', () => {
  const enc = encryptSecret('sk-abcdefghijklmnop', SECRET);
  const view = userLlmForView({ llm: { baseUrl: 'u', model: 'm', apiKeyEnc: enc } }, SECRET);
  assert.equal(view.apiKeySet, true);
  assert.ok(view.apiKeyHint.includes('•'));
  assert.equal(JSON.stringify(view).includes(ENC_PREFIX), false);
  assert.equal(JSON.stringify(view).includes('sk-abcdefghijklmnop'), false);
  assert.equal(view.apiKeyEnc, undefined);
  assert.equal(view.apiKey, undefined);
});

test('userLlmForView：没配 Key 时 set=false 且 hint 为空', () => {
  const view = userLlmForView(null, SECRET);
  assert.equal(view.apiKeySet, false);
  assert.equal(view.apiKeyHint, '');
  assert.equal(view.temperature, 0.3);
});

test('resolveUserLlm：用户配置优先，未配回退站点默认', () => {
  const site = { baseUrl: 'https://site', model: 'site-m', temperature: 0.7, apiKey: 'site-key' };
  // 全都用站点的
  assert.deepEqual(resolveUserLlm(null, site, SECRET), {
    baseUrl: 'https://site', model: 'site-m', temperature: 0.7, apiKey: 'site-key',
  });
  // 用户配了 baseUrl / model，但没配 Key → 逐字段混用
  const u = { prefs: { llm: { baseUrl: 'https://user', model: 'user-m' } } };
  const got = resolveUserLlm(u, site, SECRET);
  assert.equal(got.baseUrl, 'https://user');
  assert.equal(got.model, 'user-m');
  assert.equal(got.temperature, 0.7);
  assert.equal(got.apiKey, 'site-key');
});

test('resolveUserLlm：用户自己的 Key 解密后生效', () => {
  const enc = encryptSecret('user-key', SECRET);
  const u = { prefs: { llm: { apiKeyEnc: enc, temperature: 0.1 } } };
  const got = resolveUserLlm(u, { apiKey: 'site-key' }, SECRET);
  assert.equal(got.apiKey, 'user-key');
  assert.equal(got.temperature, 0.1);
});

test('resolveUserLlm：用户密文解不开时回退站点 Key（不返回空）', () => {
  const enc = encryptSecret('user-key', 'wrong-secret');   // 用别的密钥加的
  const got = resolveUserLlm({ prefs: { llm: { apiKeyEnc: enc } } }, { apiKey: 'site-key' }, SECRET);
  assert.equal(got.apiKey, 'site-key');
});

test('resolveUserLlm：全空时给安全默认', () => {
  assert.deepEqual(resolveUserLlm(null, null, SECRET), {
    baseUrl: '', model: '', temperature: 0.3, apiKey: '',
  });
});

/* ============================================================
 * DTO：图片代理改写是这里最要紧的约定
 * ============================================================ */
test('proxied：外链图片统一改写成本站代理', () => {
  assert.equal(proxied('https://cdn.x.com/a.png'), '/api/img?u=' + encodeURIComponent('https://cdn.x.com/a.png'));
});

test('proxyBodyJson：图片块 src 改写，非图片块与未改动的保持原样', () => {
  const blocks = [
    { t: 'text', v: 'hello' },
    { t: 'img', src: 'https://cdn.x.com/1.png' },
    { t: 'img', src: 'http://cdn.x.com/2.png' },
    { t: 'img', src: '/local/3.png' },      // 已是本站路径，不动
  ];
  const out = JSON.parse(proxyBodyJson(JSON.stringify(blocks)));
  assert.equal(out[0].v, 'hello');
  assert.equal(out[1].src, '/api/img?u=' + encodeURIComponent('https://cdn.x.com/1.png'));
  assert.equal(out[2].src, '/api/img?u=' + encodeURIComponent('http://cdn.x.com/2.png'));
  assert.equal(out[3].src, '/local/3.png');
});

test('proxyBodyJson：无改动时原样返回同一字符串（不做无谓往返）', () => {
  const untouched = JSON.stringify([{ t: 'text', v: 'hi' }]);
  assert.equal(proxyBodyJson(untouched), untouched);
  // 非数组 / 解析失败 → 原样
  assert.equal(proxyBodyJson('{"a":1}'), '{"a":1}');
  assert.equal(proxyBodyJson('not json'), 'not json');
  assert.equal(proxyBodyJson(null), null);
  assert.equal(proxyBodyJson(undefined), null);
});

test('toCard：外链图片全部走代理，布尔字段强制化', () => {
  const row = {
    id: 7, feed_id: 3, title: '标题', feed_name: '某频道',
    image: 'https://cdn.x.com/cover.png',
    images: ['https://cdn.x.com/1.png', 'https://cdn.x.com/2.png'],
    body_json: JSON.stringify([{ t: 'img', src: 'https://cdn.x.com/inline.png' }]),
    is_read: 1, is_favorite: 0,
    published_at: new Date('2026-01-02T03:04:05Z'),
  };
  const c = toCard(row);
  assert.equal(c.id, '7');                      // id 一律字符串
  assert.equal(c.feedId, '3');
  assert.equal(c.image, '/api/img?u=' + encodeURIComponent(row.image));
  assert.equal(c.images.length, 2);
  assert.ok(c.images.every((u) => u.startsWith('/api/img?u=')));
  assert.equal(JSON.parse(c.bodyJson)[0].src, '/api/img?u=' + encodeURIComponent('https://cdn.x.com/inline.png'));
  assert.equal(c.isRead, true);
  assert.equal(c.isFavorite, false);
  assert.equal(c.date, '2026-01-02T03:04:05.000Z');
});

test('toCard：缺字段时的默认值不会崩', () => {
  const c = toCard({ id: 1, feed_id: 2, title: 'x' });
  assert.equal(c.desc, '');
  assert.equal(c.size, '');
  assert.deepEqual(c.tags, []);
  assert.deepEqual(c.links, []);
  assert.equal(c.link, null);
  assert.equal(c.image, null);
  assert.deepEqual(c.images, []);
  assert.equal(c.bodyJson, null);
  assert.equal(c.sourceUrl, null);
  assert.equal(c.date, null);
  assert.equal(c.favoritedAt, null);
  assert.equal(c.isRead, false);
});

test('toFeedDto：own 频率优先，null 表示跟随全局', () => {
  const base = { id: 1, url: 'u', title: 'T' };
  // 自己设了 720 分钟
  const own = toFeedDto({ ...base, refresh_minutes: 720, last_fetched_at: new Date('2026-01-01T00:00:00Z') }, 30);
  assert.equal(own.refreshMinutes, 720);
  assert.equal(own.effectiveRefreshMinutes, 720);
  assert.equal(own.nextRefreshAt, new Date(Date.parse('2026-01-01T00:00:00Z') + 720 * 60000).toISOString());

  // 没设 → 跟随全局 30
  const glob = toFeedDto({ ...base, refresh_minutes: null }, 30);
  assert.equal(glob.refreshMinutes, null);
  assert.equal(glob.effectiveRefreshMinutes, 30);

  // 非法值（0 / 负数 / 非数字）也当作「跟随全局」
  for (const v of [0, -5, 'abc']) {
    assert.equal(toFeedDto({ ...base, refresh_minutes: v }, 45).refreshMinutes, null);
    assert.equal(toFeedDto({ ...base, refresh_minutes: v }, 45).effectiveRefreshMinutes, 45);
  }
});

test('toFeedDto：全局间隔缺失/为 0 时兜底 30', () => {
  const d = toFeedDto({ id: 1, url: 'u', title: 'T' }, undefined);
  assert.equal(d.effectiveRefreshMinutes, 30);
});

test('toFeedDto：两个开关独立 + 图标走代理', () => {
  const d = toFeedDto({
    id: 5, url: 'https://a.com/f.xml', title: '', custom_title: '我的标题',
    enabled: 1, card_enabled: 0, icon_url: 'https://a.com/icon.png',
    entry_count: '10', unread_count: 3, sort_order: '2',
  }, 30);
  assert.equal(d.title, 'https://a.com/f.xml');       // title 空时回落 url
  assert.equal(d.customTitle, '我的标题');
  assert.equal(d.enabled, true);
  assert.equal(d.cardEnabled, false);                  // 采集开着但卡片页不展示
  assert.equal(d.icon, '/api/img?u=' + encodeURIComponent('https://a.com/icon.png'));
  assert.equal(d.entryCount, 10);
  assert.equal(d.unreadCount, 3);
  assert.equal(d.sortOrder, 2);
});

test('toFeedDto：data: 内嵌图标原样返回，不走代理（v2.2.5 修复 400）', () => {
  const d = toFeedDto({ id: 1, url: 'u', title: 'T', icon_url: 'data:image/svg+xml;base64,PHN2Zy8+' }, 30);
  assert.equal(d.icon, 'data:image/svg+xml;base64,PHN2Zy8+');
});

test('toFeedDto：重复协议头归一化为单协议（v2.2.5 修复 504）', () => {
  const d = toFeedDto({ id: 1, url: 'u', title: 'T', icon_url: 'https:https://cdn.v2ex.com/navatar/x.png' }, 30);
  assert.equal(d.icon, '/api/img?u=' + encodeURIComponent('https://cdn.v2ex.com/navatar/x.png'));
});

test('toFeedDto：无图标时为 null', () => {
  const d = toFeedDto({ id: 1, url: 'u', title: 'T' }, 30);
  assert.equal(d.icon, null);
});

test('toFeedDto：从未抓取过时 nextRefreshAt 为 null（而不是 epoch）', () => {
  const d = toFeedDto({ id: 1, url: 'u', title: 'T', last_fetched_at: null }, 30);
  assert.equal(d.nextRefreshAt, null);
  assert.equal(d.lastFetchedAt, null);
  assert.equal(d.status, null);
  assert.equal(d.error, null);
});

test('toFeedDto：failStreak 透传，缺列为 0（v2.5.0 自动停用计数）', () => {
  const none = toFeedDto({ id: 1, url: 'u', title: 'T' }, 30);
  assert.equal(none.failStreak, 0);
  const some = toFeedDto({ id: 1, url: 'u', title: 'T', fail_streak: 3 }, 30);
  assert.equal(some.failStreak, 3);
  // 脏值（老库里可能是 NULL / 字符串）不能把数字字段污染成 NaN
  const dirty = toFeedDto({ id: 1, url: 'u', title: 'T', fail_streak: null }, 30);
  assert.equal(dirty.failStreak, 0);
});
