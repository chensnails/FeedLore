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
  DIGEST_PROMPT_MAX, DIGEST_DEFAULTS, DIGEST_FEEDS_MAX,
  sanitizeDigestTime, sanitizeDigest, userDigest, userDigestPrompt,
} = require('../../lib/prefs');
const { proxyBodyJson, toCard, toFeedDto, proxied } = require('../../lib/dto');
const { encryptSecret, decryptSecret, maskSecret, hashPassword, safeEqual, ENC_PREFIX } = require('../../lib/crypto');
const { sanitizeUserLlm, userLlmForStore, userLlmForView, userLlm, llmComplete, thinkingBudget } = require('../../lib/llm');

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
    view: 'list', tab: 'cards',
    sort: 'old', rdScope: 'unread',
  });
  assert.equal(got.view, 'list');
  assert.equal(got.tab, 'cards');
  assert.equal(got.sort, 'old');
  assert.equal(got.rdScope, 'unread');

  const bad = sanitizeLayout({ view: 'grid-3col', tab: 'evil' });
  assert.equal(bad.view, LAYOUT_DEFAULTS.view);
  assert.equal(bad.tab, LAYOUT_DEFAULTS.tab);
});

test('sanitizeLayout：aiPage 随二级导航一起退场（不再接受也不输出）', () => {
  assert.equal(Object.prototype.hasOwnProperty.call(LAYOUT_DEFAULTS, 'aiPage'), false);
  const got = sanitizeLayout({ aiPage: 'settings' });
  assert.equal(got.aiPage, undefined);
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

test('sanitizeLayout：digestEnabled 只有显式 false 才关（与 accordion 同一口径）', () => {
  assert.equal(sanitizeLayout({ digestEnabled: false }).digestEnabled, false);
  assert.equal(sanitizeLayout({ digestEnabled: true }).digestEnabled, true);
  // 脏值不该把用户的日报关掉：'false' / 0 / null 一律算「没关」
  for (const v of [undefined, null, 'false', 0, '']) {
    assert.equal(sanitizeLayout({ digestEnabled: v }).digestEnabled, true, String(v));
  }
  // 整组缺失走默认 —— 老账号升级后默认仍有入口
  assert.equal(LAYOUT_DEFAULTS.digestEnabled, true);
  assert.deepEqual(sanitizeLayout(undefined), LAYOUT_DEFAULTS);
  assert.equal(userLayout({ prefs: {} }).digestEnabled, true);
});

test('sanitizeDigest：风格要求换行归一、剔控制字符、截到上限，非字符串当没写', () => {
  const NUL = String.fromCharCode(0);
  const ESC = String.fromCharCode(27);
  const style = (v) => sanitizeDigest({ style: v }).style;
  assert.equal(style('侧重新版影视\r\n别用「抓手」'), '侧重新版影视\n别用「抓手」');
  assert.equal(style('  两边空白收掉  '), '两边空白收掉');
  assert.equal(style('a\tb'), 'a\tb');            // 制表符是排版用的，留着
  assert.equal(style('a' + NUL + ESC + 'b'), 'ab');
  assert.equal(style('x'.repeat(DIGEST_PROMPT_MAX + 500)).length, DIGEST_PROMPT_MAX);
  for (const bad of [undefined, null, 42, true, {}, []]) {
    assert.equal(style(bad), '', String(bad));
  }
  assert.equal(style('   \n  '), '');
});

test('sanitizeDigest：默认值 + 自动生成分默认关（不自动烧额度）', () => {
  assert.deepEqual(sanitizeDigest(undefined), Object.assign({}, DIGEST_DEFAULTS, { feeds: [] }));
  assert.equal(DIGEST_DEFAULTS.auto, false);
  // 与 layout.digestEnabled 默认 true 相反：一个是「用不用日报」，一个是「到点自己跑不跑」
  assert.equal(LAYOUT_DEFAULTS.digestEnabled, true);
  assert.equal(sanitizeDigest({}).auto, false);
  assert.equal(sanitizeDigest({ auto: 'yes' }).auto, false);   // 只认严格 true
  assert.equal(sanitizeDigest({ auto: true }).auto, true);
});

test('sanitizeDigest：时间格式白名单，脏值回落默认', () => {
  assert.equal(sanitizeDigestTime('07:30'), '07:30');
  assert.equal(sanitizeDigestTime('23:59'), '23:59');
  for (const bad of ['24:00', '8:00', '07:60', 'abc', '', null, 7, '07-30']) {
    assert.equal(sanitizeDigestTime(bad), DIGEST_DEFAULTS.time, String(bad));
  }
  assert.equal(sanitizeDigest({ time: '乱写的' }).time, '08:00');
});

test('sanitizeDigest：范围模式与频道清单（去重、正整数、只留 custom 之外的空清单）', () => {
  assert.equal(sanitizeDigest({ mode: 'all' }).mode, 'all');
  assert.equal(sanitizeDigest({ mode: 'nonsense' }).mode, DIGEST_DEFAULTS.mode);
  const d = sanitizeDigest({ mode: 'custom', feeds: ['3', 3, 5, -1, 0, null, 'x', 7] });
  assert.deepEqual(d.feeds, [3, 5, 7]);
  assert.deepEqual(sanitizeDigest({ mode: 'all', feeds: [1] }).feeds.length, 1); // 清洗只管形状，是否清空由调用方按模式决定
  assert.deepEqual(sanitizeDigest({ feeds: 'not-an-array' }).feeds, []);
  const many = sanitizeDigest({ mode: 'custom', feeds: Array.from({ length: DIGEST_FEEDS_MAX + 60 }, (_, i) => i + 1) });
  assert.equal(many.feeds.length, DIGEST_FEEDS_MAX);
});

test('sanitizeDigest：条数与保留越界夹回区间', () => {
  const d = sanitizeDigest({ maxPerFeed: 9999, maxTotal: 9999, keepDays: 9999 });
  assert.equal(d.maxPerFeed, 100);
  assert.equal(d.maxTotal, 500);
  assert.equal(d.keepDays, 365);
  const low = sanitizeDigest({ maxPerFeed: 0, maxTotal: 1, keepDays: 0 });
  assert.equal(low.maxPerFeed, 1);
  assert.equal(low.maxTotal, 10);
  assert.equal(low.keepDays, 1);
  assert.equal(sanitizeDigest({ maxPerFeed: 'abc' }).maxPerFeed, 20);
});

test('sanitizeDigest：lastAuto 只认 YYYY-MM-DD（调度器独占字段）', () => {
  assert.equal(sanitizeDigest({ lastAuto: '2026-10-26' }).lastAuto, '2026-10-26');
  assert.equal(sanitizeDigest({ lastAuto: '今天' }).lastAuto, '');
  assert.equal(sanitizeDigest({ lastAuto: 20261026 }).lastAuto, '');
});

test('userDigest：从 user.prefs 取，缺路径安全；老库顶层 digestPrompt 兼容读进 style', () => {
  assert.deepEqual(userDigest(null), Object.assign({}, DIGEST_DEFAULTS, { feeds: [] }));
  assert.deepEqual(userDigest({ prefs: {} }), Object.assign({}, DIGEST_DEFAULTS, { feeds: [] }));
  assert.equal(userDigest({ prefs: { digest: { style: '只要音乐' } } }).style, '只要音乐');
  assert.equal(userDigestPrompt({ prefs: { digest: { style: '走 prefs.digest' } } }), '走 prefs.digest');
  // 升级前的账号：风格还存在顶层 digestPrompt，读得到就不用重填
  assert.equal(userDigestPrompt({ prefs: { digestPrompt: '只要音乐' } }), '只要音乐');
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

test('userLlm：只认这个账号自己那份，没有站点兜底', () => {
  const enc = encryptSecret('user-key', SECRET);
  const u = { prefs: { llm: { baseUrl: 'https://user', model: 'user-m', temperature: 0.1, apiKeyEnc: enc } } };
  assert.deepEqual(userLlm(u, SECRET), {
    baseUrl: 'https://user', model: 'user-m', temperature: 0.1, apiKey: 'user-key',
    thinking: false, thinkingDepth: 'medium', thinkingBudget: 2048,
  });
});

test('userLlm：全空时给安全默认（空地址空 Key，交给 llmComplete 判）', () => {
  assert.deepEqual(userLlm(null, SECRET), {
    baseUrl: '', model: '', temperature: 0.3, apiKey: '',
    thinking: false, thinkingDepth: 'medium', thinkingBudget: 2048,
  });
  assert.deepEqual(userLlm({ prefs: {} }, SECRET).baseUrl, '');
});

test('userLlm：密文解不开时给空串，不再悄悄用别人的 Key', () => {
  const enc = encryptSecret('user-key', 'wrong-secret');   // 用别的密钥加的
  assert.equal(userLlm({ prefs: { llm: { apiKeyEnc: enc } } }, SECRET).apiKey, '');
});

test('llmComplete：地址 / Key / 模型名三项齐了才算配好', () => {
  const full = { baseUrl: 'https://x/v1', apiKey: 'sk-1', model: 'm' };
  assert.equal(llmComplete(full), true);
  assert.equal(llmComplete(Object.assign({}, full, { apiKey: '' })), false);
  assert.equal(llmComplete(Object.assign({}, full, { baseUrl: '' })), false);
  assert.equal(llmComplete(Object.assign({}, full, { model: '' })), false);
  assert.equal(llmComplete(null), false);
  assert.equal(llmComplete({}), false);
});

/* ---------- 思考模式：档位 → 预算，以及「谁说了算」 ---------- */

test('thinkingBudget：三档各有预算，未知档位回落中档', () => {
  assert.equal(thinkingBudget('low'), 512);
  assert.equal(thinkingBudget('medium'), 2048);
  assert.equal(thinkingBudget('high'), 8192);
  for (const bad of ['ultra', '', null, undefined, 0, { toString() { return 'low'; } }]) {
    assert.equal(thinkingBudget(bad), 2048, String(bad));
  }
});

test('sanitizeUserLlm：思考两项只在显式提交时落键（不写死默认，未提交才算「没表过态」）', () => {
  assert.equal('thinking' in sanitizeUserLlm({ baseUrl: 'https://x', model: 'm' }), false);
  assert.equal('thinkingDepth' in sanitizeUserLlm({ baseUrl: 'https://x', model: 'm' }), false);
  assert.deepEqual(sanitizeUserLlm({ thinking: false }), {
    baseUrl: '', model: '', temperature: 0.3, thinking: false,
  });
  assert.deepEqual(sanitizeUserLlm({ thinking: true, thinkingDepth: 'high' }).thinkingDepth, 'high');
  // 字符串 'true' / 越界档位一律不当真
  assert.equal('thinking' in sanitizeUserLlm({ thinking: 'true' }), false);
  assert.equal('thinkingDepth' in sanitizeUserLlm({ thinkingDepth: 'very-deep' }), false);
});

test('userLlm：思考只看账号自己（只填档位不该自动开思考）', () => {
  const on = userLlm({ prefs: { llm: { thinking: true, thinkingDepth: 'high' } } }, SECRET);
  assert.equal(on.thinking, true);
  assert.equal(on.thinkingDepth, 'high');
  assert.equal(on.thinkingBudget, 8192);
  const off = userLlm({ prefs: { llm: { thinking: false, thinkingDepth: 'low' } } }, SECRET);
  assert.equal(off.thinking, false);
  // 关着也把档位照实解析出来：日志与「档位 → 预算」映射要能对上
  assert.equal(off.thinkingDepth, 'low');
  assert.equal(off.thinkingBudget, 512);
  const depthOnly = userLlm({ prefs: { llm: { thinkingDepth: 'high' } } }, SECRET);
  assert.equal(depthOnly.thinking, false);
  // 脏档位回落中档，不会把预算做成 undefined
  assert.equal(userLlm({ prefs: { llm: { thinking: true, thinkingDepth: 'ultra' } } }, SECRET).thinkingBudget, 2048);
});

test('userLlmForView：思考字段给前端可读形态（缺省 = 关 + 中档）', () => {
  const bare = userLlmForView({}, SECRET);
  assert.equal(bare.thinking, false);
  assert.equal(bare.thinkingDepth, 'medium');
  const on = userLlmForView({ llm: { thinking: true, thinkingDepth: 'nonsense' } }, SECRET);
  assert.equal(on.thinking, true);
  assert.equal(on.thinkingDepth, 'medium');
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

/* ============================================================
 * 日报出站请求（digest.js：思考下发 + 风格附加段）
 *
 * 这两件事都只有「真的发出去那一次」才看得出对错：提示词拼错一个字、
 * chat_template_kwargs 少一层，页面上一切正常，日报只是悄悄变笨或变慢。
 * 所以这里桩掉 fetch，按 generate() 的真实调用链跑，断言请求体本身。
 * ============================================================ */
const createDigest = require('../../digest');

const mkRows = (n) => Array.from({ length: n }, (_, i) => ({
  id: i + 1,
  feed_id: 7,
  feed_name: '测试频道',
  title: '条目 ' + (i + 1),
  description: '描述 ' + (i + 1),
  link: 'https://example.com/' + (i + 1),
  published_at: new Date(Date.now() - i * 1000).toISOString(),
}));

/** 跑一次 generate，返回模型侧收到的每个请求体。map 阶段按「批内编号」识别。
 *  限额由调用方经 limits 传入（v1.4.0 起日报不再有站点级配置，digest.js 只吃参数）。 */
async function captureDigest({ rows = 3, llm, style, limits } = {}) {
  const bodies = [];
  const db = {
    entriesSince: async () => mkRows(rows),
    readDigest: async () => null,
    saveDigest: async () => {},
    pruneDigests: async () => 0,
  };
  const digest = createDigest({ db, log: () => {} });
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    bodies.push(body);
    const isMap = body.messages[body.messages.length - 1].content.indexOf('批内编号') >= 0;
    const payload = isMap
      ? { summary: '这一批的概括', notable: [{ ref: 1, why: '值得看' }] }
      : { overview: '今天的概览', highlights: [], sections: [] };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    };
  };
  try {
    const out = await digest.generate({ ownerId: 1, feeds: [7], force: true, llm, style, limits });
    return { bodies, out };
  } finally {
    globalThis.fetch = real;
  }
}

const FULL_LLM = { baseUrl: 'https://example.test/v1', apiKey: 'sk-x', model: 'Test/Model' };
// 放开限额：默认每频道 20 条会把造出来的 91 条直接砍没，走不到 map-reduce
const NO_LIMITS = { maxPerFeed: 500, maxTotal: 500, keepDays: 30 };

test('generate：模型配置缺任一项 → 规则降级，错误文案说「模型未配置」', async () => {
  // 缺配置不是崩溃：日报照样出（规则摘要），但绝不拿别人的 Key 去跑
  const db = {
    entriesSince: async () => mkRows(3),
    readDigest: async () => null,
    saveDigest: async () => {},
    pruneDigests: async () => 0,
  };
  const digest = createDigest({ db, log: () => {} });
  let fetched = 0;
  const real = globalThis.fetch;
  globalThis.fetch = async () => { fetched += 1; throw new Error('不该发出请求'); };
  try {
    for (const bad of [undefined, null, {}, Object.assign({}, FULL_LLM, { apiKey: '' })]) {
      const out = await digest.generate({ ownerId: 1, feeds: [7], force: true, llm: bad });
      assert.equal(out.digest.fallback, true, JSON.stringify(bad));
      assert.match(String(out.digest.error), /模型未配置/, JSON.stringify(bad));
    }
    assert.equal(fetched, 0, '配置不齐时一次请求都不该发出去');
  } finally {
    globalThis.fetch = real;
  }
});

test('generate：limits 决定每频道与总条数上限', async () => {
  const perFeed = await captureDigest({ rows: 30, llm: FULL_LLM, limits: { maxPerFeed: 5, maxTotal: 30, keepDays: 30 } });
  assert.equal(perFeed.out.digest.stats.kept, 5, '每频道上限没生效');
  // 上限压到 4 条 → 到不了 map-reduce 的门槛，只发一次请求，正好也能看出清单被截断了
  const total = await captureDigest({
    rows: 30, llm: FULL_LLM, limits: { maxPerFeed: 30, maxTotal: 4, keepDays: 30 },
  });
  assert.equal(total.out.digest.stats.kept, 4, '总上限没生效');
  assert.equal(total.out.digest.stats.collected, 30, 'collected 应是压缩前的采集数');
});

test('generate：不开思考 → 模板指令是 /no_think，且不下发 chat_template_kwargs', async () => {
  const { bodies, out } = await captureDigest({ llm: Object.assign({}, FULL_LLM, { thinking: false }) });
  assert.equal(bodies.length, 1);
  assert.match(bodies[0].messages[0].content, /\/no_think$/);
  assert.equal(bodies[0].chat_template_kwargs, undefined);
  assert.equal(out.digest.fallback, false, '降级成规则摘要说明请求根本没走通');
});

test('generate：开思考 → /think + enable_thinking + 档位预算', async () => {
  const { bodies } = await captureDigest({ llm: Object.assign({}, FULL_LLM, { thinking: true, thinkingBudget: thinkingBudget('high') }) });
  assert.match(bodies[0].messages[0].content, /\/think$/);
  assert.deepEqual(bodies[0].chat_template_kwargs, { enable_thinking: true, thinking_budget: 8192 });
});

test('generate：思考预算按档位折算（轻 512 / 中 2048 / 深 8192）', async () => {
  assert.equal(thinkingBudget('low'), 512);
  assert.equal(thinkingBudget('medium'), 2048);
  assert.equal(thinkingBudget('high'), 8192);
  assert.equal(thinkingBudget('胡写'), 2048);   // 脏档位不能把预算变成 undefined
  const { bodies } = await captureDigest({ llm: Object.assign({}, FULL_LLM, { thinking: true, thinkingBudget: thinkingBudget('low') }) });
  assert.equal(bodies[0].chat_template_kwargs.thinking_budget, 512);
});

test('generate：风格要求只追加在 JSON 骨架之后，骨架本身不动', async () => {
  const { bodies } = await captureDigest({ llm: FULL_LLM, style: '语气随意些，别用「赋能」这类词' });
  const user = bodies[0].messages[1].content;
  assert.ok(user.includes('语气随意些'), '风格要求没进提示词');
  assert.ok(user.includes('额外要求（只影响选材、语气与篇幅'), '缺守卫句');
  // 顺序即契约：风格段必须在「只输出 JSON」之后，否则等于给了模型改写结构的机会
  assert.ok(user.lastIndexOf('语气随意些') > user.lastIndexOf('只输出 JSON'), '风格段抢在骨架前面了');
  assert.ok(user.includes('"highlights"') && user.includes('"sections"'), 'JSON 骨架被改坏');
});

test('generate：没写风格要求时不出现「额外要求」段', async () => {
  const { bodies } = await captureDigest({ llm: FULL_LLM, style: '   ' });
  assert.ok(!bodies[0].messages[1].content.includes('额外要求'));
});

test('generate：走 map-reduce 时长清单的每一批都带上风格要求', async () => {
  // 终稿只能从各批挑出的 notable 里选，选材侧重不在这一轮生效等于白写
  const { bodies } = await captureDigest({ rows: 91, llm: FULL_LLM, style: '侧重新版影视和音乐', limits: NO_LIMITS });
  assert.ok(bodies.length > 1, '91 条应拆批调用，实际 ' + bodies.length + ' 次');
  const miss = bodies.filter((b) => !b.messages[b.messages.length - 1].content.includes('侧重新版影视和音乐'));
  assert.equal(miss.length, 0, miss.length + ' 次调用漏了风格要求');
});


/* ============================================================
 * 安全加固（v1.7.2-test2）
 * 对应《质量与安全测试报告-2026-10-29》S-01 / S-02 / S-05 / S-07。
 * 这几条都是「改错一行就重返漏洞」的地方，所以钉成用例。
 * ============================================================ */
const { HttpError, parseCookies, classifyError, applySecurityHeaders } = require('../../lib/http');
const { assertPublicHost, isBlockedIp, pinnedLookup, undiciVersionMismatch } = require('../../lib/net');

test('parseCookies：非法百分号转义不抛异常（S-01 崩溃根因）', () => {
  // 修复前：decodeURIComponent('%E0%A4%A') 抛 URIError，而它跑在请求 handler 的
  // try 之外 → 未捕获异常 → Node 终止进程，一个未授权请求即可打挂服务。
  const req = { headers: { cookie: 'feedlore_sid=%E0%A4%A' } };
  let out;
  assert.doesNotThrow(() => { out = parseCookies(req); });
  assert.equal(out.feedlore_sid, '%E0%A4%A', '解不开时应保留原文，交给验签判成无效会话');
});

test('parseCookies：正常值解码、空段/无等号段/空键都跳过', () => {
  const req = { headers: { cookie: ' a=1 ; b=%E4%B8%AD ; ;;  =bad; c' } };
  const out = parseCookies(req);
  assert.equal(out.a, '1');
  assert.equal(out.b, '中');
  assert.equal(out[''], undefined, '空键不该进结果');
  assert.equal(out.c, undefined, '没有等号的段不是 cookie');
  assert.deepEqual(parseCookies({ headers: {} }), {});
  assert.deepEqual(parseCookies({}), {});
});

test('classifyError：客户端错误给 4xx，依赖故障给 503，其余 500 且不外泄原文', () => {
  assert.deepEqual(classifyError(new HttpError(400, '请求体不是合法 JSON', 'BAD_JSON')),
    { status: 400, message: '请求体不是合法 JSON', code: 'BAD_JSON' });
  // PG 数据类错误（非法输入语法 / 非法日期 / NUL 字节）→ 400，且不透出 SQL 原文
  const pg = Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), { code: '22021' });
  assert.deepEqual(classifyError(pg), { status: 400, message: '请求参数不合法', code: 'BAD_INPUT' });
  // 库连不上 → 503（而不是 502 / 500），监控能区分「依赖挂了」和「代码炸了」
  const dnsErr = Object.assign(new Error('getaddrinfo ENOTFOUND db'), { code: 'ENOTFOUND' });
  assert.equal(classifyError(dnsErr).status, 503);
  // 未知异常：5xx 只回通用文案，绝不把 message 带出去
  const boom = classifyError(new Error('column entries.owner_id does not exist'));
  assert.equal(boom.status, 500);
  assert.equal(boom.message, '服务器内部错误');
  assert.ok(!boom.message.includes('owner_id'));
  // HttpError(500) 也不外泄
  assert.equal(classifyError(new HttpError(500, 'stack detail')).message, '服务器内部错误');
});

test('isBlockedIp：内网 / 回环 / 链路本地 / CGNAT / IPv6 全拦', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', 'localhost',
    '::1', 'fe80::1', 'fd00::1']) {
    assert.equal(isBlockedIp(ip), true, ip + ' 应判为不可出网');
  }
  for (const ip of ['1.1.1.1', '8.8.8.8', '104.16.0.1', '100.63.0.1',
    // 公网 IPv6 必须放行：早期版本「凡 IPv6 一律拒绝」，
    // 结果 example.com（有 AAAA 记录）被判成内网，46 个订阅集体抓取失败
    '2606:2800:220:1:248:1893:25c8:1946', '2001:db8::1'.replace('db8', '4860')]) {
    assert.equal(isBlockedIp(ip), false, ip + ' 应放行');
  }
});

