/**
 * 测试版整站密码门（技术方案第三节最后一条：避免陌生人在测试版留下真实邮箱）。
 * - 变量 SITE_GATE = on（staging 在 wrangler.toml 写死；正式版不写，默认关）时：除了健康检查 GET /api/health 和
 *   登录 POST /api/gate/login，所有页面和接口都要先输同一个密码 ADMIN_PASSWORD；页面返回 401 + 密码页（顶部有"测试环境"标识条），接口返回 401 JSON。
 * - 密码没开通（少于 16 个字符或没填）时整站 503，不开放。
 * - 登录成功发整站有效的 Cookie qc_gate（12 小时，用途 gate，和名单页的会话不能互换）；锁定规则和名单页共用（auth.ts）。
 * - 名单页在密码门后面仍然要单独登录。
 * staging 的 wrangler.toml 设 run_worker_first = true，所以静态页面也先经过这里。
 */
import TEXT from '../content/gate.json';
import { checkPassword, hasSession, makeSession, passwordConfigured, SESSION_MS, sessionCookies } from './auth';
import type { Env } from './env';
import { error, esc, html, rateLimited, readJson } from './http';
import { flag } from './util';

export function gateOn(env: Env): boolean {
  return flag(env.SITE_GATE, false);
}

function page(status: number): Response {
  const body = `<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(TEXT.title)}</title>
<style>
body{margin:0;background:#0F1B33;color:#E8ECF5;font:15px/1.7 "Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif}
.env{background:#FBBF24;color:#0F1B33;font-weight:700;text-align:center;padding:6px 16px;font-size:13px}
main{max-width:420px;margin:48px auto;padding:0 16px}
h1{font-size:20px;margin:0}p.en{color:#B9C3D6;margin:2px 0 18px;font-size:14px}
label{font-size:13px;color:#C9D2E3}
input{width:100%;box-sizing:border-box;margin:6px 0 12px;padding:11px 12px;border-radius:7px;border:1px solid rgba(255,255,255,.25);background:#0B1528;color:#fff;font:inherit}
button{width:100%;border:0;border-radius:7px;padding:12px;font:inherit;font-weight:700;background:#2DD4BF;color:#0F1B33;cursor:pointer}
button:focus-visible,input:focus-visible{outline:2px solid #FBBF24;outline-offset:2px}
#msg{min-height:1.7em;color:#FBBF24;font-size:14px;margin-top:10px}
</style></head><body>
<div class="env" role="note">${esc(TEXT.banner)}</div>
<main>
${status === 503 ? `<p>${esc(TEXT.unavailable)}</p>` : `<h1>${esc(TEXT.heading)}</h1><p class="en">${esc(TEXT.headingEn)}</p>
<form id="f"><label for="pw">${esc(TEXT.label)}</label><input id="pw" type="password" autocomplete="current-password" required autofocus>
<button type="submit">${esc(TEXT.submit)}</button><div id="msg" role="alert"></div></form>
<script>
document.getElementById('f').addEventListener('submit',async function(e){e.preventDefault();var m=document.getElementById('msg');m.textContent='';
try{var r=await fetch('/api/gate/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})});
if(r.status===204){location.reload();return}
var j=await r.json().catch(function(){return{}});
if(r.status===429){m.textContent=${JSON.stringify(TEXT.locked)}.replace('{minutes}',String(Math.ceil((j.cooldownSeconds||60)/60)))}
else if(r.status===401){m.textContent=${JSON.stringify(TEXT.wrong)}}else{m.textContent=${JSON.stringify(TEXT.failed)}}}
catch(_){m.textContent=${JSON.stringify(TEXT.failed)}}document.getElementById('pw').value=''});
</script>`}
</main></body></html>`;
  return html(body, status, { 'X-Robots-Tag': 'noindex' });
}

/** 密码门拦下的请求：页面给密码页，接口给 401 JSON；没开通给 503 */
export async function gate(req: Request, env: Env, path: string, now: number): Promise<Response | null> {
  if (!gateOn(env)) return null;
  if (path === '/api/gate/login' && req.method === 'POST') return gateLogin(req, env, now);
  if (!passwordConfigured(env)) return path.startsWith('/api/') ? error(503, 'GATE_NOT_CONFIGURED', 'test environment password not set') : page(503);
  if (await hasSession(req, env, 'gate', now)) return null;
  return path.startsWith('/api/') ? error(401, 'GATE_REQUIRED', 'test environment password required') : page(401);
}

async function gateLogin(req: Request, env: Env, now: number): Promise<Response> {
  if (!passwordConfigured(env)) return error(503, 'GATE_NOT_CONFIGURED', 'test environment password not set');
  const r = await readJson(req);
  if (!r.ok) return r.res;
  const c = await checkPassword(env, req, r.body.password, 'gate', now);
  if (!c.ok) return c.reason === 'locked' ? rateLimited(c.retryAfter, 'LOCKED') : error(401, 'WRONG_PASSWORD', 'wrong password');
  const h = new Headers();
  for (const ck of sessionCookies('gate', await makeSession(env, 'gate', now), SESSION_MS / 1000)) h.append('Set-Cookie', ck);
  return new Response(null, { status: 204, headers: h });
}
