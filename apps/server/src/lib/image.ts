/**
 * 图片：缓存键 + 压缩（移植自 legacy `lib/image.js` 与 `lib/util.js` 的两个函数）。
 *
 * 本文件是**纯变换**：给字节、给 URL，返回字节和键，不碰网络也不碰数据库。
 * 这样缓存层（routes/img.ts）怎么改都不会影响这里的可测性。
 *
 * 压缩的意义不是「省磁盘」而是「省首屏」：RSS 站点的配图动辄 800KB~3MB，
 * 30 条卡片一屏就能拉出几十 MB。统一缩到长边 1280、转 WebP q78，
 * 实测多数配图落到 30~120KB。
 */

import crypto from 'node:crypto';
import sharp from 'sharp';

/** 单个图片字节上限：超过直接放弃（不是压缩，是真的一张 50MB 的扫描件）。 */
export const IMG_MAX_BYTES = 8 * 1024 * 1024;

const MAX_DIM = Number(process.env.IMG_MAX_DIM) > 0 ? Number(process.env.IMG_MAX_DIM) : 1280;
const WEBP_QUALITY = Number(process.env.IMG_WEBP_QUALITY) > 0 ? Number(process.env.IMG_WEBP_QUALITY) : 78;

/**
 * 只重编码常见栅格图。
 * svg 是矢量（重编码反而失真且丢缩放能力）、ico 是图标、其余（webp 之外的新格式）不动。
 */
const RASTER = /^image\/(jpeg|jpg|png|gif|avif|bmp|tiff)$/i;

/**
 * 图片 URL 归一化（缓存键的输入）。
 *
 * 三件事，少一件就会「同一张图缓存成多份」：
 *  1. 去掉 fragment —— `#a` `#b` 指向同一张图；
 *  2. 去掉 `r` 参数 —— 前端重试时拼的 `?r=1` 若进了键，重试一次就多存一份；
 *  3. `URL.toString()` 顺带把主机名小写、补默认端口。
 */
export function canonicalImageUrl(u: string): string {
  try {
    const x = new URL(String(u ?? '').trim());
    x.hash = '';
    x.searchParams.delete('r');
    return x.toString();
  } catch {
    return String(u ?? '').trim();
  }
}

/** 缓存键 = 归一化 URL 的 sha256（与 image_cache.key 对齐，legacy 同款）。 */
export function imageCacheKey(u: string): string {
  return crypto.createHash('sha256').update(canonicalImageUrl(u)).digest('hex');
}

export interface CompressResult {
  buf: Buffer;
  contentType: string;
  width: number;
  height: number;
}

export interface CompressOptions {
  maxDim?: number;
  quality?: number;
}

/**
 * 压缩成适合做卡片图 / 正文图的 WebP。
 *
 * 返回 null 的三种情况（调用方一律原样存原图）：
 *  - 不是栅格图（svg / ico / 未知类型）；
 *  - 压完反而更大（几十像素的小图，WebP 头比像素还大）；
 *  - sharp 解不开（损坏、CMYK JPEG 等）。
 *
 * ⚠️ `animated: false` 是**故意的**：GIF 只取第一帧。动图当卡片封面时
 * 体积能差 20 倍，而列表里根本看不出动。
 */
export async function compressImage(
  buf: Buffer,
  contentType: string,
  opts: CompressOptions = {},
): Promise<CompressResult | null> {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return null;
  if (!RASTER.test(String(contentType ?? ''))) return null;

  const maxDim = Number(opts.maxDim) > 0 ? Number(opts.maxDim) : MAX_DIM;
  const quality = Number(opts.quality) > 0 ? Number(opts.quality) : WEBP_QUALITY;

  try {
    const img = sharp(buf, { animated: false });
    const meta = await img.metadata();
    if (!meta.width || !meta.height) return null;

    let pipe = img;
    // 只缩不放：小图放大只会变模糊，体积还翻倍
    if (Math.max(meta.width, meta.height) > maxDim) {
      pipe = pipe.resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true });
    }
    const out = await pipe.webp({ quality, effort: 4 }).toBuffer({ resolveWithObject: true });

    if (out.data.length >= buf.length) return null;
    return {
      buf: out.data,
      contentType: 'image/webp',
      width: out.info.width,
      height: out.info.height,
    };
  } catch {
    return null;
  }
}

/** 图片类型的「能不能直接当 img src 用」判定（代理拒绝非图片上游）。 */
export function isImageType(contentType: string | null | undefined): boolean {
  return /^image\//i.test(String(contentType ?? ''));
}