test('pinnedLookup：三种回调形态都要对，尤其 { all: true } 必须回数组（1.7.3 全站抓取失败根因）', () => {
  // 1.7.3 上线后 48 个 URL 组、94 个订阅全挂，日志只有一句 fetch failed。
  // 真因：undici 解析时带 { all: true }，Node 要求回调给数组，而这里只给了
  // (null, ip, family) → ERR_INVALID_IP_ADDRESS。用桩测不出来（桩不走连接层），
  // 所以把 lookup 本身抽出来钉死。
  const fn = pinnedLookup('93.184.216.34');
  let rows;
  fn('example.com', { all: true }, (err, r) => { assert.equal(err, null); rows = r; });
  assert.deepEqual(rows, [{ address: '93.184.216.34', family: 4 }], '{ all: true } 必须回数组');

  let flat;
  fn('example.com', { family: 4 }, (err, addr, family) => { flat = [err, addr, family]; });
  assert.deepEqual(flat, [null, '93.184.216.34', 4], '普通形态回 (err, address, family)');

  let two;
  fn('example.com', (err, addr, family) => { two = [err, addr, family]; });
  assert.deepEqual(two, [null, '93.184.216.34', 4], '两参调用也要活');

  // IPv6 钉定 family 必须是 6，否则 tls 连接会拿 v4 socket 配 v6 地址
  const v6ip = '2606:2800:220:1:248:1893:25c8:1946';
  let rows6;
  pinnedLookup(v6ip)('example.com', { all: true }, (e, r) => { rows6 = r; });
  assert.deepEqual(rows6, [{ address: v6ip, family: 6 }]);
});

