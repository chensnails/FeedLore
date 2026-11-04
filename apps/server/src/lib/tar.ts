/**
 * 极简 ustar + gzip 流式归档（零依赖）。
 *
 * 为什么不用 zip：Node 没有内置 zip 写入，引第三方包只为一个导出功能不划算；tar 头
 * 是纯文本偏移结构，自己写反而更可控，Windows 10+ 与各类解压工具都能直接展开。
 *
 * 约定：
 * - 每个条目必须**先知道字节数**（tar 头里要写 size）。调用方按批生成 JSONL，
 *   不把整张表拼成一个字符串，内存占用只跟一批的行数有关。
 * - 文件名限 100 字节 ASCII 且不含 `..`；名字都是服务端生成的，这条只是防御。
 * - 单文件上限 8 GiB（12 位八进制 + 结尾 NUL）。图片与批次都远小于此。
 * - 写入用 write 回调串行化，天然带背压：没人读响应时不会把整包攒进内存。
 */

import type { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';

const BLOCK = 512;
const MAX_FILE_BYTES = 8 * 1024 ** 3 - 1;
const NAME_MAX_BYTES = 100;

export interface TarGzArchive {
  /** 交给 HTTP 响应体；消费多少推多少。 */
  readable: Readable;
  /** 追加一个文件（内容已完整在内存里）。 */
  add(name: string, data: Buffer | string): Promise<void>;
  /** 写结束标记并关闭 gzip。 */
  close(): Promise<void>;
  /** 中途失败时让读端拿到错误，而不是静默截断。 */
  abort(err: Error): void;
}

function assertName(name: string): void {
  const bytes = Buffer.byteLength(name, 'utf8');
  if (!name || bytes > NAME_MAX_BYTES) {
    throw new Error(`tar entry name must be 1..${NAME_MAX_BYTES} bytes: ${name}`);
  }
  if (name.startsWith('/') || name.split('/').includes('..') || name.includes('\0')) {
    throw new Error(`tar entry name is unsafe: ${name}`);
  }
}

function header(name: string, size: number, mtimeSec: number): Buffer {
  const b = Buffer.alloc(BLOCK);
  b.write(name, 0, NAME_MAX_BYTES, 'utf8');
  // mode / uid / gid：0644、0、0（末尾 NUL 是八进制字段的终止符）
  b.write('0000644\0', 100, 8, 'ascii');
  b.write('0000000\0', 108, 8, 'ascii');
  b.write('0000000\0', 116, 8, 'ascii');
  b.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  b.write(mtimeSec.toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii');
  // 校验和字段先填 8 个空格参与计算，再写回 6 位八进制 + NUL + 空格
  b.fill(' ', 148, 156);
  b.write('0', 156, 1, 'ascii');
  // ustar magic + version：解压工具据此识别格式，缺了会被当成 v7 tar
  b.write('ustar\0', 257, 6, 'ascii');
  b.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of b) sum += byte;
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return b;
}

export function createTarGz(now = Date.now()): TarGzArchive {
  const gzip = createGzip({ level: 6 });
  const mtimeSec = Math.floor(now / 1000);
  let closed = false;

  const write = (chunk: Buffer) =>
    new Promise<void>((resolve, reject) => {
      gzip.write(chunk, (err) => (err ? reject(err) : resolve()));
    });

  return {
    readable: gzip,
    async add(name, data) {
      if (closed) throw new Error('archive already closed');
      assertName(name);
      const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      if (buf.length > MAX_FILE_BYTES) {
        throw new Error(`tar entry too large for ustar: ${name} (${buf.length} bytes)`);
      }
      await write(header(name, buf.length, mtimeSec));
      if (buf.length > 0) await write(buf);
      const pad = (BLOCK - (buf.length % BLOCK)) % BLOCK;
      if (pad > 0) await write(Buffer.alloc(pad));
    },
    async close() {
      if (closed) return;
      closed = true;
      // 两个全零块 = 归档结束
      await write(Buffer.alloc(BLOCK * 2));
      await new Promise<void>((resolve, reject) => {
        gzip.once('error', reject);
        gzip.end(resolve);
      });
    },
    abort(err) {
      closed = true;
      gzip.destroy(err);
    },
  };
}
