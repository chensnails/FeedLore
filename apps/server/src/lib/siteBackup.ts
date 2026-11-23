/**
 * 整站还原前的自动留底：把当前库写成一份 tar.gz 落到容器本地目录。
 *
 * 与 GET /api/backup 的区别：那条是流式下载、不落盘；这条是还原前的冷备，
 * 还原成功后会话会全部失效，运维需要留一份可追溯的文件在容器里。
 * 容器没有持久卷，重建后目录会丢——所以它只是「还原前留底」，不能替代日常备份下载。
 *
 * 备份扫全库很重，且与用户主动下载共用同一把锁；同一时刻只允许一份在跑。
 */

import { createWriteStream } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Db } from '@feedlore/db';
import { writeSiteExport } from './exportData';
import { createTarGz } from './tar';

/** 可用环境变量覆盖；默认放容器临时目录，避免污染应用代码目录。 */
export const restoreBackupDir = (): string =>
  process.env.RESTORE_BACKUP_DIR || join(tmpdir(), 'feedlore-restore-backups');

/** 只保留最近 3 份，避免还原反复执行把容器磁盘堆满。 */
const KEEP = 3;
const PREFIX = 'feedlore-site-auto-';

/** 模块级状态：容器内只有一个进程，与 export.ts / import.ts 共用这一把锁。 */
let backupBusy = false;
export function tryAcquireBackupLock(): boolean {
  if (backupBusy) return false;
  backupBusy = true;
  return true;
}
export function releaseBackupLock(): void {
  backupBusy = false;
}

export interface AutoSiteBackup {
  file: string;
  bytes: number;
  createdAt: string;
}

/** 写一份当前站点的自动备份；调用方必须已经拿到 backup 锁。 */
export async function createAutoSiteBackup(db: Db, now = Date.now()): Promise<AutoSiteBackup> {
  const dir = restoreBackupDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `${PREFIX}${stamp}.tar.gz`);
  const out = createWriteStream(file, { mode: 0o600 });
  const ar = createTarGz(now);
  // 必须先开始消费 readable，否则 gzip 背压会让 writeSiteExport 永远挂住。
  const drained = pipeline(ar.readable, out);
  try {
    await writeSiteExport(ar, db);
    await ar.close();
    await drained;
  } catch (err) {
    ar.abort(err as Error);
    await drained.catch(() => undefined);
    await unlink(file).catch(() => undefined);
    throw err;
  }

  const info = await stat(file);
  await pruneBackups(dir).catch(() => undefined);
  return { file: basename(file), bytes: info.size, createdAt: new Date(now).toISOString() };
}

/** 只清本模块生成的自动备份，不动管理员手工导出的包。 */
async function pruneBackups(dir: string): Promise<void> {
  const names = (await readdir(dir))
    .filter((n) => n.startsWith(PREFIX) && n.endsWith('.tar.gz'))
    .sort()
    .reverse();
  for (const name of names.slice(KEEP)) {
    await unlink(join(dir, name)).catch(() => undefined);
  }
}
