/* 挂载点清单（纯数据，无 React / DOM 依赖）。
 *
 * 与装配逻辑分开，是为了让「有哪些挂载点、哪些按需加载」成为可查询的数据：
 * 测试可以直接 require 本模块断言全集与唯一性，而不是去 grep main.jsx 的
 * getElementById 文本；新增浮层时也只改这一张表。
 *
 * component 是组件名（映射到 mounts.jsx 的注册表），exportName 是按需 chunk
 * 里导出的名字。两个 lazy 项首屏不下载。
 */
export const MOUNT_POINTS = Object.freeze([
  { id: 'cmdkRoot', component: 'CommandPalette' },
  { id: 'cardsRoot', component: 'CardsView' },
  { id: 'readerRoot', component: 'ReaderView' },
  { id: 'overlaysRoot', component: 'Overlays' },
  /* 这两个必须挂在视图容器之外：.reader-head 是容器查询容器，会把 fixed
     后代关进头部那一小块；桌面视图导航由各视图顶栏自己的实例负责。 */
  { id: 'mobileTabbarRoot', component: 'ViewNav' },
  { id: 'scrollTopRoot', component: 'ScrollTop' },
  { id: 'settingsRoot', lazy: true, exportName: 'SettingsModal' },
  { id: 'aiRoot', lazy: true, exportName: 'AiView' },
]);

export const MOUNT_IDS = Object.freeze(MOUNT_POINTS.map((m) => m.id));
