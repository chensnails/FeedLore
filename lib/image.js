'use strict';

/**
 * 图片压缩（纯变换：buffer → buffer，不碰网络/数据库，可直接单测）
 *
 * 缓存层在把上游图片落库前调用它做「缩尺寸 + 转 WebP」压缩，把动辄几百 KB 的
 * 卡片原图压到 30–120KB，既省库又省带宽。svg / ico 之类不重编码，交给调用方原样存。
 *
 * 参数优先级：调用方传的 opts（settings.source.imgMaxDim / imgQuality）> 模块默认值（env）。
 */

const sharp = require('sharp');

const MAX_DIM = Number(process.env.IMG_MAX_DIM || 1280);
const WEBP_QUALITY = Number(process.env.IMG_WEBP_QUALITY || 78);
const MAX_BYTES = Number(process.env.IMG_MAX_BYTES || 8 * 1024 * 1024);

// 只重编码常见栅格图；svg 是矢量、ico 是图标、他种一律不动
const RASTER = /^image\/(jpeg|jpg|png|webp|gif|avif|bmp|tiff)$/i;

/**
 * 压缩一张图片为适合做缩略图 / 卡片图的 WebP。
 * @param {Buffer} buf        原始图片字节
 * @param {string} contentType 上游 Content-Type
 * @param {{maxDim?:number, quality?:number}} [opts] 覆盖上限 / 质量（管理员在「采集参数」里调；
 *        不传则回落模块默认值，即 env IMG_MAX_DIM / IMG_WEBP_QUALITY）
 * @returns {Promise<{buf:Buffer, contentType:string, width:number, height:number}|null>}
 *          成功返回压缩结果；不支持的类型 / 压缩失败 / 压缩后反而更大 → 返回 null（调用方改存原图）
 */
async function compressImage(buf, contentType, opts) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return null;
  if (!RASTER.test(contentType || '')) return null;
  const maxDim = Number(opts && opts.maxDim) > 0 ? Number(opts.maxDim) : MAX_DIM;
  const quality = Number(opts && opts.quality) > 0 ? Number(opts.quality) : WEBP_QUALITY;
  try {
    const img = sharp(buf, { animated: false });
    const meta = await img.metadata();
    if (!meta.width || !meta.height) return null;

    let pipe = img;
    // 只在超过上限时才缩，避免放大小图（withoutEnlargement）
    if (Math.max(meta.width, meta.height) > maxDim) {
      pipe = pipe.resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true });
    }
    pipe = pipe.webp({ quality, effort: 4 });

    const out = await pipe.toBuffer({ resolveWithObject: true });
    // 压缩后体积没变小（极小的图）→ 不如直接存原图
    if (out.data.length >= buf.length) return null;
    return { buf: out.data, contentType: 'image/webp', width: out.info.width, height: out.info.height };
  } catch (_) {
    return null;
  }
}

module.exports = { compressImage, MAX_DIM, WEBP_QUALITY, MAX_BYTES, RASTER };
