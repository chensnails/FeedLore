/**
 * 日报缩略图回填（`fillDigestImages`）的自检。
 *
 * 这条逻辑只在「读到老日报」时才会跑：payload 里没有 `image` 键、但条目 `link` 在。
 * 两个必须守住的点：
 *  1. 已经有 image 的条目不能被覆盖（新日报重新读一遍不该换图）；
 *  2. 没有任何缺图条目时不许查库（每次翻日报都多一条 entries 查询是白烧）。
 * 数据库用桩替代：这里验的是「缺图判定 + 按 link 合并 + 代理地址」，不是 SQL 方言。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fillDigestImages } from '@feedlore/ai';
import type { Db } from '@feedlore/db';
import type { Digest } from '@feedlore/contract';

const digest = (over: Partial<Digest> = {}): Digest => ({
  date: '2026-11-14',
  generatedAt: 1,
  windowFrom: 0,
  windowTo: 1,
  model: 'm',
  usedMapReduce: false,
  fallback: false,
  error: null,
  stats: { collected: 2, kept: 2, feeds: 1 },
  overview: '',
  highlights: [],
  sections: [
    {
      title: '分类',
      items: [
        { comment: '', item: { name: 'A', feedName: 'f', tags: [], size: '', link: 'https://e.com/a' } },
        { comment: '', item: { name: 'B', feedName: 'f', tags: [], size: '', link: 'https://e.com/b' } },
      ],
    },
  ],
  ...over,
});

/** 只实现 fillDigestImages 用到的那条 select 链；`calls` 用来断言「没缺图就不查库」。 */
function stubDb(rows: Array<{ link: string | null; image: string | null; sourceUrl: string | null }>) {
  const calls: string[] = [];
  const db = {
    select: () => {
      calls.push('select');
      return {
        from: () => ({
          innerJoin: () => ({
            where: () => Promise.resolve(rows),
          }),
        }),
      };
    },
  };
  return { db: db as unknown as Db, calls };
}

test('老日报按 link 回填缩略图，且改写成本站代理地址', async () => {
  const { db } = stubDb([
    { link: 'https://e.com/a', image: 'https://cdn.example/a.png', sourceUrl: null },
    { link: 'https://e.com/b', image: null, sourceUrl: null },   // 真的没图 → 保持兜底
  ]);
  const out = await fillDigestImages(db, 'u1', digest());
  const [a, b] = out.sections[0]!.items;
  assert.equal(a!.item?.image, '/api/img?u=' + encodeURIComponent('https://cdn.example/a.png'));
  assert.equal(b!.item?.image, undefined);
});

test('已有 image 的条目不覆盖，且此时不再查库', async () => {
  const withImg = digest({
    sections: [{
      title: '分类',
      items: [{ comment: '', item: { name: 'A', feedName: 'f', tags: [], size: '', link: 'https://e.com/a', image: '/api/img?u=x' } }],
    }],
  });
  const { db, calls } = stubDb([{ link: 'https://e.com/a', image: 'https://cdn.example/zzz.png', sourceUrl: null }]);
  const out = await fillDigestImages(db, 'u1', withImg);
  assert.equal(out.sections[0]!.items[0]!.item?.image, '/api/img?u=x');
  assert.equal(calls.length, 0, '没有缺图条目时不该查 entries');
});

test('相对图片地址按条目落地页补全；补不出来就保持无图', async () => {
  const { db } = stubDb([
    { link: 'https://e.com/a', image: '/img/cover.png', sourceUrl: null },
    { link: 'https://e.com/b', image: 'javascript:alert(1)', sourceUrl: null },
  ]);
  const out = await fillDigestImages(db, 'u1', digest());
  const [a, b] = out.sections[0]!.items;
  assert.equal(a!.item?.image, '/api/img?u=' + encodeURIComponent('https://e.com/img/cover.png'));
  assert.equal(b!.item?.image, undefined, '非法地址应丢弃，而不是给前端一个必 400 的链接');
});
