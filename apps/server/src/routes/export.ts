/**
 * 数据导出与整站备份（tar.gz 流式下载）。
 *
 * 设计取舍：
 * - **直接流式响应，不落临时文件**：应用容器没有持久卷，后台任务写下的文件在重建
 *   容器后就没了；边查边压边发，还能让浏览器显示真实进度。
 * - 鉴权用会话 Cookie（GET + 同源），readonly 角色也能导出**自己**的数据；整站备份
 *   仅管理员。会话令牌不会出现在包里（导出逻辑根本不选 sessions 表）。
 * - 整站备份同一时间只允许一份：它要扫全库和图片缓存，并发会拖垮数据库。
 */

import { Hono } from 'hono';
import { Readable } from 'node:stream';
import type { AuthInstance } from '@feedlore/auth';
import type { Db } from '@feedlore/db';
import { exportApi } from '@feedlore/contract';
import { apiError } from '../lib/apiError';
import { requireAuth, type AppEnv } from '../middleware/auth';
import { createTarGz } from '../lib/tar';
import { writeSiteExport, writeUserExport } from '../lib/exportData';

/** 文件名只留安全字符：用户名规则虽然已经限定 ASCII，仍不把用户输入直接送进响应头。 */
function safeName(raw: string): string {
  const s = raw.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40);
  return s || 'user';
}

const today = (): string => new Date().toISOString().slice(0, 10);

/** 整站备份互斥：模块级状态即可，容器内只有一个进程。 */
let siteBackupBusy = false;

export function exportRoutes(db: Db | null, auth: AuthInstance | null) {
  return new Hono<AppEnv>()
    /* ---------------- GET /api/export：账号数据 ---------------- */
    .get(exportApi.userExport.path, requireAuth(auth, 'user'), async (c) => {
      if (!db) return apiError(c, 'E_DB_NOT_READY');
      const me = c.get('user');
      const includeLlm = c.req.query('llm') === '1';

      const ar = createTarGz();
      ar.readable.on('error', (err) => {
        console.error('[export] user archive stream failed:', (err as Error)?.message ?? err);
      });
      c.req.raw.signal.addEventListener('abort', () => ar.abort(new Error('client aborted')));

      void (async () => {
        try {
          await writeUserExport(ar, {
            db,
            userId: me.id,
            username: me.username,
            includeLlm,
          });
          await ar.close();
        } catch (err) {
          console.error(`[export] user ${me.username} failed:`, (err as Error)?.message ?? err);
          ar.abort(err as Error);
        }
      })();

      return new Response(Readable.toWeb(ar.readable) as unknown as ReadableStream, {
        headers: {
          'Content-Type': 'application/gzip',
          'Content-Disposition': `attachment; filename="feedlore-${safeName(me.username)}-${today()}.tar.gz"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    })

    /* ---------------- GET /api/backup：整站备份（管理员） ---------------- */
    .get(exportApi.siteBackup.path, requireAuth(auth, 'admin'), async (c) => {
      if (!db) return apiError(c, 'E_DB_NOT_READY');
      if (siteBackupBusy) return apiError(c, 'E_BACKUP_IN_PROGRESS');
      siteBackupBusy = true;

      const ar = createTarGz();
      const release = () => { siteBackupBusy = false; };
      ar.readable.on('error', (err) => {
        console.error('[backup] site archive stream failed:', (err as Error)?.message ?? err);
        release();
      });
      c.req.raw.signal.addEventListener('abort', () => ar.abort(new Error('client aborted')));

      void (async () => {
        try {
          await writeSiteExport(ar, db);
          await ar.close();
          console.log('[backup] site archive finished');
        } catch (err) {
          console.error('[backup] site archive failed:', (err as Error)?.message ?? err);
          ar.abort(err as Error);
        } finally {
          release();
        }
      })();

      return new Response(Readable.toWeb(ar.readable) as unknown as ReadableStream, {
        headers: {
          'Content-Type': 'application/gzip',
          'Content-Disposition': `attachment; filename="feedlore-site-${today()}.tar.gz"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    });
}
