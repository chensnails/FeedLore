/**
 * 前端全局扩展声明（V3.1 类型化）。
 *
 * 这些 window.__* 由 index.html 首屏内联脚本注入，或被 kernel/bridge.ts 作为
 * 命令式桥接点写入（React 宿主、测试驱动、旧代码依赖）。它们是有意为之的
 * "逃生口"，不进入 React 数据流，这里只做类型声明、不改变运行时行为。
 */

declare global {
  interface Window {
    /** 服务端注入的首屏布局偏好（users.prefs.layout），见 state.js#layoutPref */
    __LAYOUT__?: unknown;
    /** 首屏启动层（index.html 同步内联脚本注入，运行时必定存在） */
    __boot: {
      ready(): void;
      tip(text: string): void;
      fail(text: string): void;
    };
    /** 外观切换事件回流标记，见 AppearancePane.tsx */
    __appearanceChanged?: unknown;
    /** 「/」聚焦卡墙搜索的委托函数，见 CardsView.tsx */
    __cardsFocusSearch?: (() => void) | null;
    /** 设置抽屉 React 宿主桥接，见 kernel/bridge.ts */
    __settingsHost?: unknown;
    /** 设置抽屉开合状态，见 state.ts / kernel/bridge.ts */
    __settingsOpen?: boolean;
    /** 首屏主题模式，见 index.html 内联脚本 */
    __themeBoot?: unknown;
    /** 全局错误文案函数，见 login-main.ts（登录页独立文档） */
    errText?: (input: unknown, fallbackText?: string) => string;
    /** 网络超时单一口径，见 login-main.ts / util.fetch.ts（登录与改密独立文档共用） */
    netTimeout?: {
      getMs: number;
      writeMs: number;
      text: (timeoutMs: number) => string;
    };
  }
}

export {};
