import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { extractTarGz, DEFAULT_EXTRACT_LIMITS } from './tar-read';
import { createTarGz } from './tar';

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'feedlore-tarread-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 手工拼一个 tar 块，用来构造导出器不会生成、但攻击者可能上传的包。 */
function rawBlock(name: string, data: Buffer, type = '0'): Buffer {
  const b = Buffer.alloc(512);
  b.write(name, 0, 100, 'utf8');
  b.write('0000644\0', 100, 8, 'ascii');
  b.write('0000000\0', 108, 8, 'ascii');
  b.write('0000000\0', 116, 8, 'ascii');
  b.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  b.write('00000000000\0', 136, 12, 'ascii');
  b.fill(' ', 148, 156);
  b.write(type, 156, 1, 'ascii');
  b.write('ustar\0', 257, 6, 'ascii');
  b.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of b) sum += byte;
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  const pad = (512 - (data.length % 512)) % 512;
  return Buffer.concat([b, data, Buffer.alloc(pad)]);
}

function rawArchive(entries: Array<{ name: string; data: Buffer; type?: string }>): Buffer {
  return gzipSync(Buffer.concat([...entries.map((e) => rawBlock(e.name, e.data, e.type)), Buffer.alloc(1024)]));
}

test('extractTarGz：与导出器往返，UTF-8 / 空文件 / 图片名都保留', async () => {
  await withTempDir(async (dir) => {
    const archive = join(dir, 'a.tar.gz');
    const out = join(dir, 'out');
    const ar = createTarGz();
    const chunks: Buffer[] = [];
    ar.readable.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<void>((resolve, reject) => {
      ar.readable.on('end', resolve);
      ar.readable.on('error', reject);
    });
    await ar.add('manifest.json', '{"kind":"user"}');
    await ar.add('entries-0001.jsonl', '条目一\n');
    await ar.add('images/abc123', Buffer.from([0, 1, 2]));
    await ar.add('prefs.json', '');
    await ar.close();
    await done;
    await writeFile(archive, Buffer.concat(chunks));

    const res = await extractTarGz(archive, out);
    assert.equal(res.files, 4);
    assert.equal(await readFile(join(out, 'manifest.json'), 'utf8'), '{"kind":"user"}');
    assert.equal(await readFile(join(out, 'entries-0001.jsonl'), 'utf8'), '条目一\n');
    assert.deepEqual([...await readFile(join(out, 'images', 'abc123'))], [0, 1, 2]);
    assert.equal((await readFile(join(out, 'prefs.json'))).length, 0);
  });
});

test('extractTarGz：路径穿越与未知文件名直接拒绝，且不落盘', async () => {
  await withTempDir(async (dir) => {
    const archive = join(dir, 'bad.tar.gz');
    const out = join(dir, 'out');
    await writeFile(archive, rawArchive([{ name: '../escape.json', data: Buffer.from('x') }]));

    await assert.rejects(
      () => extractTarGz(archive, out),
      (err: { code?: string }) => err.code === 'E_IMPORT_INVALID',
    );
    await assert.rejects(() => readFile(join(dir, 'escape.json')), /ENOENT/);
  });
});

test('extractTarGz：重复条目与目录项都拒绝', async () => {
  await withTempDir(async (dir) => {
    const out = join(dir, 'out');

    const dup = join(dir, 'dup.tar.gz');
    await writeFile(
      dup,
      rawArchive([
        { name: 'feeds.json', data: Buffer.from('[]') },
        { name: 'feeds.json', data: Buffer.from('[]') },
      ]),
    );
    await assert.rejects(
      () => extractTarGz(dup, out),
      (err: { code?: string }) => err.code === 'E_IMPORT_INVALID',
    );

    const dirEntry = join(dir, 'dir.tar.gz');
    await writeFile(dirEntry, rawArchive([{ name: 'images', data: Buffer.alloc(0), type: '5' }]));
    await assert.rejects(
      () => extractTarGz(dirEntry, out),
      (err: { code?: string }) => err.code === 'E_IMPORT_INVALID',
    );
  });
});

test('extractTarGz：单文件超限回 E_IMPORT_TOO_LARGE，截断包回 E_IMPORT_INVALID', async () => {
  await withTempDir(async (dir) => {
    const out = join(dir, 'out');

    const big = join(dir, 'big.tar.gz');
    await writeFile(big, rawArchive([{ name: 'entries-0001.jsonl', data: Buffer.alloc(2048) }]));
    await assert.rejects(
      () => extractTarGz(big, out, { ...DEFAULT_EXTRACT_LIMITS, maxFileBytes: 1024 }),
      (err: { code?: string }) => err.code === 'E_IMPORT_TOO_LARGE',
    );

    const truncated = join(dir, 'trunc.tar.gz');
    const full = rawArchive([{ name: 'feeds.json', data: Buffer.from('[]') }]);
    await writeFile(truncated, full.subarray(0, full.length - 20));
    await assert.rejects(
      () => extractTarGz(truncated, out),
      (err: { code?: string }) => err.code === 'E_IMPORT_INVALID' || err.code === 'E_IMPORT_TOO_LARGE',
    );
  });
});
