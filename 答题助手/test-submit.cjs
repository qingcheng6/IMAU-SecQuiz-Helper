const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createAutoSubmitter} = require('./deepseek-hints.user.js');
const {createRoundStarter}=require('./deepseek-hints.user.js');
function fixture(delayed = false) {
  let time=0, clicks=0, active=true, error='', server={phase:'ready',id:''};
  let q={heading:'1.题目',question:'题目',type:'radio',options:['甲','乙'],labels:['A','B'],remaining:15};
  let answers=['乙'];
  const s=createAutoSubmitter({read:()=>q,selected:()=>answers,state:()=>server,allowed:()=>active,delay:400,now:()=>time,
    click:()=>{clicks++;if(!delayed)server={phase:'pending',id:String(clicks)};},halt:m=>{error=m;active=false;}});
  return {s,plan:()=>s.plan(q,['乙']),time:x=>time=x,clicks:()=>clicks,error:()=>error,
    server:x=>server=x,question:x=>q={...q,...x},answers:x=>answers=x,active:x=>active=x};
}
test('等待400ms才提交一次，未判分时不提交下一题，判对后继续',()=>{
  const f=fixture(); f.plan(); f.time(399); f.s.tick(); assert.equal(f.clicks(),0);
  f.time(400); f.s.tick(); assert.equal(f.clicks(),1);
  f.question({heading:'2.题目'}); f.plan(); f.time(2000); assert.equal(f.s.tick(),true); assert.equal(f.clicks(),1);
  f.server({phase:'correct',id:'1'}); assert.equal(f.s.tick(),false);
  f.plan(); f.time(2400); f.s.tick(); assert.equal(f.clicks(),2);
});
test('答错或异常停止，判分长时间不返回也停止',()=>{
  for(const phase of ['wrong','error','pending']) {
    const f=fixture();f.plan();f.time(400);f.s.tick();f.server({phase,id:'1'});
    f.time(11000); f.s.tick(); assert.match(f.error(),/停止/);assert.equal(f.clicks(),1);
  }
});
test('等待期间用户改选、切题、到时或关闭开关，不会提交',()=>{
  for(const mode of ['answer','question','time','disable']) {
    const f=fixture();f.plan();
    if(mode==='answer')f.answers(['甲']); if(mode==='question')f.question({heading:'2.其他题'});
    if(mode==='time')f.question({remaining:1}); if(mode==='disable')f.active(false);
    f.time(500);f.s.tick();assert.equal(f.clicks(),0);
  }
});
test('未安装新版记录脚本时停止，不会盲目点击',()=>{
  const f=fixture();f.server(null);f.plan();f.time(500);f.s.tick();assert.equal(f.clicks(),0);assert.match(f.error(),/更新/);
});
test('用户提前手动提交则取消排队点击，等待该次判分',()=>{
  const f=fixture();f.plan();f.server({phase:'pending',id:'manual'});f.time(500);
  assert.equal(f.s.tick(),true);assert.equal(f.clicks(),0);
  f.server({phase:'wrong',id:'manual'});f.s.tick();assert.match(f.error(),/停止/);
});
test('Axios 异步启动请求：点击后仍为旧状态，稍后启动并判对，连续三题不关闭',()=>{
  const f=fixture(true);
  for(let i=1;i<=3;i++) {
    const base=(i-1)*2000;
    f.question({heading:`${i}.题目`});f.time(base);f.plan();f.time(base+400);f.s.tick();
    assert.equal(f.clicks(),i);assert.equal(f.error(),'');
    f.time(base+600);assert.equal(f.s.tick(),true);assert.equal(f.error(),'');
    f.server({phase:'pending',id:String(i)});f.time(base+800);assert.equal(f.s.tick(),true);
    f.server({phase:'correct',id:String(i)});f.time(base+1000);assert.equal(f.s.tick(),false);assert.equal(f.error(),'');
  }
});
test('响应很快时可直接读取 correct，启动失败只点击一次并最终停止',()=>{
  const f=fixture(true);f.plan();f.time(400);f.s.tick();f.server({phase:'correct',id:'fast'});
  assert.equal(f.s.tick(),false);assert.equal(f.error(),'');
  const g=fixture(true);g.plan();g.time(400);g.s.tick();g.time(3000);g.s.tick();
  assert.match(g.error(),/启动超时/);assert.equal(g.clicks(),1);
});
test('默认80ms提交，明确答错后交回自动重开流程而不关闭',()=>{
  let time=0, clicks=0,ended=0,server={phase:'ready',id:''};const q={heading:'1.x',question:'x',type:'radio',options:['a','b'],labels:['A','B'],remaining:15};
  const s=createAutoSubmitter({read:()=>q,selected:()=>['a'],state:()=>server,click:()=>{clicks++;server={id:'1',phase:'pending'};},allowed:()=>true,halt:()=>assert.fail(),ended:()=>ended++,now:()=>time});
  s.plan(q,['a']);time=79;s.tick();assert.equal(clicks,0);time=80;s.tick();assert.equal(clicks,1);
  server={id:'1',phase:'wrong',recoverable:true};s.tick();assert.equal(ended,1);
});
test('首页自动开始，进入题目后不乱点；按钮无效有限重试后停止',()=>{
  let time=0, home=true, active=true,clicks=0,stopped=false;
  const r=createRoundStarter({home:()=>home,inQuestion:()=>!home,allowed:()=>active,click:()=>clicks++,halt:()=>stopped=true,now:()=>time});
  r.tick();time=300;r.tick();assert.equal(clicks,1);time=400;r.tick();assert.equal(clicks,1);
  home=false;r.tick();time=1000;r.tick();assert.equal(clicks,1);
  home=true;r.tick();time=1300;r.tick();assert.equal(clicks,2);
  time=6300;r.tick();time=11300;r.tick();time=16300;r.tick();assert.equal(stopped,true);
  active=false;time=20000;r.tick();assert.equal(clicks,4);
});
