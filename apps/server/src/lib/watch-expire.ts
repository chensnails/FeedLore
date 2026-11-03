/**
 * 关注保留期：按每个用户的 `prefs.watchExpireDays` 自动移除到期的关注标记。
 *
 * 关注只是条目上的一个标签（`watch_state='watch'`），不搬动文章；保留期到了只清标记，
 * 文章仍在原频道、已读 / 收藏状态也不动。屏蔽（`watch_state='block'`）不参与过期，
 * 它是归档而不是收件箱。0 天 = 永不自动退出。
 */

import { eq, sql } from 'drizzle-orm';
import { users, type Db } from '@feedlore/db';
import { userWatchExpireDays } from './prefs';

/** 清理到期关注标记；传 uid 只处理该用户，否则处理全部用户。返回清掉的条数。 */
export async function expireWatchTags(db: Db, uid?: string): Promise<number> {
  const rows = uid
    ? await db.select({ id: users.id, prefs: users.prefs }).from(users).where(eq(users.id, uid))
    : await db.select({ id: users.id, prefs: users.prefs }).from(users);

  let total = 0;
  for (const row of rows) {
    const days = userWatchExpireDays(row.prefs);
    if (days <= 0) continue;
    const res = await db.execute(sql`
      update entries
         set watch_state = null, watch_rule = null, watch_tagged_at = null
       where watch_state = 'watch'
         and watch_tagged_at is not null
         and watch_tagged_at < now() - make_interval(days => ${days})
         and feed_id in (select id from feeds where owner_id = ${row.id})
    `);
    total += Number((res as unknown as { rowCount?: number | null }).rowCount ?? 0);
  }
  return total;
}
