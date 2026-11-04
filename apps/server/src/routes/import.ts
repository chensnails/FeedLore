/**
 * 数据导入 / 整站还原。
 *
 * 上传的是**原始请求体**（`Content-Type: application/gzip`），不套 multipart：
 * 前端一个 `fetch(url, { body: file })` 就够，服务端也不需要在内存里拼表单。
 * 文件先落到临时目录，再安全解包、校验、写库，最后无论成败都删临时目录。
 *
 * 两个互斥规则：
 * - 整站还原会清空全库，期间拒绝新的账号导入；反过来，只要还有账号导入在跑，
 *   还原也直接 409，避免「一边合并一边清空」。
 * - 上传大小在 HTTP 层先按 Content-Length 挡一次，流式写入时再按实际字节数挡一次
 *   （Content-Length 可以撒谎，压缩包还可以是 chunked）。
 */

import { Hono, type Context } from 'hono';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AuthInstance } from '@feedlore/auth';
import type { Db } from '@feedlore/db';
import { resetCryptoSecretCache } from '@feedlore/ai';
import { importApi } from '@feedlore/contract';
import { apiError, ApiException } from '../lib/apiError';
import { assertResponse } from '../lib/validate';
import { extractTarGz } from '../lib/tar-read';
import { importUserArchive, restoreSiteArchive } from '../lib/importData';
import { reloadSource, resetSourceSnapshot } from '../lib/settings';
import { requireAuth, type AppEnv } from '../middleware/auth';

/** 压缩包上限；解包后的单文件/总量上限在 tar-read 里。 */
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

/** 整站还原互斥；账号导入计数用于让还原等待进行中的合并。 */
let restoreBusy = false;
let activeImports = 0;

const emptyArchive = (): ApiException =>
  new ApiException('E_IMPORT_INVALID', { message: 'Invalid export archive: empty request body' });

/** 把请求体流式写到临时文件，超过上限立即中断（不把整包读进内存）。 */
async function receiveUpload(c: Context<AppEnv>, dir: string): Promise<string> {
  const declared = Number(c.req.header('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    throw new ApiException('E_IMPORT_TOO_LARGE');
  }
  const body = c.req.raw.body;
  if (!body) throw emptyArchive();

  const file = join(dir, 'upload.tar.gz');
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD_BYTES) {
        cb(new ApiException('E_IMPORT_TOO_LARGE'));
        return;
      }
      cb(null, chunk);
    },
  });

  await pipeline(
    Readable.fromWeb(body as unknown as import('node:stream/web').ReadableStream<Uint8Array>),
    counter,
    createWriteStream(file),
  );
  if (!bytes) throw emptyArchive();
  return file;
}

export function importRoutes(db: Db | null, auth: AuthInstance | null) {
  return new Hono<AppEnv>()
    /* ---------------- POST /api/import：合并到当前账号 ---------------- */
    .post(importApi.userImport.path, requireAuth(auth, 'write'), async (c) => {
      if (!db) return apiError(c, 'E_DB_NOT_READY');
      if (restoreBusy) return apiError(c, 'E_RESTORE_IN_PROGRESS');

      activeImports += 1;
      let tmp = '';
      try {
        tmp = await mkdtemp(join(tmpdir(), 'feedlore-import-'));
        const archive = await receiveUpload(c, tmp);
        const dir = join(tmp, 'data');
        await extractTarGz(archive, dir);
        const result = await importUserArchive(db, c.get('user').id, dir);
        return c.json(assertResponse(importApi.userImport.response, result, 'POST /api/import'));
      } finally {
        activeImports -= 1;
        if (tmp) await rm(tmp, { recursive: true, force: true });
      }
    })

    /* ---------------- POST /api/restore：整站还原（管理员） ---------------- */
    .post(importApi.siteRestore.path, requireAuth(auth, 'admin'), async (c) => {
      if (!db) return apiError(c, 'E_DB_NOT_READY');
      if (restoreBusy || activeImports > 0) return apiError(c, 'E_RESTORE_IN_PROGRESS');

      restoreBusy = true;
      let tmp = '';
      try {
        tmp = await mkdtemp(join(tmpdir(), 'feedlore-restore-'));
        const archive = await receiveUpload(c, tmp);
        const dir = join(tmp, 'data');
        await extractTarGz(archive, dir);
        const result = await restoreSiteArchive(db, dir);

        /* 包里带了站点设置（含加密主密钥）与采集参数：进程内快照必须立刻失效，
         * 否则还原后的第一次抓取 / 模型解密仍按旧配置走。 */
        resetSourceSnapshot();
        await reloadSource(db);
        resetCryptoSecretCache();

        console.log('[restore] site restore finished', JSON.stringify(result.counts));
        return c.json(assertResponse(importApi.siteRestore.response, result, 'POST /api/restore'));
      } finally {
        restoreBusy = false;
        if (tmp) await rm(tmp, { recursive: true, force: true });
      }
    });
}
