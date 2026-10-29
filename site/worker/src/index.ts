/**
 * Quick Come 官网 / 等候页 / 名单页 v1 的 Cloudflare Worker：Workers 静态资源（site/dist）+ D1 + Cron（每 5 分钟）。
 * - fetch：app.ts 的 handle（正式版只有 /api/* 和 /admin* 先进 Worker，其余由静态资源直接给；测试版整站先进 Worker，过密码门）。
 * - scheduled：取 BTC 行情写缓存（board.ts），删过期的限次计数和登录失败记录（ratelimit.ts）。
 */
import { handle } from './app';
import { refresh } from './board';
import type { Env } from './env';
import { cleanup } from './ratelimit';
import { log } from './util';

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handle(req, env, ctx, Date.now());
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = Date.now();
    ctx.waitUntil(
      (async () => {
        const used = await refresh(env, now);
        log('board.refresh', { source: used });
        await cleanup(env.DB, now);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
