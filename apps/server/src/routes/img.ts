/**
 * 图片代理（契约：contract.img.proxy，`GET /api/img?u=<外链>`）。
 *
 * 为什么必须有它：
 *  1. **防盗链** —— 源站按 Referer 拦直连，卡片封面全白；
 *  2. **混合内容** —— https 页面里的 http 图会被浏览器直接拦掉；
 *  3. **签名过期** —— 部分 CDN 的地址带短时效 token，原文里的链接过几小时就 404。
 *
 * 它同时也是**本仓库第二危险的出网入口**（第一个是订阅抓取）：用户能让服务器
 * 去访问任意地址。因此三道闸门一个都不能省：
 *   ① `assertPublicHost` 字面量 + DNS 双段判定（内网/回环/云元数据一律 400）；
 *   ② `safeFetch` 自己跟重定向并**逐跳**重判（否则 302 到 127.0.0.1 就绕过了）；
 *   ③ 连接钉定到已校验 IP（防 DNS rebinding 的 TOCTOU）。
 *
 * 缓存两层，与 legacy 一致但补了两处：
 *  - L1 内存（500 条，LRU 近似）+ L2 `image_cache` 表；
 *  - 过期走 **stale-while-revalidate**：先给旧图，后台静默刷新，用户永远不等待；
 *  - 【新增】同键**并发去重** —— 一屏 30 张图同时请求、缓存又恰好过期时，
 *    legacy 会向同一张图并发回源 30 次；这里只放一个过去，其余等它的结果。
 *
 * 安全响应头（legacy 缺，这里必须补）：
 *  - `X-Content-Type-Options: nosniff`；
 *  - `Content-Security-Policy: default-src 'none'; sandbox` —— 关键在 **sandbox**：
 *    SVG 是"带脚本的图片"，通过 <img> 引用时不执行，但用户右键「在新标签打开」
 *    就是**同源**打开一个能跑 JS 的文档。sandbox 让它即使被直接打开也是无源沙箱。
 *  - Content-Type 严格限定 `image/*`，非图片一律 502（防上游拿 HTML 错误页当图，
 *    那会变成同源 XSS）。
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { zValidator } from '@hono/zod-validator';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { imageCache, type Db } from '@feedlore/db';
import type { AuthInstance } from '@feedlore/auth';
import { img as imgSpec } from '@feedlore/contract';
import { assertPublicHost, safeFetch } from '../lib/net';
import { compressImage, imageCacheKey, isImageType, IMG_MAX_BYTES } from '../lib/image';
import { requireAuth, type AppEnv } from '../middleware/auth';
import { APP_VERSION } from '../env';
import { sourceSnapshot } from '../lib/settings';

/* ============================================================================
 * 参数
 * ==========================================================================*/

const UPSTREAM_TIMEOUT_MS = 15_000;
const L1_MAX = 500;

/** 缓存新鲜期：超过就转后台刷新（但**仍然先返回旧图**）。 */
/** 缓存新鲜期：超过就转后台刷新（但**仍然先返回旧图**）。每次读快照，管理员改参数即时生效。 */
const ttlMs = (): number => Math.max(1, sourceSnapshot()?.imgTtlDays ?? 7) * 86_400_000;
/** 库内保留天数：更老的直接删（由 `pruneImageCache` 在调度 tick 里清）。 */
export const imgKeepDays = (): number => Math.max(1, sourceSnapshot()?.imgKeepDays ?? 90);

/** 浏览器缓存时长：一天。图片内容基本不变，本地再多存也没坏处。 */
const BROWSER_CACHE = 'public, max-age=86400';

const UA = `Mozilla/5.0 (compatible; FeedLore/${APP_VERSION})`;

/* ============================================================================
 * 缓存层
 * ==========================================================================*/

interface Cached {
  type: string;
  buf: Buffer;
}

/** L1：内存。重启即失，只为扛住「同一张图一屏出现 5 次」这种热路径。 */
const l1 = new Map<string, Cached>();

function l1Get(key: string): Cached | undefined {
  const hit = l1.get(key);
  if (!hit) return undefined;
  // 近似 LRU：命中就挪到队尾（Map 保持插入序，删了重插即置后）
  l1.delete(key);
  l1.set(key, hit);
  return hit;
}

function l1Set(key: string, v: Cached): void {
  l1.delete(key);
  l1.set(key, v);
  if (l1.size > L1_MAX) {
    const oldest = l1.keys().next();
    if (!oldest.done) l1.delete(oldest.value);
  }
}

/** 同键并发去重：in-flight 的请求共享同一个 Promise。 */
const inFlight = new Map<string, Promise<Cached | null>>();

