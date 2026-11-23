import assert from 'node:assert/strict';
import test from 'node:test';

/* 灯箱展示地址归一：列表用 currentSrc（缩略档）认图，展示必须回大图档。 */
const { lightboxDisplaySrc } = await import('../src/core/lightboxSrc.ts');

test('灯箱：代理图去掉 &w= 档位，展示走服务端默认大图键', () => {
  const thumb = '/api/img?u=https%3A%2F%2Fex.com%2Fa.jpg&w=320';
  const full = '/api/img?u=https%3A%2F%2Fex.com%2Fa.jpg';
  assert.equal(lightboxDisplaySrc(thumb), full);
});

test('灯箱：w 在中间或末尾都能去掉，且不误伤 u 参数里的 &w 字样', () => {
  assert.equal(lightboxDisplaySrc('/api/img?u=x&w=640&r=1'), '/api/img?u=x&r=1');
  assert.equal(lightboxDisplaySrc('/api/img?u=x&w=960'), '/api/img?u=x');
  // 编码后的 u 里即使含 &w= 字面串也不该动（编码后应是 %26w%3D，这里验证只删顶层档位参数）
  assert.equal(lightboxDisplaySrc('/api/img?u=a%26w%3D5&w=320'), '/api/img?u=a%26w%3D5');
});

test('灯箱：外链原图 / data URI / 空值原样返回（不造新缓存键）', () => {
  assert.equal(lightboxDisplaySrc('https://ex.com/a.jpg'), 'https://ex.com/a.jpg');
  assert.equal(lightboxDisplaySrc('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(lightboxDisplaySrc(''), '');
});

test('灯箱：无 w 的代理图地址保持不变', () => {
  assert.equal(lightboxDisplaySrc('/api/img?u=x'), '/api/img?u=x');
});
