/**
 * 多路提供商路由的纯函数单测（0015）。
 * 不依赖真 PG：把 jsonb 容错与 providerId 选取抽成纯函数，回落链由集成测试/CI 覆盖。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { safeRoutes, pickProviderId, isRouteEnabled, CAPABILITY_LABEL } from './llm';
import { AI_CAPABILITIES } from '@feedlore/contract';

test('safeRoutes: 非对象/数组/null 一律回落空表', () => {
  for (const bad of [null, undefined, 42, 'x', [], ['a']]) {
    assert.deepEqual(safeRoutes(bad), {}, `应容错 ${String(bad)}`);
  }
});

test('safeRoutes: 丢弃非法值与嵌套脏数据，保留合法键', () => {
  const routes = safeRoutes({
    digest: { enabled: false, providerId: 'p1', actions: { summary: 'p2' } },
    explore: { enabled: 'yes', providerId: 123, actions: ['bad'] },
    ai_tags: null,
    mcp: { providerId: 'p3', actions: { translate: 7, explain: 'p4' } },
  });
  assert.equal(routes.digest?.enabled, false, '布尔 enabled 保留');
  assert.equal(routes.digest?.providerId, 'p1');
  assert.equal(routes.digest?.actions?.summary, 'p2');
  assert.deepEqual(routes.explore, {}, '非法 enabled/providerId/actions 全丢弃');
  assert.ok(!('ai_tags' in routes), 'null 项跳过');
  assert.deepEqual(routes.mcp?.actions, { explain: 'p4' }, 'action 值非字符串丢弃');
});

test('pickProviderId: 动作级 > 能力级 > default', () => {
  const routes = safeRoutes({
    entry_ai: { providerId: 'p1', actions: { translate: 'p2' } },
    digest: { providerId: 'p3' },
  });
  assert.equal(pickProviderId(routes, 'entry_ai', 'translate'), 'p2', '动作级优先');
  assert.equal(pickProviderId(routes, 'entry_ai', 'summary'), 'p1', '未配置的动作回落能力级');
  assert.equal(pickProviderId(routes, 'entry_ai'), 'p1');
  assert.equal(pickProviderId(routes, 'digest'), 'p3');
  assert.equal(pickProviderId(routes, 'explore'), 'default', '未配置的回落默认槽');
  assert.equal(pickProviderId({}, 'mcp'), 'default', '空路由表回落默认槽');
});

test('能力键白名单与中文标签一一对应', () => {
  assert.equal(AI_CAPABILITIES.length, 6);
  for (const k of AI_CAPABILITIES) {
    assert.ok(CAPABILITY_LABEL[k], `${k} 应有中文标签`);
  }
});

test('isRouteEnabled: 通用能力默认开，仅显式 false 关闭（0015 语义）', () => {
  const empty = safeRoutes({});
  for (const k of AI_CAPABILITIES) {
    if (k === 'ai_tags') continue; // ai_tags 语义不同，单独测
    assert.equal(isRouteEnabled(empty, k), true, `${k} 空路由应默认开`);
  }
  const off = safeRoutes({ digest: { enabled: false }, explore: { enabled: false } });
  assert.equal(isRouteEnabled(off, 'digest'), false);
  assert.equal(isRouteEnabled(off, 'explore'), false);
  assert.equal(isRouteEnabled(safeRoutes({ digest: { enabled: true } }), 'digest'), true);
});

test('isRouteEnabled: ai_tags 是单开关且默认关，必须显式 true（0016）', () => {
  assert.equal(isRouteEnabled(safeRoutes({}), 'ai_tags'), false, '未配置 = 关，避免升级后全库自动打标烧额度');
  assert.equal(isRouteEnabled(safeRoutes({ ai_tags: {} }), 'ai_tags'), false, '只有 providerId 不算开');
  assert.equal(isRouteEnabled(safeRoutes({ ai_tags: { enabled: false } }), 'ai_tags'), false);
  assert.equal(isRouteEnabled(safeRoutes({ ai_tags: { enabled: true } }), 'ai_tags'), true);
  // 其它能力不受影响：ai_tags 关着，digest 仍默认开
  const mixed = safeRoutes({ ai_tags: { enabled: false } });
  assert.equal(isRouteEnabled(mixed, 'digest'), true);
});
