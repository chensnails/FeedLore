import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * 纯前端 UI 状态（与服务端无关）：选中频道、只看未读、正在阅读的条目。
 *
 * 分工铁律：
 * - 服务端数据（会话、频道、条目、偏好）→ TanStack Query，**不进这里**；
 * - 只影响「怎么显示」的选择 → 这里，且持久化到 localStorage。
 * v1.x 的 `state` 之所以难维护，就是因为这两类混在一个可变对象里。
 */
interface UiState {
  /** 选中的频道 id（字符串，与契约一致）；null = 全部频道 */
  feedId: string | null;
  onlyUnread: boolean;
  /** 正在阅读的条目 id；null = 未打开阅读层 */
  readingId: string | null;
  setFeedId: (id: string | null) => void;
  toggleOnlyUnread: () => void;
  openEntry: (id: string) => void;
  closeEntry: () => void;
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      feedId: null,
      onlyUnread: false,
      readingId: null,
      setFeedId: (feedId) => set({ feedId }),
      toggleOnlyUnread: () => set((s) => ({ onlyUnread: !s.onlyUnread })),
      openEntry: (readingId) => set({ readingId }),
      closeEntry: () => set({ readingId: null }),
    }),
    {
      name: 'feedlore.ui',
      // 阅读层是瞬时状态，刷新后不该自动弹回来
      partialize: (s) => ({ feedId: s.feedId, onlyUnread: s.onlyUnread }),
    },
  ),
);
