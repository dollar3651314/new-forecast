/**
 * 网页后台"待回复清单"（agents C136；原型 https://claude.ai/artifact/ChzHasuaRuPxu1E6YhgZrJ；状态清单 agents 营销团队/副驾驶/状态清单.md 第四节）。
 * 一个页面：没登录显示密码框，登录后显示清单（待回 / 已回 / 跳过）；手机、电脑都能用。每个按钮都有处理中 / 成功 / 失败的反馈（C135）。
 */
export const ADMIN_PAGE = `<!doctype html>
<html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow"><title>待回复清单</title>
<style>
:root{--bg:#F4F6F9;--surface:#fff;--ink:#13203A;--muted:#5B6678;--line:#D9DEE7;--navy:#0F1B33;--teal:#14B8A6;--teal-soft:#D5F5F0;--amber:#E0A10F;--ok:#15803D;--err:#B91C1C;--err-soft:#FDE8E8}
@media (prefers-color-scheme: dark){:root{--bg:#0B1220;--surface:#131C2E;--ink:#E6EBF3;--muted:#9AA6BA;--line:#26324A;--navy:#0A1324;--teal:#2DD4BF;--teal-soft:#0F3B37;--ok:#4ADE80;--err:#F87171;--err-soft:#3A1717;color-scheme:dark}}
*{box-sizing:border-box}[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 "Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif}
.top{display:flex;align-items:center;gap:10px;padding:12px max(16px,env(safe-area-inset-left));background:var(--navy);color:#fff;flex-wrap:wrap}
.logo{display:flex;gap:3px;align-items:flex-end}.logo i{display:block;width:6px;border-radius:2px}
.top b{font-size:16px}.top .sp{margin-left:auto;font-size:13px;color:#9FB0CC}
.top button{font:inherit;font-size:12px;background:none;border:1px solid #3A4A6A;color:#C9D4E6;border-radius:99px;padding:3px 10px;cursor:pointer}
main{max-width:860px;margin:0 auto;padding:12px max(16px,env(safe-area-inset-right)) 40px max(16px,env(safe-area-inset-left))}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 12px}
.chip{font:inherit;font-size:14px;padding:5px 12px;border-radius:99px;border:1px solid var(--line);background:var(--surface);color:var(--ink);cursor:pointer}
.chip[aria-pressed="true"]{background:var(--teal-soft);border-color:var(--teal);font-weight:700}
.toast{margin:0 0 12px;padding:8px 12px;border-radius:8px;font-size:14px;background:var(--teal-soft)}.toast.err{background:var(--err-soft);color:var(--err)}
.item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px 16px;padding:14px;border:1px solid var(--line);border-radius:12px;background:var(--surface);margin-bottom:10px}
@media (max-width:600px){.item{grid-template-columns:minmax(0,1fr)}.acts{flex-direction:row!important}.acts>*{flex:1}}
.who{font-size:13px;color:var(--muted)}.who b{color:var(--ink)}.who a{color:inherit}
.stale{color:var(--amber);font-weight:700}
.post{margin:4px 0 0;overflow-wrap:anywhere}
.draft{margin-top:8px;padding:10px 12px;border-radius:10px;background:var(--teal-soft);overflow-wrap:anywhere;white-space:pre-wrap}
.src{font-size:12px;color:var(--muted);margin-top:4px}
.acts{display:flex;flex-direction:column;gap:6px;min-width:132px}
.btn{font:inherit;font-size:14px;font-weight:700;border-radius:10px;padding:9px 12px;cursor:pointer;border:1px solid var(--line);background:var(--surface);color:var(--ink);text-align:center;text-decoration:none}
.btn.primary{background:var(--teal);border-color:var(--teal);color:#0F1B33}.btn[aria-disabled="true"],.btn:disabled{opacity:.5;pointer-events:none}
.btn:focus-visible,.chip:focus-visible{outline:2px solid var(--amber);outline-offset:2px}
.empty{padding:32px 12px;text-align:center;color:var(--muted)}
.login{max-width:360px;margin:12vh auto 0;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:20px;display:grid;gap:10px}
.login input{font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
.msg{margin:0;font-size:14px;color:var(--err)}.msg:empty{display:none}
</style></head><body>
<header class="top"><span class="logo" aria-hidden="true"><i style="height:16px;background:#2DD4BF"></i><i style="height:10px;background:#FBBF24"></i></span><b>待回复清单</b><span class="sp" id="count"></span><button id="logout" hidden>登出</button></header>
<form class="login" id="login" hidden>
  <b>登录</b><label for="pw">密码</label><input id="pw" type="password" autocomplete="current-password" required>
  <button class="btn primary" id="go" type="submit">登录</button><p class="msg" id="lmsg" role="alert"></p>
</form>
<main id="app" hidden>
  <div class="filters" role="group" aria-label="筛选"><button class="chip" data-f="pending" aria-pressed="true">待回</button><button class="chip" data-f="done" aria-pressed="false">已回</button><button class="chip" data-f="skip" aria-pressed="false">跳过</button></div>
  <p class="toast" id="toast" role="status" hidden></p>
  <div id="list"></div>
</main>
<script>
const $=(id)=>document.getElementById(id);
let filter='pending', state={items:[],doneToday:0,cap:10};
const P={x:'X',threads:'Threads'};
function toast(t,err){const e=$('toast');e.textContent=t;e.className='toast'+(err?' err':'');e.hidden=!t;}
function ago(ms){const m=Math.max(0,Math.round((Date.now()-ms)/60000));return m<60?m+' 分钟前':Math.round(m/60)+' 小时前';}
async function call(path,body){const r=await fetch(path,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined,credentials:'same-origin'});const j=await r.json().catch(()=>({}));if(r.status===401&&path!=='/api/login'){showLogin('请重新登录');throw new Error('请重新登录');}if(!r.ok)throw new Error(j.error||('出错了（'+r.status+'）'));return j;}
function showLogin(m){$('app').hidden=true;$('logout').hidden=true;$('login').hidden=false;$('count').textContent='';$('lmsg').textContent=m||'';$('pw').focus();}
$('login').addEventListener('submit',async(e)=>{e.preventDefault();const b=$('go');b.disabled=true;b.textContent='正在登录…';$('lmsg').textContent='';
  try{await call('/api/login',{password:$('pw').value});$('pw').value='';$('login').hidden=true;await load();}catch(err){$('lmsg').textContent=err.message;}finally{b.disabled=false;b.textContent='登录';}});
$('logout').addEventListener('click',async()=>{await call('/api/logout',{}).catch(()=>{});showLogin('已登出');});
document.querySelectorAll('[data-f]').forEach(b=>b.addEventListener('click',()=>{filter=b.dataset.f;document.querySelectorAll('[data-f]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));toast('');load();}));
async function load(){
  try{state=await call('/api/queue?status='+filter);}catch(e){if(e.message!=='请重新登录')toast(e.message,true);return;}
  $('app').hidden=false;$('logout').hidden=false;render();
}
function render(){
  const full=state.doneToday>=state.cap;
  $('count').textContent='今天已回 '+state.doneToday+' / '+state.cap;
  const L=$('list');L.replaceChildren();
  if(!state.items.length){L.innerHTML='<div class="empty">'+(filter==='pending'?'没有待回的帖子。打开插件的自动模式，或者自己往下滑，值得回的会出现在这里。':'这里还没有记录。')+'</div>';return;}
  for(const it of state.items){
    const d=document.createElement('div');d.className='item';
    const left=document.createElement('div');left.style.minWidth='0';
    const who=document.createElement('div');who.className='who';
    const a=document.createElement('a');a.href=it.postUrl;a.target='_blank';a.rel='noopener';a.textContent=it.author||'原帖';
    who.append(Object.assign(document.createElement('b'),{textContent:P[it.platform]||it.platform}),' · ',a,' · 存进来 '+ago(it.savedAt)+(it.score!=null?' · '+it.score+' 分':''));
    if(it.stale&&filter==='pending')who.append(' · ',Object.assign(document.createElement('span'),{className:'stale',textContent:'可能已过时'}));
    left.append(who,Object.assign(document.createElement('p'),{className:'post',textContent:it.snippet}));
    const dr=Object.assign(document.createElement('div'),{className:'draft',textContent:it.draft});
    if(it.source)dr.append(Object.assign(document.createElement('div'),{className:'src',textContent:'数据来源：'+it.source}));
    if(it.engine==='workers-ai')dr.append(Object.assign(document.createElement('div'),{className:'src',textContent:'备用 AI 写的（Gemini 当时用不了），发之前多看一眼'}));
    left.append(dr);
    const acts=document.createElement('div');acts.className='acts';
    if(filter==='pending'){
      const r=Object.assign(document.createElement('a'),{className:'btn primary',href:it.replyUrl,target:'_blank',rel:'noopener',textContent:'一键回复'});
      if(full){r.setAttribute('aria-disabled','true');r.textContent='今天已到上限';}
      r.addEventListener('click',()=>toast('已打开回复窗口。发完回来点"我回了"。'));
      acts.append(r,mk(it,'done','我回了'),mk(it,'skip','跳过'));
    }else acts.append(mk(it,'pending','放回待回'));
    d.append(left,acts);L.append(d);
  }
}
function mk(it,to,label){const b=Object.assign(document.createElement('button'),{className:'btn',textContent:label});
  b.addEventListener('click',async()=>{b.disabled=true;b.textContent='处理中…';
    try{await call('/api/queue/'+it.id,{status:to});toast(to==='done'?'已移到"已回"':to==='skip'?'已移到"跳过"':'已放回待回');await load();}
    catch(e){toast(e.message,true);b.disabled=false;b.textContent=label;}});return b;}
call('/api/queue?status=pending').then(j=>{state=j;$('app').hidden=false;$('logout').hidden=false;render();}).catch(()=>{});
</script></body></html>`;
