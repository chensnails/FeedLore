/* 设置弹层「状态」面板（原 app.js 的 renderStatus/loadStatusForm 迁移至此）。
 *
 * 迁移说明（对照旧实现）：
 * - 只读体检页，数据来自 GET /api/status 一次快照；停留时每 30s 自动拉一次，
 *   「已运行时长」在本地每秒递增（不必每秒发请求）；
 * - 轮询与递增定时器随组件挂载 / 卸载自洽启停（旧 startStatusPolling/stopStatusPolling 退役）；
 * - 「复制诊断」把快照拍平成纯文本（buildDiagnostics 迁移），带剪贴板降级兜底；
 * - 异常频道「重试」逐个抓取并刷新快照；
 * - 状态页每 30s 重绘，重绘后重新套上可折叠分组的展开态（经桥 bindSections 复用旧机制）；
 * - 类名与旧 DOM 完全一致，样式零改动。
 *
 * 拆分为同目录模块：StatusPane.types.ts / StatusPane.utils.ts / StatusPane.controller.ts /
 * StatusPane.sections.tsx。
 */

import { useStatusController } from './StatusPane.controller.ts';
import { StatusBody, StatusErrorPane, StatusFoot, StatusLoading } from './StatusPane.sections.tsx';

export function StatusPane() {
  const c = useStatusController();

  if (!c.data) return <StatusLoading c={c} />;
  if ('__error' in c.data) return <StatusErrorPane c={c} error={c.data.__error} />;

  return (
    <div className="tab-pane" data-pane="status" ref={c.paneRef}>
      <div className="status-body" id="statusBody">
        <StatusBody c={c} snapshot={c.data} />
      </div>
      <StatusFoot c={c} />
    </div>
  );
}
