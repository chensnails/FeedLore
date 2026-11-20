/* 数据源面板：/api/config 的 Query 与回填副作用。从 SourcePane.controller.ts 抽出，逐字对齐。 */
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { qk } from '../kernel/query.ts';
import type { useFormLoadGuard } from './primitives.tsx';
import { CFG_DEFAULTS } from './SourcePane.constants.ts';
import type { Cfg } from './SourcePane.types.ts';
import { S } from './SourcePane.utils.ts';

type CfgGuard = ReturnType<typeof useFormLoadGuard>;
type ImgStats = { count: number; bytes: number };

/** /api/config（仅管理员拉）+ 失败兜底 + 图片缓存统计。回填仍走 cfgGuard。 */
export function useSourceConfigQuery(opts: {
  admin: boolean;
  cfgGuard: CfgGuard;
  setCfg: (next: Cfg) => void;
  setSavedCfg: (v: string | ((prev: string) => string)) => void;
  setCfgLoaded: (v: boolean) => void;
  setImgStats: (v: ImgStats) => void;
}) {
  const { admin, cfgGuard, setCfg, setSavedCfg, setCfgLoaded, setImgStats } = opts;

  // V5：/api/config 交给 Query（仅管理员拉）；queryFn 走 core.apiFetch 端口，测试桩照常生效。
  // 图片缓存统计沿用原来的「跟随 config、失败不阻塞」语义，放在同一 queryFn 尾部。
  const configQuery = useQuery({
    queryKey: qk.config,
    enabled: !!admin,
    queryFn: async () => {
      const res = await S().apiFetch('/api/config');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      let img = null;
      try {
        const sres = await S().apiFetch('/api/image-cache');
        if (sres.ok) img = await sres.json();
      } catch (_) {
        /* 统计接口异常时保持兜底 */
      }
      return { data, img };
    },
    refetchOnMount: 'always',
    // 条件挂载面板每次进入都是干净加载（旧实现无跨实例缓存），卸载即弃缓存；
    // 否则重挂载时旧 data 会先回填，破坏「未加载完禁止保存」的守卫。
    gcTime: 0,
    retry: false,
  });

  // 回填仍走 cfgGuard：首包到达前用户改过字段就保留输入，脏态基线按默认指纹算。
  useEffect(() => {
    if (configQuery.isPending || !configQuery.data) return;
    const { data } = configQuery.data;
    const src = data.source || {};
    const next = {
      refreshMinutes: String(src.refreshMinutes == null ? '' : src.refreshMinutes),
      keepPerFeed: String(src.keepPerFeed == null ? '' : src.keepPerFeed),
      keepDays: String(src.keepDays == null ? 0 : src.keepDays),
      timeoutSeconds: String(src.timeoutSeconds == null ? '' : src.timeoutSeconds),
      concurrency: String(src.concurrency == null ? '' : src.concurrency),
      autoRefreshMinutes: String(src.autoRefreshMinutes == null ? 0 : src.autoRefreshMinutes),
      proxyUrl: String(src.proxyUrl || ''),
      imgTtlDays: String(src.imgTtlDays == null ? '' : src.imgTtlDays),
      imgKeepDays: String(src.imgKeepDays == null ? '' : src.imgKeepDays),
      imgMaxDim: String(src.imgMaxDim == null ? '' : src.imgMaxDim),
      imgQuality: String(src.imgQuality == null ? '' : src.imgQuality),
      feedFailLimit: String(src.feedFailLimit == null ? '' : src.feedFailLimit),
    };
    const applied = cfgGuard.apply(() => {
      setCfg(next);
      setSavedCfg(JSON.stringify(next));
    });
    if (!applied) setSavedCfg((v) => v || JSON.stringify(CFG_DEFAULTS));
    setCfgLoaded(true);
    const img = configQuery.data.img;
    if (img) setImgStats({ count: Number(img.count) || 0, bytes: Number(img.bytes) || 0 });
  }, [configQuery.data, configQuery.isPending]);

  // 拉取失败：保持兜底值 + 禁止保存（与旧实现一致）。
  useEffect(() => {
    if (!configQuery.isError) return;
    setCfgLoaded(false);
    const s = S();
    if (s && s.toast) {
      const err = configQuery.error;
      const msg = err instanceof Error ? err.message : String(err);
      s.toast('采集参数读取失败：' + msg, false);
    }
  }, [configQuery.isError, configQuery.error]);
}
