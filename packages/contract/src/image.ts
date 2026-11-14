/**
 * 外链图片 → 展示地址（本站 `/api/img` 代理）。
 *
 * 为什么放在契约包：条目卡片（apps/server 的 `toCard`）与日报条目（packages/ai）
 * 都必须给出**同一个**图片地址，否则同一个源图在卡片页能显示、在日报里 404
 * —— 这类「同一个字段两套写法」正是 1.7.x 的老毛病，所以只留这一份实现。
 *
 * 为什么必须改写成本站代理：源站防盗链按 Referer 拦直连、混合内容被浏览器拦、
 * 部分 CDN 地址带短时效签名 —— 三者任一都会让缩略图变白块 / 死图。
 *
 * 两条边界（都来自 legacy 的线上踩坑）：
 *  1. **`data:` 直通**：RSSHub 之类会给内嵌 base64 图标，它本身就是完整资源。
 *     塞进代理只会被 `new URL()` 判成非法协议返回 400，表现为「整列图标全空」（v2.2.5）。
 *  2. **重复协议头归一**：个别源写成 `https:https://...`，不修的话解析出的主机名是 "https:"。
 *
 * v2 新增：支持 `base` 补全**相对地址**（`/logo.png`）。legacy 直接把相对地址塞进代理，
 * 代理端必然 400；这里用条目落地页或频道站点地址补全，补不出来才丢弃。
 */

const proxied = (u: string): string => '/api/img?u=' + encodeURIComponent(u);

export function imgUrl(u: string | null | undefined, base?: string | null): string | null {
  const v = typeof u === 'string' ? u.trim() : '';
  if (!v) return null;
  if (/^data:/i.test(v)) return v;

  const fixed = v.replace(/^(https?):\1:\/\//i, '$1://');
  // 非 http(s) 绝对地址 → 尝试用 base 补全（相对路径走这条）
  let abs = fixed;
  if (!/^https?:\/\//i.test(abs)) {
    try {
      abs = new URL(fixed, base ?? undefined).toString();
    } catch {
      return null; // 既不是绝对地址、也没有可用的 base → 丢掉（比给前端一个必 400 的链接好）
    }
  }
  if (!/^https?:\/\//i.test(abs)) return null;
  return proxied(abs);
}
