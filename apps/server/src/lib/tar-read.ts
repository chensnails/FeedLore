/**
 * 流式 ustar + gzip 解包（只服务于导入，零依赖）。
 *
 * 与 `tar.ts`（写）同一套格式约定。导入比导出危险得多：包是用户上传的，
 * 所以这里**不接受任意路径**，只认导出器自己会写的那几种文件名；类别不符、
 * 绝对路径、`..`、目录项、符号链接与重复条目一律拒绝。解包目录由调用方创建与清理，
 * 本模块只管把通过校验的文件写进去。
 *
 * 大小上限分三层：单文件、总解压量、条目数。上传压缩包本身另有一层限制（见路由）。
 * 头校验和也做校验：截断或损坏的包必须在写库前失败，而不是导入一半。
 */

import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createGunzip } from 'node:zlib';
import { ApiException } from './apiError';

const BLOCK = 512;

/** 图片缓存键允许的字符；宽度变体带 `:w640` 这类后缀（见 imageVariantKey）。 */
const IMAGE_KEY_SOURCE = '[A-Za-z0-9._-]{1,150}(?::w\\d{1,4})?';

/** 导出器可能写出的全部文件名。images/ 下是图片缓存键。 */
const SAFE_NAME = new RegExp(
  '^(manifest\\.json|feeds\\.json|prefs\\.json|llm\\.json|digests\\.json|users\\.json|accounts\\.json|' +
  'user_llm\\.json|settings\\.json|image_cache\\.json|entries-\\d{4}\\.jsonl|article_cache-\\d{4}\\.jsonl|' +
  `images/${IMAGE_KEY_SOURCE})$`,
);

const IMAGE_KEY_RE = new RegExp(`^${IMAGE_KEY_SOURCE}$`);

/** 清单里的图片键是否与解包白名单同一套规则（防止清单 json 注入路径）。 */
export const isSafeImageKey = (key: string): boolean => IMAGE_KEY_RE.test(key);

export interface ExtractLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
}

export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 3 * 1024 * 1024 * 1024,
  maxFiles: 200_000,
};

export interface ExtractResult {
  files: number;
  bytes: number;
}

const invalid = (message: string): ApiException =>
  new ApiException('E_IMPORT_INVALID', { message: `Invalid export archive: ${message}` });

const tooLarge = (message: string): ApiException =>
  new ApiException('E_IMPORT_TOO_LARGE', { message: `Export archive is too large: ${message}` });

function parseOctal(buf: Buffer, from: number, length: number): number {
  const raw = buf.subarray(from, from + length).toString('ascii').replace(/\0[\s\S]*$/, '').trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) throw invalid('bad numeric field');
  return parseInt(raw, 8);
}

function headerName(buf: Buffer): string {
  return buf.subarray(0, 100).toString('utf8').replace(/\0[\s\S]*$/, '');
}

function verifyChecksum(buf: Buffer): void {
  const stored = parseOctal(buf, 148, 6);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    sum += i >= 148 && i < 156 ? 0x20 : buf[i]!;
  }
  if (sum !== stored) throw invalid('header checksum mismatch');
}

/**
 * 解开 tar.gz 并写入 destDir。失败时抛 ApiException（E_IMPORT_INVALID / E_IMPORT_TOO_LARGE），
 * 已写入的部分由调用方清理。成功返回文件数与总字节数。
 */
export async function extractTarGz(
  archivePath: string,
  destDir: string,
  limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS,
): Promise<ExtractResult> {
  await mkdir(destDir, { recursive: true });

  const src = createReadStream(archivePath);
  const gunzip = createGunzip();
  /* 源文件错误不会自动传给 gunzip 的迭代器；不转发的话坏包会表现为「流提前结束」。 */
  src.on('error', (err) => gunzip.destroy(err));
  src.pipe(gunzip);

  const iterator = gunzip[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  let finished = false;

  const pull = async (atLeast: number): Promise<void> => {
    while (pending.length < atLeast && !finished) {
      let next: IteratorResult<Buffer>;
      try {
        next = (await iterator.next()) as IteratorResult<Buffer>;
      } catch (err) {
        throw invalid(`cannot decompress archive (${(err as Error)?.message ?? 'unknown error'})`);
      }
      if (next.done) {
        finished = true;
        break;
      }
      const chunk = Buffer.from(next.value);
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    }
  };

  const need = async (n: number): Promise<Buffer> => {
    await pull(n);
    if (pending.length < n) throw invalid('archive is truncated');
    const out = pending.subarray(0, n);
    pending = pending.subarray(n);
    return out;
  };

  const seen = new Set<string>();
  let files = 0;
  let bytes = 0;

  try {
    for (;;) {
      const header = await need(BLOCK);
      /* 两个全零块表示结束；读到第一个全零头就停，尾部的第二个块不再校验。 */
      if (header.every((b) => b === 0)) break;

      verifyChecksum(header);
      const name = headerName(header);
      if (!SAFE_NAME.test(name)) throw invalid(`unexpected entry "${name}"`);
      if (seen.has(name)) throw invalid(`duplicate entry "${name}"`);
      seen.add(name);

      const type = header.subarray(156, 157).toString('ascii');
      if (type !== '0' && type !== '\0') throw invalid(`unsupported entry type for "${name}"`);

      const size = parseOctal(header, 124, 12);
      if (size > limits.maxFileBytes) throw tooLarge(`"${name}" is larger than the per-file limit`);
      bytes += size;
      if (bytes > limits.maxTotalBytes) throw tooLarge('uncompressed size exceeds the total limit');

      files += 1;
      if (files > limits.maxFiles) throw tooLarge('entry count exceeds the limit');

      const data = await need(size);
      const target = join(destDir, ...name.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);

      const pad = (BLOCK - (size % BLOCK)) % BLOCK;
      if (pad) await need(pad);
    }

    /* 结束标记之后继续读到流尾，让 gzip 的 CRC/长度校验真正执行；
     * 不读的话，一个被截断但恰好有结束块的包也能「成功」导入。 */
    try {
      while (!(await iterator.next()).done) {
        /* drain */
      }
    } catch (err) {
      throw invalid(`cannot decompress archive (${(err as Error)?.message ?? 'unknown error'})`);
    }
  } finally {
    src.destroy();
    gunzip.destroy();
    try {
      await iterator.return?.();
    } catch {
      /* 已读到尾部，关闭时的错误不再关心 */
    }
  }

  return { files, bytes };
}
