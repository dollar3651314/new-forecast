/**
 * 页面需要的环境信息：GET /api/public/site（环境名、M-12 备用网址）。不是 production 时顶部显示"测试环境"标识条（C34）。
 */
import { useEffect, useState } from 'react';
import { api } from './api';

export interface SiteInfo {
  environment: string;
  backupUrl: string | null;
}

export function useSiteInfo(): SiteInfo | null {
  const [info, setInfo] = useState<SiteInfo | null>(null);
  useEffect(() => {
    let live = true;
    void api<SiteInfo>('/api/public/site').then((r) => {
      if (live && r.ok) setInfo(r.data);
    });
    return () => {
      live = false;
    };
  }, []);
  return info;
}

/** 电脑版（宽度 > 760）和手机版分开排版（C64）：关键区块按这个渲染不同的结构 */
export function useIsDesktop(): boolean {
  const q = '(min-width: 761px)';
  const [m, setM] = useState(() => (typeof matchMedia === 'function' ? matchMedia(q).matches : true));
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return m;
}