/** 清空内存缓存与在途表。测试用；管理端「清空图片缓存」也复用它（L1 不清会看起来没删掉）。 */
export function resetImageCache(): void {
  l1.clear();
  inFlight.clear();
}

/* ============================================================================
 * 上游抓取
 * ==========================================================================*/

interface UpstreamError extends Error {
  status?: number;
}

const upstreamError = (message: string, status: number): UpstreamError =>
  Object.assign(new Error(message), { status });

/**
 * 回源取图。
 *
 * 403 时的 Referer 重试是刻意的：一部分国内站点（以及部分对象存储的防盗链配置）
 * 只在「完全无 Referer」时才拦，另一些只在「Referer 不是自家域名」时放行。
 * 先不带，被拒了再带图片自身的 origin —— 两种情况都能过，且不多发请求。
 */
async function fetchUpstream(url: string, signal: AbortSignal): Promise<{ buf: Buffer; type: string; origSize: number }> {
  const base = {
    'User-Agent': UA,
    Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
  };

  let resp = await safeFetch(url, { headers: base, signal });

  if (resp.status === 403) {
    try {
      await resp.body?.cancel();
    } catch {
      /* noop */
    }
    const origin = new URL(url).origin + '/';
    resp = await safeFetch(url, { headers: { ...base, Referer: origin }, signal });
  }

  /* 上游明确应答了 4xx/5xx → **原样透传状态码**。
   * legacy v2.2.1 的教训：全包成 502 之后，排查时以为是代理/缓存坏了，
   * 其实只是图片源自己 403。透传才能一眼看出是谁的问题。 */
  if (!resp.ok) {
    try {
      await resp.body?.cancel();
    } catch {
      /* noop */
    }
    throw upstreamError(`upstream ${resp.status}`, resp.status >= 400 && resp.status <= 599 ? resp.status : 502);
  }

  // 缺 Content-Type 的源不少（尤其老论坛），按 jpeg 兜底 —— nosniff 下这是安全的，
  // 浏览器不会把 JPEG 字节当 HTML 跑。
  const type = resp.headers.get('content-type') || 'image/jpeg';
  if (!isImageType(type)) throw upstreamError('not an image', 502);

  // 先看声明长度，避免把 200MB 拉进内存（有 content-length 时能提前止损）
  const declared = Number(resp.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > IMG_MAX_BYTES) {
    try {
      await resp.body?.cancel();
    } catch {
      /* noop */
    }
    throw upstreamError('image too large', 502);
  }

  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length === 0) throw upstreamError('empty image', 502);
  if (buf.length > IMG_MAX_BYTES) throw upstreamError('image too large', 502);

  return { buf, type, origSize: buf.length };
}

/** 回源 → 压缩 → 写 L2/L1。失败抛带 status 的错误，调用方决定怎么回。 */
async function fetchAndCache(db: Db | null, key: string, url: string): Promise<Cached> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const { buf: raw, type, origSize } = await fetchUpstream(url, ctl.signal);

    const snap = sourceSnapshot();
    const comp = await compressImage(raw, type, {
      maxDim: snap?.imgMaxDim,
      quality: snap?.imgQuality,
    });
    const out: Cached = comp
      ? { type: comp.contentType, buf: comp.buf }
      : { type, buf: raw };

    if (db) {
      try {
        await db
          .insert(imageCache)
          .values({
            key,
            contentType: out.type,
            data: out.buf,
            width: comp?.width ?? null,
            height: comp?.height ?? null,
            origSize,
            size: out.buf.length,
          })
          .onConflictDoUpdate({
            target: imageCache.key,
            set: {
              contentType: out.type,
              data: out.buf,
              width: comp?.width ?? null,
              height: comp?.height ?? null,
              origSize,
              size: out.buf.length,
              createdAt: new Date(),
            },
          });
      } catch (e) {
        // 落库失败不致命：图已经拿到，L1 还能用，用户这次不该看到错误
        console.warn('[img] 写入缓存表失败：', (e as Error)?.message ?? e);
      }
    }

    l1Set(key, out);
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/* ============================================================================
 * 响应
 * ==========================================================================*/

function imageResponse(v: Cached): Response {
  // 必须切出独立 ArrayBuffer：Buffer 常是池化切片，直接给 buffer 会带出无关字节
  const ab = v.buf.buffer.slice(v.buf.byteOffset, v.buf.byteOffset + v.buf.byteLength) as ArrayBuffer;
  return new Response(ab, {
    status: 200,
    headers: {
      'Content-Type': v.type,
      'Content-Length': String(v.buf.length),
      'Cache-Control': BROWSER_CACHE,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      // 图片本身不需要任何站点权限
      'Referrer-Policy': 'no-referrer',
    },
  });
}

