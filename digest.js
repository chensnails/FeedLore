'use strict';

/**
 * 每日 AI 摘要模块
 * 采集（从 PostgreSQL 取时间窗内的条目）→ 压缩（去重/限额）→ 生成（OpenAI 兼容接口，超限走 map-reduce）→ 落地（写回 digests 表，幂等）
 */

const WINDOW_MS = 24 * 3600 * 1000;   // 摘要覆盖「过去 24 小时」
const COLLECT_LIMIT = 3000;           // 单次最多取 3000 条
const SINGLE_LIMIT = 90;              // 单轮直出上限，超过走 map-reduce
const CHUNK = 40;                     // map 阶段每批条数
const LLM_TIMEOUT = 180000;

function shanghaiDate(d) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d || new Date());
}

function shortFeed(n) {
  return String(n || '').replace(/\s*-\s*Telegram Channel\s*$/i, '').trim();
}

function clamp(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** 去掉模型回显的「#12」编号前缀 */
function stripRef(s) {
  return String(s || '')
    .replace(/^\s*#*\s*\d+\s*[.、:：)]?\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从模型返回里稳健地取出 JSON */
function extractJson(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型未返回 JSON');
  return JSON.parse(t.slice(start, end + 1));
}

module.exports = function createDigest({ db, getSettings, log = console.log }) {
  /* ---------- 数据库行 → 内部条目结构 ---------- */
  function fromRow(r) {
    return {
      id: String(r.id),
      feedId: String(r.feed_id),
      feedName: r.feed_name || '',
      name: r.title,
      desc: r.description || '',
      size: r.size || '',
      tags: r.tags || [],
      link: r.link || null,
      pwd: r.pwd || null,
      image: r.image ? '/api/img?u=' + encodeURIComponent(r.image) : null,
      sourceUrl: r.source_url || null,
      date: r.published_at ? new Date(r.published_at).toISOString() : null,
    };
  }

  /* ---------- 1. 采集 ---------- */
  async function collect({ ownerId, feeds, sinceMs }) {
    const rows = await db.entriesSince({ ownerId, feedIds: feeds, sinceMs, limit: COLLECT_LIMIT });
    return rows.map(fromRow);
  }

  /* ---------- 2. 压缩 ---------- */
  function compress(entries, maxPerFeed, maxTotal) {
    // 去重：同一链接（忽略提取码参数）/ 同频道同名只留最早出现的一条
    const seenKey = new Set();
    const deduped = [];
    for (const e of entries) {
      const key = (e.link && e.link.replace(/[?&]pwd=[^&]*/i, '')) || (e.feedId + '|' + e.name);
      const norm = key.toLowerCase();
      if (seenKey.has(norm)) continue;
      seenKey.add(norm);
      deduped.push(e);
    }

    const perFeed = new Map();
    const kept = [];
    for (const e of deduped) {
      const n = perFeed.get(e.feedId) || 0;
      if (n >= maxPerFeed) continue;
      perFeed.set(e.feedId, n + 1);
      kept.push(e);
      if (kept.length >= maxTotal) break;
    }
    return kept;
  }

  function toLine(e, i) {
    const parts = [`#${i}`];
    if (e.feedName) parts.push(`[${shortFeed(e.feedName)}]`);
    parts.push(e.name);
    if (e.desc) parts.push(`— ${clamp(e.desc, 80)}`);
    if (e.tags && e.tags.length) parts.push(e.tags.slice(0, 4).map((t) => '#' + t).join(' '));
    if (e.size) parts.push(`(${e.size})`);
    return parts.join(' ');
  }

  function itemOf(e) {
    return {
      name: e.name, link: e.link || null, pwd: e.pwd || null,
      feedName: shortFeed(e.feedName), size: e.size || '', tags: e.tags || [],
      image: e.image || null, date: e.date || null, sourceUrl: e.sourceUrl || null,
    };
  }

  /* ---------- 3. LLM ---------- */
  function llmEndpoint(baseUrl) {
    const base = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('未配置模型地址');
    if (/\/chat\/completions$/i.test(base)) return base;
    if (/\/v\d+$/i.test(base)) return base + '/chat/completions';
    return base + '/v1/chat/completions';
  }

  async function chat(messages, temperature, llmOverride) {
    const cfg = getSettings();
    const llm = llmOverride || cfg.llm;
    const { baseUrl, apiKey, model } = llm || {};
    if (!baseUrl || !apiKey || !model) throw new Error('模型未配置完整（地址 / Key / 模型名）');

    // 显式传入的温度优先；否则用设置里的「温度」，再兜底 0.3
    const configured = llm && llm.temperature;
    const temp = temperature == null
      ? (Number.isFinite(Number(configured)) ? Number(configured) : 0.3)
      : temperature;

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), LLM_TIMEOUT);
    try {
      const resp = await fetch(llmEndpoint(baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({ model, temperature: temp, messages }),
        signal: ctl.signal,
      });
      const text = await resp.text();
      if (!resp.ok) throw new Error(`模型返回 ${resp.status}：${clamp(text, 160)}`);
      let data;
      try { data = JSON.parse(text); } catch (_) { throw new Error('模型响应不是合法 JSON'); }
      const content = data.choices && data.choices[0] && data.choices[0].message
        && data.choices[0].message.content;
      if (!content) throw new Error('模型响应缺少 content');
      return content;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('模型请求超时');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // /no_think 关闭 Qwen3 系列默认开启的思考模式（实测快 10 倍以上），对其它模型无副作用
  const SYSTEM = '你是一名资源情报编辑。用户订阅了若干 RSS / Telegram 频道，你负责把每天的新条目整理成一份中文简报。'
    + '你只输出 JSON，不输出任何解释性文字、不使用 Markdown 代码块。'
    + '注意：条目前的 #编号 仅用于标记引用，你在 comment 和 text 中不要重复输出该编号。 /no_think';

  function buildFinalPrompt(compact, lines, meta) {
    return [
      `以下是过去 24 小时（${meta.range}）来自 ${meta.feedCount} 个频道的 ${compact.length} 条新条目：`,
      '',
      lines.join('\n'),
      '',
      '请整理成一份中文简报，严格按以下 JSON 结构输出：',
      '{',
      '  "overview": "2-3 句话的今日概览，说明更新量、主要内容和值得注意的趋势",',
      '  "highlights": [ { "ref": 条目编号, "text": "为什么值得关注的简短理由" } ],',
      '  "sections": [',
      '    { "title": "分类名", "items": [ { "ref": 条目编号, "comment": "一句话点评，20 字以内" } ] }',
      '  ]',
      '}',
      '要求：',
      '1. sections 按内容主题分类（例如 影视剧集 / 音乐音频 / 软件工具 / 学习资料 / 资讯讨论 / 其他），不要按频道分类；',
      '2. highlights 挑 3-5 条最有价值的，ref 必须是上面出现过的编号；',
      '3. 每个 section 的 items 最多 6 条，只挑真正有价值的，ref 必须是上面出现过的编号；',
      '4. comment 要具体，说明这是什么、适合谁，不要写"值得一看"这类空话；',
      '5. 只输出 JSON。',
    ].join('\n');
  }

  async function singlePass(compact, meta, llm) {
    const lines = compact.map((e, i) => toLine(e, i + 1));
    const content = await chat([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: buildFinalPrompt(compact, lines, meta) },
    ], null, llm);
    return extractJson(content);
  }

  async function mapReduce(compact, meta, llm) {
    const chunks = [];
    for (let i = 0; i < compact.length; i += CHUNK) chunks.push(compact.slice(i, i + CHUNK));

    const mini = [];
    for (const ch of chunks) {
      const lines = ch.map((e, i) => toLine(e, i + 1));
      const content = await chat([
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: [
            `下面是 ${ch.length} 条新条目（编号为批内编号）：`, '',
            lines.join('\n'), '',
            '请输出 JSON：{ "summary": "这一批的 2 句话概括", "notable": [ { "ref": 批内编号, "why": "值得关注的原因，15 字内" } ] }',
            'notable 最多 6 条，只挑真正有价值的。只输出 JSON。',
          ].join('\n'),
        },
      ], null, llm);
      try { mini.push({ base: ch, data: extractJson(content) }); }
      catch (_) { mini.push({ base: ch, data: { summary: '', notable: [] } }); }
    }

    const flat = [];
    const digestLines = [];
    mini.forEach((m, ci) => {
      digestLines.push(`【第 ${ci + 1} 批】${m.data.summary || '(无概括)'}`);
      for (const n of (m.data.notable || [])) {
        const e = m.base[Number(n.ref) - 1];
        if (!e) continue;
        flat.push(e);
        digestLines.push(`#${flat.length} ${toLine(e, '').replace(/^#\s*/, '')} — 关注点：${clamp(n.why, 20)}`);
      }
    });

    if (!flat.length) return singlePass(compact.slice(0, SINGLE_LIMIT), meta, llm);

    const content = await chat([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: buildFinalPrompt(flat, digestLines, meta) },
    ], null, llm);
    return extractJson(content);
  }

  /* ---------- 降级：规则摘要 ---------- */
  function ruleDigest(compact, meta, reason) {
    const byFeed = new Map();
    const tagCount = new Map();
    for (const e of compact) {
      const f = shortFeed(e.feedName) || '未知频道';
      byFeed.set(f, (byFeed.get(f) || 0) + 1);
      for (const t of e.tags || []) tagCount.set(t, (tagCount.get(t) || 0) + 1);
    }
    const topTags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const topFeeds = [...byFeed.entries()].sort((a, b) => b[1] - a[1]);

    const items = compact.slice(0, 24).map((e) => ({ comment: '（规则摘要，未调用模型）', item: itemOf(e) }));
    return {
      overview: `过去 24 小时共采集 ${compact.length} 条更新，覆盖 ${byFeed.size} 个频道。`
        + (topTags.length ? `高频标签：${topTags.slice(0, 6).map(([t]) => t).join('、')}。` : '')
        + `（模型摘要不可用：${reason}）`,
      highlights: topFeeds.slice(0, 3).map(([f, n]) => ({ text: `${f} 更新 ${n} 条` })),
      sections: [
        { title: '频道更新分布', items: topFeeds.slice(0, 6).map(([f, n]) => ({ comment: `${n} 条更新`, item: { name: f, feedName: f, tags: [], size: '' } })) },
        { title: '最新条目', items },
      ],
      fallback: true,
    };
  }

  /* ---------- 主流程 ---------- */
  async function generate({ ownerId, feeds, date, force, llm }) {
    const cfg = getSettings();
    // 用户级 llm 优先；缺字段（未完整配置）则回退站点默认
    const effectiveLlm = (llm && llm.baseUrl && llm.apiKey && llm.model) ? llm : cfg.llm;
    const d = date || shanghaiDate();

    if (!force) {
      const cached = await db.readDigest(ownerId, d);
      if (cached && !cached.fallback) return { digest: cached, cached: true };
    }

    const now = Date.now();
    const sinceMs = now - WINDOW_MS;
    const maxTotal = (cfg.digest && cfg.digest.maxTotal) || 150;
    const maxPerFeed = (cfg.digest && cfg.digest.maxPerFeed) || 20;

    const collected = await collect({ ownerId, feeds, sinceMs });
    const compact = compress(collected, maxPerFeed, maxTotal);

    const meta = {
      range: `${new Date(sinceMs).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} ~ ${new Date(now).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
      feedCount: new Set(compact.map((e) => e.feedId)).size,
    };

    let result;
    let llmError = null;
    if (!compact.length) {
      result = { overview: '过去 24 小时没有采集到新条目。', highlights: [], sections: [], fallback: true };
    } else {
      try {
        result = compact.length > SINGLE_LIMIT
          ? await mapReduce(compact, meta, effectiveLlm)
          : await singlePass(compact, meta, effectiveLlm);
      } catch (e) {
        llmError = String((e && e.message) || e);
        result = ruleDigest(compact, meta, llmError);
      }
    }

    // 把 ref 解析回真实条目
    const pool = compact;
    const resolve = (ref) => {
      const e = pool[Number(ref) - 1];
      return e ? itemOf(e) : null;
    };

    const highlights = (result.highlights || [])
      .map((h) => ({ text: clamp(stripRef(h.text || h.why || ''), 60), item: resolve(h.ref) }))
      .filter((h) => h.item)
      .slice(0, 6);

    const sections = (result.sections || [])
      .map((s) => ({
        title: clamp(stripRef(s.title || '未分类'), 20),
        items: (s.items || [])
          .map((it) => ({ comment: clamp(stripRef(it.comment || ''), 60), item: resolve(it.ref) }))
          .filter((it) => it.item)
          .slice(0, 8),
      }))
      .filter((s) => s.items.length);

    const digest = {
      date: d,
      generatedAt: now,
      windowFrom: sinceMs,
      windowTo: now,
      model: (effectiveLlm && effectiveLlm.model) || '',
      usedMapReduce: compact.length > SINGLE_LIMIT,
      fallback: !!result.fallback,
      error: llmError,
      stats: {
        collected: collected.length,
        kept: compact.length,
        feeds: new Set(compact.map((e) => e.feedId)).size,
      },
      overview: String(result.overview || ''),
      highlights,
      sections,
    };

    await db.saveDigest(ownerId, d, digest, digest.model, digest.fallback);
    await db.pruneDigests(ownerId, (cfg.digest && cfg.digest.keepDays) || 30).catch(() => 0);
    return { digest, cached: false };
  }

  return {
    generate,
    readDigest: (ownerId, date) => db.readDigest(ownerId, date),
    listDigests: (ownerId) => db.listDigestDates(ownerId),
    testLlm: async (llmOverride) => {
      const content = await chat([
        { role: 'system', content: '你是一个测试助手，只输出 JSON。' },
        { role: 'user', content: '输出 {"ok": true, "msg": "连接正常"}' },
      ], 0, llmOverride);
      const j = extractJson(content);
      return { ok: true, reply: j.msg || '连接正常' };
    },
  };
};
