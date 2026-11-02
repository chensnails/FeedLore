/**
 * 角色归一化：库里的 role 是 text，历史值只有 admin/user，也可能被手工改成
 * 任意字符串。对外一律收窄成契约里的三种角色，未知值按普通用户兜底。
 */

import type { Role } from '@feedlore/contract';

export function normalizeRole(value: string | null | undefined): Role {
  return value === 'admin' || value === 'readonly' ? value : 'user';
}