/* ============================================================================
 * 路由
 * ==========================================================================*/

/** `u` 用 z.string() 收，URL 合法性交给 assertPublicHost 统一判定：
 *  这里用 z.url() 会先于安全判定返回 400，报错文案也就变成 zod 的英文串。 */
const imgQuery = z.object({ u: z.string().min(1).max(4000) });

export function imgRoutes(db: Db | null, auth: AuthInstance | null) {
  // ⚠️ 链式返回，否则 hc<AppType> 看不到本路由（见 health.ts 注释）
  return new Hono<AppEnv>().get(
    imgSpec.proxy.path,
    requireAuth(auth, 'user'),
    zValidator('query', imgQuery),
    async (c) => {
      const { u: raw } = c.req.valid('query');

      /* 重复协议头归一：个别源把图标写成 `https:https://...`，
       * 直接 new URL 会解析出主机名 "https:"，注定抓不到（legacy v2.2.5 修过）。 */
      const cleaned = raw.replace(/^(https?):\1:\/\//i, '$1://');

      if (/^data:/i.test(cleaned)) {
        // data URI 本身是完整资源，不需要也没有意义过代理；前端应当直通。
        throw new HTTPException(400, { message: 'data: 地址无需经过图片代理' });
      }

      // ① 出网判定（含 DNS 解析，内网/回环直接 400）
      const info = await assertPublicHost(cleaned);
      const url = info.url;
      const key = imageCacheKey(url);

      // ② L1
      const hot = l1Get(key);
      if (hot) return imageResponse(hot);

      // ③ L2
      let l2: Cached | null = null;
      let fresh = false;
      if (db) {
        try {
          const [row] = await db
            .select({ contentType: imageCache.contentType, data: imageCache.data, createdAt: imageCache.createdAt })
            .from(imageCache)
            .where(eq(imageCache.key, key))
            .limit(1);
          if (row) {
            l2 = { type: row.contentType, buf: row.data };
            fresh = Date.now() - new Date(row.createdAt).getTime() < ttlMs();
          }
        } catch (e) {
          // 库抖一下不该让图片全挂：当作未命中，直接回源
          console.warn('[img] 读缓存表失败：', (e as Error)?.message ?? e);
        }
      }

      if (l2) {
        l1Set(key, l2);
        if (fresh) return imageResponse(l2);

        // 过期：先给旧图（用户不等待），后台静默刷新。
        // 静默刷新也走去重表，避免「十个标签页同时打开过期图」把上游打十次。
        if (!inFlight.has(key)) {
          const job = fetchAndCache(db, key, url)
            .catch(() => null)
            .finally(() => inFlight.delete(key));
          inFlight.set(key, job);
        }
        return imageResponse(l2);
      }

      // ④ 未命中：并发去重后再回源
      let job = inFlight.get(key);
      if (!job) {
        job = fetchAndCache(db, key, url).finally(() => inFlight.delete(key));
        inFlight.set(key, job);
      }

      let out: Cached | null;
      try {
        out = await job;
      } catch (e) {
        // 上游给了明确状态码就透传（403/404 让前端一眼看出是谁的问题），否则 504
        const st = Number((e as UpstreamError)?.status);
        const code = (st >= 400 && st <= 599 ? st : 504) as unknown as ContentfulStatusCode;
        throw new HTTPException(code, { message: '图片源返回错误' });
      }
      if (!out) throw new HTTPException(502, { message: '图片获取失败' });

      return imageResponse(out);
    },
  );
}

/**
 * 清理超期图片缓存；返回删除行数。
 * ⚠️ 必须在**调度 tick** 里调用（不是请求路径上）：`image_cache` 会随订阅量线性增长，
 *    legacy 每日跑一次，v2 挂在每小时最多一次的节流里。
 */
export async function pruneImageCache(db: Db | null): Promise<number> {
  if (!db) return 0;
  const before = new Date(Date.now() - imgKeepDays() * 86_400_000);
  try {
    // ⚠️ 不用 `.returning()`：几万行的 key 会被全拉回内存（entries 清理踩过同款）。
    // 走原始 SQL 只取 rowCount。
    const res = await db.execute(sql`
      delete from image_cache where created_at < ${before}
    `);
    return Number((res as unknown as { rowCount?: number | null }).rowCount ?? 0);
  } catch (e) {
    console.warn('[img] 清理图片缓存失败：', (e as Error)?.message ?? e);
    return 0;
  }
}
