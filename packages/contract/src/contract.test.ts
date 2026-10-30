import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contract } from './endpoints';

/**
 * 契约自检。
 *
 * 这一层的 bug 有个共同特征：**服务端 tsc 全绿、前端也编译通过，只有真点一下才炸**。
 * 例如：
 * - `satisfies EndpointSpec` 写漏了 `as const` → path 被拓宽成 string，
 *   Hono 取不到路径字面量，这个端点**静默不进 AppType**（前端 hc 里根本没这个键）；
 * - 两个端点撞了同一个 method + path → 后注册的覆盖前一个，前一个功能凭空消失；
 * - `response` 忘了写 → `assertResponse` 无从校验，字段漂移不会被发现。
 *
 * 这些都是纯数据问题，不需要起服务就能测。
 */

interface Spec {
  method: string;
  path: string;
  auth: string;
  response?: unknown;
}

function allEndpoints(): Array<{ where: string; spec: Spec }> {
  const out: Array<{ where: string; spec: Spec }> = [];
  for (const [group, eps] of Object.entries(contract)) {
    for (const [name, spec] of Object.entries(eps as Record<string, unknown>)) {
      out.push({ where: `${group}.${name}`, spec: spec as Spec });
    }
  }
  return out;
}

test('端点数量对得上（新增/删除端点时这条会提醒你同步测试）', () => {
  const n = allEndpoints().length;
  assert.ok(n >= 35, `端点只有 ${n} 个，是不是有分组漏进 contract 了？`);
});

test('每个端点都有合法的 method / path / auth / response', () => {
  for (const { where, spec } of allEndpoints()) {
    assert.ok(
      ['get', 'post', 'patch', 'delete', 'put'].includes(spec.method),
      `${where}: method 非法（${String(spec.method)}）`,
    );
    assert.match(spec.path, /^\/api\//, `${where}: path 必须以 /api/ 开头，实际 ${spec.path}`);
    assert.ok(
      ['public', 'user', 'admin'].includes(spec.auth),
      `${where}: auth 只能是 public / user / admin，实际 ${String(spec.auth)}`,
    );
    /* response 必须是 zod schema：`assertResponse` 全靠它校验。
     * 值为 undefined 时 zod 的 safeParse 也不存在 —— 那种端点等于没有契约。 */
    const r = spec.response as { safeParse?: unknown } | undefined;
    assert.equal(typeof r?.safeParse, 'function', `${where}: 缺少 response schema`);
  }
});

test('method + path 不重复（重复注册会让先写的那个静默消失）', () => {
  const seen = new Map<string, string>();
  for (const { where, spec } of allEndpoints()) {
    const key = `${spec.method.toUpperCase()} ${spec.path}`;
    const prev = seen.get(key);
    assert.equal(prev, undefined, `${where} 与 ${prev} 撞了同一个 ${key}`);
    seen.set(key, where);
  }
});

test('path 参数写成 :name，且同一条路径里不重复', () => {
  for (const { where, spec } of allEndpoints()) {
    const params = [...spec.path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
    assert.equal(
      new Set(params).size,
      params.length,
      `${where}: 路径里出现重复参数名（${spec.path}）`,
    );
    /* `:id` 与 `{id}` 混用会得到一个永远匹配不上的路由 —— 这类笔误 tsc 也不管 */
    assert.ok(!spec.path.includes('{'), `${where}: 参数请用 :name 而不是 {name}`);
  }
});
