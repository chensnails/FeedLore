/* 设置弹层「模型」面板（2026-11-18 按 0017 厂商 / 模型两层重构）。
 *
 * 页面只讲三件事，顺序就是使用顺序：
 *   ① 模型接入：厂商是折叠组，模型缩进挂在厂商下（与 Cherry Studio / LobeChat 一致）；
 *      地址与 Key 只在厂商详情里维护，多个模型共用一份；
 *   ② 任务分配：哪项能力用哪个模型，关闭即服务端硬拦；
 *   ③ 运行状态（默认折叠）：最近调用、历史与用量，参考信息不抢版面。
 *
 * 生效方式：全部即改即生效。列表行只做展示与快捷动作，编辑收进 DetailSheet
 * （桌面右侧抽屉 / 移动端底部弹层），与数据源、规则、账号面板同一套交互。
 * 没有底部保存按钮 —— 模型配置没有「整页草稿」，不会出现「改了一半没保存」。
 *
 * data-sec 锚点：llm-access（模型接入）、llm-capabilities（任务分配）、
 * llm-status + llm-usage（运行状态）。
 *
 * 拆分为同目录模块：ModelPane.utils.ts（纯函数/类型）、ModelPane.state.ts（Query 状态）、
 * ModelPane.sections.tsx（两大 JSX 区块）、ModelPane.sheets.tsx（模型/厂商详情层）。
 */

import type { LlmModelView, LlmVendorView } from '@feedlore/contract';
import { modelLabel, TaskAssignments } from './AiCapabilities.tsx';
import { ModelAccessList, ModelStatusSection } from './ModelPane.sections.tsx';
import { ModelSheet, VendorSheet } from './ModelPane.sheets.tsx';
import { useModelPaneState } from './ModelPane.state.ts';
import { fmtRel, S, USAGE_KINDS } from './ModelPane.utils.ts';
import { PaneFoot, Result, Section } from './primitives.tsx';

