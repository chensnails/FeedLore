/**
 * 服务端统一日志入口（V3.3，pino）。
 *
 * 之前散落的 console.* 没有级别、没有时间戳、也没有请求关联 ID：线上排障时
 * 只能靠文案前缀猜是哪次请求。这里提供：
 * - 单一 logger：级别由 LOG_LEVEL 控制（默认 info），时间 ISO 8601；
 * - requestId：由 app.ts 的中间件放进 AsyncLocalStorage，异步链路里自动带上；
 * - 输出格式：默认 JSON（机器可读）；LOG_PRETTY=1 时走 pino-pretty（人工排障）。
 *
 * 不在这里读业务配置，避免形成 env.ts <- logger.ts <- 其他模块的循环依赖。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { format } from 'node:util';
import pino, { type Logger } from 'pino';

export interface LogContext {
  requestId?: string;
}

export const logContext = new AsyncLocalStorage<LogContext>();

const level = process.env.LOG_LEVEL || 'info';
const pretty = process.env.LOG_PRETTY === '1';

const base: Logger = pino({
  level,
  base: { service: 'feedlore' },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(pretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: false, ignore: 'service,hostname,pid', translateTime: 'SYS:HH:MM:ss' },
        },
      }
    : {}),
});

type Level = 'info' | 'warn' | 'error' | 'debug';

function emit(lvl: Level, args: unknown[]): void {
  const store = logContext.getStore();
  const logger = store?.requestId ? base.child({ requestId: store.requestId }) : base;
  // 兼容原 console.* 的多参数写法：console.error('failed:', err) 会把 err 拼进消息，
  // 而 pino 只把第二个参数当插值用（没有 %s 时直接丢弃）。先 format 再交给 pino，
  // 保证这次迁移不悄悄丢掉任何一行排障信息。对象打头的调用按 pino 原生语义走。
  const normalized = typeof args[0] === 'string' && args.length > 1 ? [format(...(args as [string, ...unknown[]]))] : args;
  (logger[lvl] as (...a: unknown[]) => void)(...normalized);
}

/** console.* 的直接替代品；参数形状与 pino 一致（对象在前、消息在后）。 */
export const log = {
  info: (...args: unknown[]) => emit('info', args),
  warn: (...args: unknown[]) => emit('warn', args),
  error: (...args: unknown[]) => emit('error', args),
  debug: (...args: unknown[]) => emit('debug', args),
};

/** 给 doctor / CLI 用的原始 logger（无 ALS 上下文）。 */
export const rootLogger = base;
