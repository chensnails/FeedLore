import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { createTarGz } from './tar';

/** 最小 tar 解析器：只认本文件写出来的 ustar 结构，用于验证往返。 */
function parseTar(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let off = 0;
  while (off + 512 <= buf.length) {
    const block = buf.subarray(off, off + 512);
    if (block.every((b) => b === 0)) {
      // 归档结束：要求紧跟第二个全零块
      const next = buf.subarray(off + 512, off + 1024);
      assert.ok(next.length === 0 || next.every((b) => b === 0), '结束标记应为两个全零块');
      return out;
    }
    const name = block.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = Number.parseInt(block.subarray(124, 136).toString('ascii').replace(/\0.*$/, ''), 8);
    assert.ok(Number.isFinite(size), `无法解析 ${name} 的 size`);
    // 校验和：字段替换为空格后求和，应与头里写的一致
    const declared = Number.parseInt(block.subarray(148, 156).toString('ascii').replace(/\0.*$/, '').trim(), 8);
    const copy = Buffer.from(block);
    copy.fill(32, 148, 156);
    let sum = 0;
    for (const b of copy) sum += b;
    assert.equal(declared, sum, `${name} 的头校验和不对`);
    out.set(name, buf.subarray(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  assert.fail('归档缺少结束标记');
}

async function collect(readable: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

test('tar.gz：两个条目能原样读回（含跨块与空文件）', async () => {
  const ar = createTarGz(Date.UTC(2026, 10, 4));
  const long = 'x'.repeat(1300); // 故意跨过 512 边界，验证补零
  const cn = '中文内容也要能往返';
  await ar.add('manifest.json', '{"format":"test"}');
  await ar.add('entries-0001.jsonl', long);
  await ar.add('empty.txt', '');
  await ar.close();

  const raw = gunzipSync(await collect(ar.readable));
  assert.equal(raw.length % 512, 0, 'tar 应始终按 512 字节对齐');
  const files = parseTar(raw);
  assert.deepEqual([...files.keys()], ['manifest.json', 'entries-0001.jsonl', 'empty.txt']);
  assert.equal(files.get('manifest.json')?.toString('utf8'), '{"format":"test"}');
  assert.equal(files.get('entries-0001.jsonl')?.toString('utf8'), long);
  assert.equal(files.get('empty.txt')?.length, 0);

  const cnAr = createTarGz();
  await cnAr.add('note.txt', cn);
  await cnAr.close();
  const cnFiles = parseTar(gunzipSync(await collect(cnAr.readable)));
  assert.equal(cnFiles.get('note.txt')?.toString('utf8'), cn);
});

test('tar.gz：拒绝穿越路径与超长文件名', async () => {
  const ar = createTarGz();
  await assert.rejects(() => ar.add('../etc/passwd', 'x'), /unsafe/);
  await assert.rejects(() => ar.add('/abs.txt', 'x'), /unsafe/);
  await assert.rejects(() => ar.add('a/../../b', 'x'), /unsafe/);
  await assert.rejects(() => ar.add('n'.repeat(101), 'x'), /1\.\.100 bytes/);
  await assert.rejects(() => ar.add('', 'x'), /1\.\.100 bytes/);
  // 读端必须先挂 error 监听（HTTP 响应那边同理），否则 destroy(err) 会变成未捕获异常
  ar.readable.on('error', () => {});
  ar.abort(new Error('test done'));
});

test('tar.gz：close 之后的写入直接报错，重复 close 无害', async () => {
  const ar = createTarGz();
  await ar.add('a.txt', 'a');
  await ar.close();
  await ar.close();
  await assert.rejects(() => ar.add('b.txt', 'b'), /already closed/);
});
