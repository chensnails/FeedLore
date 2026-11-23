/* 灯箱展示地址归一（纯函数，无 DOM 依赖）。
 * 列表用 currentSrc（缩略档）认「点的是哪张」，展示必须回大图档。 */

/** 把列表里选中的图片地址归一为灯箱展示地址。
 *  currentSrc 是列表缩略档（sizes=104px 实际选中 ?w=320），原样放大只会糊。
 *  代理图去掉 &w= 档位参数即为服务端默认大图键；外链图 / data URI 原样返回。 */
export function lightboxDisplaySrc(cur: string): string {
  if (!cur.startsWith('/api/img?')) return cur;
  return cur.replace(/&w=\d+(?=&|$)/, '');
}