export function ModelPane({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const c = useModelPaneState(onDirtyChange);
  const { vendors, models, loaded, loadError, busy, msg, ai } = c;
  const { sheet, setSheet, pendingModel, setPendingModel, openGroups, setOpenGroups } = c;
  const {
    usage,
    usageBusy,
    requests,
    reqError,
    reqBusy,
    reqLimit,
    setReqLimit,
    keepInfo,
    statusResult,
    showStatusResult,
    loadRequests,
    refreshAll,
  } = c;

  const defaultModel = models.find((m: LlmModelView) => m.isDefault) || models[0] || null;

  /* ---- 运行状态：只用本地记录推断，不额外打一次模型（看状态不烧 token） ---- */
  const recent = Array.isArray(requests) ? requests : [];
  const lastReq = recent[0] || null;
  const status = (() => {
    if (!defaultModel)
      return { cls: 'is-off', label: '未配置', detail: '先添加厂商与模型才能调用' };
    if (!defaultModel.model)
      return { cls: 'is-off', label: '未配置', detail: '默认模型还没填上游模型名' };
    if (!defaultModel.apiKeySet)
      return { cls: 'is-off', label: '缺少 Key', detail: '默认模型所属厂商还没有 API Key' };
    if (requests === null && !reqError) return { cls: 'is-idle', label: '读取中…', detail: '' };
    if (reqError && !recent.length) return { cls: 'is-fail', label: '状态未知', detail: reqError };
    if (!lastReq)
      return {
        cls: 'is-idle',
        label: '未测试',
        detail: '还没有调用记录，可以点「测试默认模型」先验一次',
      };
    if (lastReq.ok) {
      return {
        cls: 'is-ok',
        label: '可用',
        detail: `最近一次成功 · ${fmtRel(lastReq.createdAt)} · ${USAGE_KINDS[lastReq.kind] || lastReq.kind}`,
      };
    }
    return {
      cls: 'is-fail',
      label: '最近失败',
      detail: `${fmtRel(lastReq.createdAt)} · ${S().errText(lastReq.error || '', '调用失败')}`,
    };
  })();
  const avgMs = (() => {
    const ok = recent.filter(/** @param {*} [r] */ (r) => r.ok && Number(r.durationMs) > 0);
    if (!ok.length) return 0;
    return Math.round(
      ok.reduce(/** @param {*} [a] @param {*} [r] */ (a, r) => a + Number(r.durationMs), 0) /
        ok.length,
    );
  })();
  const todayCalls = usage?.today?.calls || 0;
  const todayFails = usage?.today?.fails || 0;
  const reqLoading = requests === null && !reqError;

  async function testDefault() {
    const r = await ai.testModel();
    showStatusResult(r.ok, r.text);
    loadRequests();
  }

  const openRow = (kind: 'model' | 'vendor', id: string | null) => setSheet({ kind, id });

  const currentModel =
    sheet && sheet.kind === 'model' && sheet.id
      ? models.find((m: LlmModelView) => m.id === sheet.id) || null
      : null;
  const currentVendor =
    sheet && sheet.kind === 'vendor' && sheet.id
      ? vendors.find((v: LlmVendorView) => v.id === sheet.id) || null
      : null;
  const autoOpenVendorId = (defaultModel && defaultModel.vendorId) || vendors[0]?.id || '';
  const accessSub = !loaded
    ? '读取中…'
    : vendors.length
      ? `${vendors.length} 个厂商 · ${models.length} 个模型` +
        (defaultModel ? ` · 默认 ${modelLabel(defaultModel)}` : '')
      : '未配置';

  return (
    <div className="tab-pane" data-pane="model" ref={c.paneRef}>
      <div className="pane-scroll">
        {loadError ? (
          <div className="hint pane-msg lg" role="alert">
            {loadError}
            <button type="button" className="btn btn-ghost btn-sm ml-3" onClick={ai.load}>
              重试
            </button>
          </div>
        ) : null}
        {msg ? <Result id="llmResult" result={{ ok: msg.ok, msg: msg.text }} /> : null}

        {/* ---------- ① 模型接入：厂商折叠组，模型缩进挂在厂商下 ---------- */}
        <Section secKey="llm-access" title="模型接入" sub={accessSub} open>
          <ModelAccessList
            ai={ai}
            loaded={loaded}
            openGroups={openGroups}
            setOpenGroups={setOpenGroups}
            autoOpenVendorId={autoOpenVendorId}
            onOpenRow={openRow}
            onAddModelToVendor={(vendorId: string) =>
              setSheet({ kind: 'model', id: null, vendorId })
            }
          />
        </Section>

        {/* ---------- ② 任务分配 ---------- */}
        <Section secKey="llm-capabilities" title="任务分配" sub="能力开关与模型" open>
          <TaskAssignments ai={ai} />
        </Section>

        {/* ---------- ③ 运行状态（默认折叠） ---------- */}
        <Section
          secKey="llm-status"
          title="运行状态"
          sub={status.label + (lastReq ? ' · ' + fmtRel(lastReq.createdAt) : '')}
        >
          <ModelStatusSection
            status={status}
            defaultModel={defaultModel}
            busy={busy}
            testDefault={testDefault}
            statusResult={statusResult}
            avgMs={avgMs}
            todayCalls={todayCalls}
            todayFails={todayFails}
            keepInfo={keepInfo}
            reqLimit={reqLimit}
            setReqLimit={setReqLimit}
            reqBusy={reqBusy}
            usageBusy={usageBusy}
            refreshAll={refreshAll}
            requests={requests}
            reqError={reqError}
            reqLoading={reqLoading}
            usage={usage}
            loadRequests={loadRequests}
          />
        </Section>
      </div>

      <PaneFoot
        lead={
          <span className="hint">
            模型配置跟随账号：只对你自己生效，不会用上别人的地址或 Key。所有修改即改即生效。
          </span>
        }
      />

      {sheet && sheet.kind === 'model' ? (
        <ModelSheet
          ai={ai}
          model={sheet.id ? currentModel : null}
          initialVendorId={sheet.vendorId || ''}
          onClose={() => setSheet(null)}
          onNeedVendor={() => {
            setPendingModel(true);
            setSheet({ kind: 'vendor', id: null });
          }}
        />
      ) : null}

      {sheet && sheet.kind === 'vendor' ? (
        <VendorSheet
          ai={ai}
          vendor={sheet.id ? currentVendor : null}
          onClose={() => {
            setPendingModel(false);
            setSheet(null);
          }}
          onSaved={() => {
            const wantModel = pendingModel;
            setPendingModel(false);
            setSheet(wantModel ? { kind: 'model', id: null } : null);
          }}
        />
      ) : null}
    </div>
  );
}
