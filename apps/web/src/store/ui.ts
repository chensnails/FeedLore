import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * 纯前端 UI 状态（与服务端无关）：当前选中的分组、是否只看未读。
 *
 * 分工铁律：
 * - 服务端数据（会话、频道、条目）→ TanStack Query，**不进这里**；
 * - 只影响「怎么显示」的偏好 → 这里，且持久化到 localStorage。
 * v1.x 的 `state` 之所以难维护，就是因为这两类混在一个可变对象里。
 */
interface UiState {
  /** 选中的分组名；null = 全部 */
  group: string | null;
  onlyUnread: boolean;
  setGroup: (g: string | null) => void;
  toggleOnlyUnread: () => void;
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      group: null,
      onlyUnread: false,
      setGroup: (group) => set({ group }),
      toggleOnlyUnread: () => set((s) => ({ onlyUnread: !s.onlyUnread })),
    }),
    { name: 'feedlore.ui' },
  ),
);
