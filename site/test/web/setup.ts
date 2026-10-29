import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

/** 按宽度模拟媒体查询（电脑版 min-width: 761px）；改宽度时通知已注册的监听（和浏览器的 change 事件一样） */
let width = 1440;
const listeners = new Set<() => void>();
export function setWidth(px: number) {
  width = px;
  window.matchMedia = ((query: string) => {
    const m = /min-width:\s*(\d+)px/.exec(query);
    const mq = {
      get matches() {
        return m ? width >= Number(m[1]) : false;
      },
      media: query,
      onchange: null,
      addEventListener: (_t: string, f: () => void) => void listeners.add(f),
      removeEventListener: (_t: string, f: () => void) => void listeners.delete(f),
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    };
    return mq as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
  for (const f of [...listeners]) f();
}
setWidth(1440);
