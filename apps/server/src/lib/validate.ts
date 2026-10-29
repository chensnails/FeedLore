/**
 * 契约校验工具：把 packages/contract 的 Zod schema 变成「运行时强制」。
 *
 * 分工：
 * - 请求（body/query）不符合契约 → 400，属于客户端问题，回执可带字段级提示。
 * - 响应不符合契约 → 500，属于服务端 bug（写错了字段/类型），绝不把内部细节抛给客户端，
 *   只在服务端日志里留痕。这正是 1.7.2 那类「读不存在字段」事故的编译期+运行期双重护栏。
 */

import type { z } from 'zod';

/** 契约违规（响应侧）= 服务端缺陷。 */
export class ContractViolation extends Error {
  readonly status = 500;
  readonly issues: unknown;
  constructor(what: string, issues: unknown) {
    super(`响应不符合契约：${what}`);
    this.name = 'ContractViolation';
    this.issues = issues;
  }
}

/** 请求不符合契约 = 客户端问题。 */
export class BadRequest extends Error {
  readonly status = 400;
  readonly issues: unknown;
  constructor(what: string, issues: unknown) {
    super(`请求不符合契约：${what}`);
    this.name = 'BadRequest';
    this.issues = issues;
  }
}

function issuesOf(err: z.ZodError): Array<{ path: string; message: string }> {
  return err.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message }));
}

/** 校验响应体；失败抛 ContractViolation（500）。 */
export function assertResponse<S extends z.ZodType>(
  schema: S,
  data: unknown,
  what: string,
): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = issuesOf(r.error);
    console.error('[contract] 响应校验失败', what, JSON.stringify(issues));
    throw new ContractViolation(what, issues);
  }
  return r.data as z.infer<S>;
}

/** 校验请求体；失败抛 BadRequest（400）。 */
export function parseBody<S extends z.ZodType>(schema: S, data: unknown, what: string): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new BadRequest(what, issuesOf(r.error));
  return r.data as z.infer<S>;
}
