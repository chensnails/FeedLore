#!/usr/bin/env node
// deploy.sh 护栏静态校验（v2.2.2 起）
//
// 背景：v2.2.1 那次 imgCache 事故——容器正常启动、健康检查通过、启动日志干净、
// 前后端测试全绿，但每个 /api/img 请求都抛 ReferenceError。健康检查只证明
// 「进程活着」，不证明「业务路径没炸」。
//
// 因此 deploy.sh 加了「启动期错误日志扫描」。这个脚本钉住那道护栏不被误删，
// 同时守住两个容易踩的坑：
//   1. 健康检查成功后必须扫日志，不能直接 exit 0；
//   2. 扫到错误必须以非零码退出（部署视为失败），而不是打个 warning 继续上线。

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'deploy.sh');
const src = fs.readFileSync(FILE, 'utf8');

const checks = [
  {
    name: '存在启动期错误日志扫描',
    test: () => /docker compose logs --since/.test(src),
  },
  {
    name: '错误扫描覆盖运行时错误关键词',
    test: () => {
      const need = ['ReferenceError', 'TypeError', 'MODULE_NOT_FOUND', 'unhandled', 'uncaught'];
      return need.every((k) => src.includes(k));
    },
  },
  {
    name: '健康检查通过后不直接 exit 0',
    test: () => {
      const hit = src.indexOf('健康检查通过');
      assert(hit >= 0, '未找到健康检查通过分支');
      const tail = src.slice(hit, hit + 200);
      return !/健康检查通过[^\n]*\n\s*exit 0/.test(tail);
    },
  },
  {
    name: '扫到错误以非零码退出',
    test: () => /echo "\$errs" >&2\s*\n\s*exit 2\b/.test(src),
  },
  {
    name: '超时路径仍以非零码退出',
    test: () => /健康检查超时[\s\S]{0,120}exit 1/.test(src),
  },
];

let failed = 0;
for (const c of checks) {
  let ok = false;
  try {
    ok = c.test();
  } catch (e) {
    ok = false;
  }
  console.log(`${ok ? 'PASS' : 'FAIL'}  deploy 护栏 · ${c.name}`);
  if (!ok) failed++;
}

console.log(`\ndeploy 护栏：${checks.length - failed}/${checks.length} 通过`);
process.exit(failed ? 1 : 0);

// 供上面的闭包使用（在模块顶层声明，避免 TDZ 报undefined）
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}