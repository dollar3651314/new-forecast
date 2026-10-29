#!/usr/bin/env node
/**
 * M-11 分享卡片：把 web/public/og-return-rate.svg 转成 og-return-rate.png（1200×630；X、Threads、Facebook 都不认 SVG 的预览图）。
 * 用 Playwright 的 Chromium 截图（npx playwright install chromium；CI 不跑这一步，PNG 进仓库）。改了 SVG 以后手动执行：node scripts/render-og.mjs
 * 文字用本机的中文字体（Noto Sans TC / SC），换机器生成时看一眼图里的字有没有变成方块。
 */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(path.join(site, 'web/public/og-return-rate.svg'), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`);
await page.screenshot({ path: path.join(site, 'web/public/og-return-rate.png'), clip: { x: 0, y: 0, width: 1200, height: 630 } });
await browser.close();
console.log('已生成 web/public/og-return-rate.png');
