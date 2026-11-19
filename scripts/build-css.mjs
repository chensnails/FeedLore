/**
 * CSS 分片构建：把 src/styles/ 下按关注点拆分的分片，按固定顺序聚合成
 * src/style.css 与 src/hig.css，供 Vite / 首屏骨架插件 / UI 守卫读取。
 *
 * 为什么聚合产物必须字节级等于历史单文件：
 *  - vite.config.ts 的 inlineCriticalShell 从 style.css 正则抽取首屏骨架；
 *  - apps/web/tests/ui/ui-regression.cjs 有 73 项守卫直接匹配 CSS 字面文本，
 *    其中若干项锚定精确缩进（如 /^ {2}--tabbar-h: 48px;$/m）；
 *  - style.css 自述「断点按功能就近分散，收成一段会改变层叠结果（实测 181 处偏差）」，
 *    因此分片只能按原物理顺序切片，不允许按组件重排。
 *
 * 用法：
 *   node scripts/build-css.mjs --bootstrap   # 一次性：从现有单文件切出分片
 *   node scripts/build-css.mjs               # 从分片聚合生成单文件
 *   node scripts/build-css.mjs --check       # CI：校验聚合结果与提交的单文件一致
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const WEB = path.resolve(import.meta.dirname, '../apps/web');
const SRC = path.join(WEB, 'src');
const STYLES = path.join(SRC, 'styles');

/**
 * 分片清单：[文件名, 起始内容行, 结束内容行]，1-based 闭区间。
 * 行号来自原单文件的分节注释边界，保证拼接后字节完全一致。
 */
const PLANS = {
  'style.css': {
    dir: 'style',
    parts: [
      ['01-shell-theme.css', 1, 582],
      ['02-controls.css', 583, 965],
      ['03-cards-list.css', 966, 1605],
      ['04-settings.css', 1606, 2625],
      ['05-ai-explore.css', 2626, 3505],
      ['06-reader.css', 3506, 4593],
      ['07-responsive.css', 4594, 4918],
      ['08-overlays.css', 4919, 5533],
      ['09-shell-components.css', 5534, 6138],
      ['10-mobile.css', 6139, 6779],
    ],
  },
  'hig.css': {
    dir: 'hig',
    parts: [
      ['01-tokens.css', 1, 68],
      ['02-base.css', 69, 103],
      ['03-controls.css', 104, 199],
      ['04-content.css', 200, 243],
      ['05-nav.css', 244, 296],
      ['06-overlays.css', 297, 318],
      ['07-feedback.css', 319, 335],
      ['08-motion-a11y.css', 336, 382],
      ['09-settings.css', 383, 449],
    ],
  },
};

/** 读取为「纯内容行」数组：统一 LF、去掉末尾换行后 split。 */
function contentLines(file) {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
}

/**
 * 聚合输出统一 LF，末尾保留一个换行。
 *
 * 仓库里 style.css / hig.css 的 blob 是 LF（git 以 LF 存）；本地 Windows 因
 * core.autocrlf=true 在 checkout 时转成 CRLF，CI 的 Linux runner 则是 LF 原样。
 * 因此比较必须行尾无关（见 normalize），输出用 LF 与 blob 对齐，避免跨平台漂移。
 */
function serialize(lines) {
  return `${lines.join('\n')}\n`;
}

/** 行尾无关比较：把 CRLF 归一成 LF。 */
function normalize(s) {
  return s.replace(/\r\n/g, '\n');
}

function bootstrap() {
  for (const [target, plan] of Object.entries(PLANS)) {
    const lines = contentLines(path.join(SRC, target));
    const dir = path.join(STYLES, plan.dir);
    mkdirSync(dir, { recursive: true });
    for (const [name, from, to] of plan.parts) {
      const part = lines.slice(from - 1, to);
      writeFileSync(path.join(dir, name), `${part.join('\n')}\n`, 'utf8');
    }
    process.stdout.write(`bootstrap ${target}: ${plan.parts.length} 分片\n`);
  }
}

function aggregate(write) {
  const results = {};
  for (const [target, plan] of Object.entries(PLANS)) {
    const lines = [];
    for (const [name] of plan.parts) {
      lines.push(...contentLines(path.join(STYLES, plan.dir, name)));
    }
    const out = serialize(lines);
    results[target] = out;
    if (write) writeFileSync(path.join(SRC, target), out, 'utf8');
  }
  return results;
}

function check() {
  let ok = true;
  const results = aggregate(false);
  for (const [target, expected] of Object.entries(results)) {
    const actual = normalize(readFileSync(path.join(SRC, target), 'utf8'));
    if (actual === normalize(expected)) {
      process.stdout.write(
        `OK ${target} 与分片聚合结果一致（${Buffer.byteLength(actual)} bytes）\n`,
      );
    } else {
      ok = false;
      process.stderr.write(
        `FAIL ${target} 与分片聚合结果不一致，请运行 node scripts/build-css.mjs\n`,
      );
    }
  }
  process.exitCode = ok ? 0 : 1;
}

const arg = process.argv[2];
if (arg === '--bootstrap') bootstrap();
else if (arg === '--check') check();
else aggregate(true);
