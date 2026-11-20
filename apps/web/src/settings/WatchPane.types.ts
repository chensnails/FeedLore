/* 关注 / 屏蔽面板的表单与详情层类型：从 WatchPane.tsx 抽出，逐字等价。 */

import type { FilterRule, RuleScope, WatchRule } from '@feedlore/contract';

/** 表单草稿：keywords 摊成多行文本，scope 恒为规整后的对象。 */
export type RuleAct = WatchRule['act'];
export type RuleDraft = Omit<WatchRule, 'keywords' | 'scope'> & {
  keywords: string;
  scope: RuleScope;
};
export type FilterDraft = Omit<FilterRule, 'scope'> & { scope: RuleScope };
export type ResultState = { ok: boolean; msg: string } | null;
export type SheetState =
  | { type: 'rule'; value: RuleDraft; isNew: boolean }
  | { type: 'filter'; value: FilterDraft; isNew: boolean }
  | null;
