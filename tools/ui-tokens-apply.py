#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""UI 规范全量落地脚本（一次性）：
   1) padding / margin / gap 的 px 值归到 4px 栅格并换成 --sp-* 令牌
   2) --shadow* / --neu-shadow* 换成层级令牌 --elevation-* / --neu-*
   3) 动画时长换成 --dur-* 令牌
   4) .ico 系列上残留的 px 尺寸换成 rem（随字号偏好缩放）
只改样式取值，不改选择器与结构。
"""
import re
import io
import sys

PATH = 'public/style.css'

SP = {4: 1, 8: 2, 12: 3, 16: 4, 20: 5, 24: 6, 32: 7, 40: 8}
GRID = sorted(SP)

SHADOW_MAP = {
    '--shadow-sm': '--elevation-1',
    '--shadow': '--elevation-2',
    '--shadow-hover': '--elevation-3',
    '--shadow-lg': '--elevation-4',
    '--shadow-toast': '--elevation-toast',
}
NEU_MAP = {
    '--neu-shadow-sm': '--neu-1',
    '--neu-shadow': '--neu-2',
    '--neu-shadow-hover': '--neu-3',
    '--neu-shadow-inset': '--neu-inset',
}

src = io.open(PATH, encoding='utf-8').read()
orig = src

# ---------- 1) 阴影 / 拟态 令牌 ----------
# 注意：先长后短，避免 --shadow 抢在 --shadow-sm 前被替换
for old in sorted(SHADOW_MAP, key=len, reverse=True):
    src = src.replace('var(%s)' % old, 'var(%s)' % SHADOW_MAP[old])
for old in sorted(NEU_MAP, key=len, reverse=True):
    src = src.replace('var(%s)' % old, 'var(%s)' % NEU_MAP[old])

# ---------- 2) 间距栅格 ----------
def grid_of(v):
    if v <= 2:
        return None          # 2px 以内的微调保持原样
    if v > 40:
        return None          # 超出刻度的大间距保持原样
    # 取最近的刻度，平手向上
    best = min(GRID, key=lambda g: (abs(g - v), -g))
    return best

PROPS = ('padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
         'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
         'gap', 'row-gap', 'column-gap')

def repl_value(m):
    prop, val = m.group(1), m.group(2)
    def one(mm):
        num = int(mm.group(1))
        g = grid_of(num)
        return 'var(--sp-%d)' % SP[g] if g else mm.group(0)
    return '%s:%s' % (prop, re.sub(r'(\d+)px', one, val))

prop_alt = '|'.join(PROPS)
pattern = re.compile(r'(?<![-\w])(' + prop_alt + r')\s*:\s*([^;{}]+)')
src = pattern.sub(lambda m: repl_value(m), src)

# ---------- 3) 动画时长 ----------
src = src.replace('animation: ddFade .18s ease', 'animation: ddFade var(--dur-base) ease')
src = src.replace('animation: ddUp .22s cubic-bezier(.2, .8, .3, 1)',
                  'animation: ddUp var(--dur-slow) var(--ease)')
src = src.replace('animation: fadeIn .16s ease', 'animation: fadeIn var(--dur-base) ease')
src = src.replace('animation: lb-in .16s ease', 'animation: lb-in var(--dur-base) ease')

# ---------- 4) 图标 px → rem ----------
ICON_REM = [
    ('.dd-caret { width: 14px; height: 14px;', '.dd-caret { width: .875rem; height: .875rem;'),
    ('.dd-check { width: 15px; height: 15px;', '.dd-check { width: .9375rem; height: .9375rem;'),
    ('.dd-sheet-close .ico { width: 17px; height: 17px; }',
     '.dd-sheet-close .ico { width: 1.0625rem; height: 1.0625rem; }'),
    ('.card-media-actions .ico { width: 15px; height: 15px; }',
     '.card-media-actions .ico { width: .9375rem; height: .9375rem; }'),
    ('.drag-grip { width: 13px; height: 13px; }', '.drag-grip { width: .8125rem; height: .8125rem; }'),
    ('.dg-item-foot .icon-btn .ico { width: 16px; height: 16px; }',
     '.dg-item-foot .icon-btn .ico { width: 1rem; height: 1rem; }'),
    ('.rd-ch-add-ico { width: 18px; height: 18px;',
     '.rd-ch-add-ico { width: 1.125rem; height: 1.125rem;'),
    ('.cmdk-input-wrap .search-ico { width: 18px; height: 18px;',
     '.cmdk-input-wrap .search-ico { width: 1.125rem; height: 1.125rem;'),
    ('.cmdk-item .cmdk-ico { width: 18px; height: 18px;',
     '.cmdk-item .cmdk-ico { width: 1.125rem; height: 1.125rem;'),
]
for a, b in ICON_REM:
    if a in src:
        src = src.replace(a, b)
    else:
        print('[skip] 未匹配:', a, file=sys.stderr)

# ---------- 5) 分割线：虚线统一为实线 ----------
src = src.replace('border-top: 1px dashed var(--border);',
                  'border-top: var(--divider-w) solid var(--border);')
src = src.replace('border: 1px dashed var(--border-strong);',
                  'border: var(--divider-w) solid var(--border-strong);')
src = src.replace('border-top: 6px solid var(--text-muted);',
                  'border-top: var(--divider-w-strong) solid var(--border-strong);')

if src != orig:
    io.open(PATH, 'w', encoding='utf-8', newline='').write(src)
    print('已写入', PATH)
else:
    print('无改动')