test('undici 依赖必须与 Node 内置同大版本（跨大版本 dispatcher 直接不可用）', () => {
  // dispatcher 是内置 fetch 的扩展点，内置 fetch 用的是 Node 自带那份 undici。
  // 装成 8.x（Node 22 内置 6.x）时每次请求都抛 invalid onRequestStart method，
  // 表现同样是 fetch failed —— 和上面那条一起构成 1.7.3 的故障。
  assert.equal(
    undiciVersionMismatch(),
    false,
    `package.json 的 undici 需锁到与内置 ${process.versions.undici} 相同的大版本`,
  );
});

test('assertPublicHost：内网字面量 / 非法协议直接拒，公网域名放行（S-02）', async () => {
  for (const u of ['http://127.0.0.1:3000/api/health', 'http://localhost/',
    'http://10.0.0.5/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]:8080/']) {
    await assert.rejects(() => assertPublicHost(u), (e) => e instanceof HttpError && e.status === 400, u + ' 应被拒');
  }
  await assert.rejects(() => assertPublicHost('file:///etc/passwd'), (e) => e.status === 400);
  await assert.rejects(() => assertPublicHost('not a url'), (e) => e.status === 400);

  // 域名指向内网 IP 也要拒（防「用域名绕过字面量检查」）
  const pub = await assertPublicHost('https://example.com/feed', {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  assert.equal(pub.host, 'example.com');
  assert.deepEqual(pub.ips, ['93.184.216.34']);

  await assert.rejects(
    () => assertPublicHost('https://evil.example.com/feed', { lookup: async () => [{ address: '127.0.0.1', family: 4 }] }),
    (e) => e.code === 'PRIVATE_HOST',
  );
  // 解析失败（不存在的域名）也是 400，而且文案里不要带底层报错
  await assert.rejects(
    () => assertPublicHost('https://nope.invalid/', { lookup: async () => { throw new Error('ENOTFOUND'); } }),
    (e) => e.status === 400 && e.code === 'DNS_FAIL',
  );
});

test('assertPublicHost：ALLOW_PRIVATE_HOSTS=1 时放行内网（自建 FreshRSS / 本机模型）', async () => {
  const prev = process.env.ALLOW_PRIVATE_HOSTS;
  process.env.ALLOW_PRIVATE_HOSTS = '1';
  try {
    const r = await assertPublicHost('http://127.0.0.1:3000/feed');
    assert.equal(r.host, '127.0.0.1');
  } finally {
    if (prev === undefined) delete process.env.ALLOW_PRIVATE_HOSTS;
    else process.env.ALLOW_PRIVATE_HOSTS = prev;
  }
});

test('applySecurityHeaders：nosniff / 反嵌套 / CSP / Referrer 齐备，https 才加 HSTS（S-07）', () => {
  const mk = () => { const h = {}; return { setHeader: (k, v) => { h[k] = v; }, h }; };
  const plain = mk();
  applySecurityHeaders(plain);
  assert.equal(plain.h['X-Content-Type-Options'], 'nosniff');
  assert.equal(plain.h['X-Frame-Options'], 'DENY');
  assert.equal(plain.h['Referrer-Policy'], 'strict-origin-when-cross-origin');
  assert.match(plain.h['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.match(plain.h['Content-Security-Policy'], /default-src 'self'/);
  assert.equal(plain.h['Strict-Transport-Security'], undefined, 'http 上不该发 HSTS');

  const tls = mk();
  applySecurityHeaders(tls, { https: true });
  assert.match(tls.h['Strict-Transport-Security'], /max-age=\d+/);
});
