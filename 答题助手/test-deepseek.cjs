'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {parseAnswer, payload, key, createController, httpError, alternative, createAutoSelector} = require('./deepseek-hints.user.js');
const question = () => ({heading:'1.测试题（单选题）', question:'测试题', type:'radio', options:['甲','乙'], labels:['A','B'], remaining:20});
const response = answers => ({choices:[{finish_reason:'stop', message:{content:JSON.stringify({answers})}}]});
function fixture() {
  let q = question(), time = 100, saved = null, shown;
  const calls = [];
  const c = createController({read:() => q, known:() => saved, now:() => time, show:s => shown = s,
    request(q, timeout, done) { const call = {q, timeout, done, aborted:false}; calls.push(call); return {abort() { call.aborted = true; done(Error('aborted')); }}; }});
  return {c, calls, shown:() => shown, setQuestion:x => q = x, setKnown:x => saved = x, advance:ms => time += ms};
}
test('请求限定非思考、短 JSON，只发送题目与选项', () => {
  const p = payload({...question(), secret:'must-not-leak'}, 'deepseek-flash');
  assert.equal(p.thinking.type, 'disabled'); assert.equal(p.max_tokens, 96);
  assert.equal(p.response_format.type, 'json_object'); assert.equal(JSON.stringify(p).includes('must-not-leak'), false);
});
test('解析单选、多选，并拒绝未知标签、重复标签、空答案和截断响应', () => {
  assert.deepEqual(parseAnswer(response(['B']), question()), ['乙']);
  assert.deepEqual(parseAnswer(response(['B','A']), {...question(), type:'checkbox'}), ['乙','甲']);
  for (const a of [[], ['Z'], ['A','B'], ['A','A'], [1]]) assert.throws(() => parseAnswer(response(a), question()));
  assert.throws(() => parseAnswer({choices:[{finish_reason:'length',message:{content:'{"answers":["A"]}'}}]},question()));
});
test('默认不请求；本地命中优先且按选项文本映射', () => {
  const f = fixture(); f.c.tick(); assert.equal(f.calls.length, 0);
  f.setKnown(['乙']); f.setQuestion({...question(), options:['乙','甲']}); f.c.enable(true);
  assert.equal(f.calls.length, 0); assert.deepEqual(f.shown().answers,['乙']);
  assert.equal(f.shown().q.labels[f.shown().q.options.indexOf('乙')], 'A');
});
test('轮询只请求一次；AI 建议不会被写为已确认答案', () => {
  const f = fixture(); f.c.enable(true); f.c.tick(); f.c.tick(); assert.equal(f.calls.length, 1);
  f.calls[0].done(null,['乙']); assert.equal(f.shown().source,'AI 建议 · 尚未判分');
  f.c.tick(); assert.equal(f.calls.length, 1);
});
test('切题取消请求，迟到响应不覆盖新题，即使题干相同但顺序改变', () => {
  const f = fixture(); f.c.enable(true);
  f.setQuestion({...question(), options:['乙','甲']}); f.c.tick();
  assert.equal(f.calls[0].aborted,true); assert.equal(f.calls.length,2);
  f.calls[0].done(null,['甲']); assert.equal(f.shown().answers,undefined);
  f.calls[1].done(null,['乙']); assert.deepEqual(f.shown().answers,['乙']);
});
test('响应到达时先校验实际页面，即使轮询尚未检测到切题', () => {
  const f = fixture(); f.c.enable(true); f.setQuestion({...question(), heading:'2.另一题'});
  f.calls[0].done(null,['甲']); assert.equal(f.shown().answers,undefined);
  f.c.tick(); assert.equal(f.calls.length,2);
});
test('关闭提示、离开页面和倒计时结束都会清除回答', () => {
  for (const action of ['disable','leave','expire']) {
    const f = fixture(); f.c.enable(true);
    if (action === 'disable') f.c.enable(false);
    else { f.setQuestion(action === 'leave' ? null : {...question(),remaining:0}); f.c.tick(); }
    f.calls[0].done(null,['甲']); assert.equal(f.shown().answers,undefined);
    assert.equal(f.calls[0].aborted,true);
  }
});
test('超时取消且不自动重试；手动重试才新建请求', () => {
  const f = fixture(); f.c.enable(true); f.advance(12001); f.c.tick();
  assert.equal(f.calls[0].aborted,true); assert.match(f.shown().text,/超时/);
  f.c.tick(); assert.equal(f.calls.length,1); f.c.retry(); assert.equal(f.calls.length,2);
});
test('按剩余时间缩短超时，剩余三秒不再请求', () => {
  const f = fixture(); f.setQuestion({...question(),remaining:6}); f.c.enable(true); assert.equal(f.calls[0].timeout,4000);
  const g = fixture(); g.setQuestion({...question(),remaining:3}); g.c.enable(true); assert.equal(g.calls.length,0);
});
test('本地匹配规则与旧助手保持一致', () => {
  const old = require('./quiz-helper.user.js'); assert.equal(key(question()), old.key(question()));
  assert.match(httpError(401),/Key/); assert.match(httpError(402),/余额/); assert.match(httpError(429),/限流/);
});
test('排除已错单选，选项乱序后仍按文本排除；全错时停止', () => {
  assert.deepEqual(alternative({...question(),wrongAnswers:[['甲']]}),['乙']);
  assert.deepEqual(alternative({...question(),options:['乙','甲'],wrongAnswers:[['甲']]}),['乙']);
  assert.deepEqual(alternative({...question(),wrongAnswers:[['甲'],['乙']]}),[]);
});
test('多选排除整个组合，不错误排除单个选项，也不受组合顺序影响', () => {
  const q = {...question(), type:'checkbox',wrongAnswers:[['乙','甲']]};
  assert.deepEqual(alternative(q),['甲']);
  assert.deepEqual(alternative({...q,wrongAnswers:[['甲'],['乙']]}),['甲','乙']);
  assert.deepEqual(alternative({...q,wrongAnswers:[['甲'],['乙'],['乙','甲']]}),[]);
});
test('有错答历史直接给未试候选，不再向 API 请求相同错误答案', () => {
  const f = fixture(); f.setQuestion({...question(),wrongAnswers:[['甲']]}); f.c.enable(true);
  assert.equal(f.calls.length,0); assert.deepEqual(f.shown().answers,['乙']); assert.match(f.shown().source,/尚未确认/);
  f.setQuestion({...question(),wrongAnswers:[['甲'],['乙']]}); f.c.tick();
  assert.equal(f.shown().answers,undefined); assert.match(f.shown().text,/所有候选/);
});
test('错答记录在请求过程中更新：取消旧建议并改用其他候选', () => {
  const f = fixture(); f.c.enable(true);
  f.setQuestion({...question(),wrongAnswers:[['甲']]}); f.c.tick();
  assert.equal(f.calls[0].aborted,true);
  f.calls[0].done(null,['甲']); assert.deepEqual(f.shown().answers,['乙']);
});
test('重学当前题的修订号变化会重新请求，不停留在旧答案',()=>{
  const f=fixture();f.c.enable(true);f.calls[0].done(null,['甲']);
  f.setQuestion({...question(),revision:123});f.c.tick();assert.equal(f.calls.length,2);
});
test('人工处理问题题不调用AI，正常下一题继续请求',()=>{
  const f=fixture();f.setQuestion({...question(),manual:true});f.c.enable(true);assert.equal(f.calls.length,0);assert.match(f.shown().text,/手动/);
  f.setQuestion({...question(),heading:'2.新题'});f.c.tick();assert.equal(f.calls.length,1);
});
function selectionFixture(type = 'radio') {
  let q = {...question(),type}, clicks = 0;
  const nodes = q.options.map((text,i) => ({type,value:q.labels[i],checked:false,disabled:false,isConnected:true,
    closest:() => ({textContent:`${q.labels[i]}.${text}`}),
    click() { clicks++; if (type === 'radio') nodes.forEach(x => x.checked = false); this.checked = !this.checked; }}));
  const selector = createAutoSelector({read:() => q, inputs:() => nodes});
  return {q,nodes,selector,clicks:() => clicks,setQuestion:next => q = next};
}
test('自动点击对应单选控件，校验状态且不覆盖用户后续改选', async () => {
  const f = selectionFixture();
  assert.match(await f.selector.select(f.q,['乙']),/已自动勾选/); assert.equal(f.nodes[1].checked,true);
  f.nodes[0].click(); await f.selector.select(f.q,['乙']);
  assert.equal(f.nodes[0].checked,true); assert.equal(f.clicks(),2);
});
test('多选补齐正确勾选并取消多余勾选，已勾选的答案不被反向切换', async () => {
  const f = selectionFixture('checkbox'); f.nodes[0].checked = true;
  assert.match(await f.selector.select(f.q,['乙']),/已自动勾选/);
  assert.deepEqual(f.nodes.map(x => x.checked),[false,true]);
  f.selector.reset(); await f.selector.select(f.q,['甲','乙']);
  assert.deepEqual(f.nodes.map(x => x.checked),[true,true]); assert.equal(f.clicks(),3);
});
test('切题、倒计时不足、无效答案或控件不匹配时不点击', async () => {
  for (const mode of ['changed','time','answer','disabled','label']) {
    const f = selectionFixture();
    if (mode === 'changed') f.setQuestion({...f.q,heading:'2.下一题'});
    if (mode === 'time') f.setQuestion({...f.q,remaining:1});
    if (mode === 'disabled') f.nodes[1].disabled = true;
    if (mode === 'label') f.nodes[1].value = 'X';
    await f.selector.select(f.q,mode === 'answer' ? ['不存在'] : ['乙']); assert.equal(f.clicks(),0);
  }
});
test('点击无效时显示失败，不循环重试；离开后同题新一轮可重新选择', async () => {
  const f = selectionFixture(); f.nodes[1].click = () => {};
  assert.match(await f.selector.select(f.q,['乙']),/未能完成/);
  const g = selectionFixture(); await g.selector.select(g.q,['乙']); g.nodes[1].checked = false;
  g.selector.reset(); await g.selector.select(g.q,['乙']); assert.equal(g.clicks(),2);
});
test('复现 Vue 父数组延迟更新：连续点击只留下最后项，逐项等待保留全部选择', async () => {
  const q = {...question(), type:'checkbox'};
  let parentValue = [], pendingValue = [], nodes;
  const build = () => q.options.map((text,i) => ({type:'checkbox',value:q.labels[i],checked:parentValue.includes(text),
    closest:() => ({textContent:`${q.labels[i]}.${text}`}), click() {
      this.checked = !this.checked;
      pendingValue = this.checked ? [...parentValue,text] : parentValue.filter(x => x !== text);
    }}));
  const flush = async () => { parentValue = pendingValue; nodes = build(); };
  nodes = build(); nodes[0].click(); nodes[1].click(); await flush();
  assert.deepEqual(parentValue,['乙']);
  parentValue = []; pendingValue = []; nodes = build();
  const selector = createAutoSelector({read:() => q, inputs:() => nodes, settle:flush});
  assert.match(await selector.select(q,['甲','乙']),/已自动勾选/);
  assert.deepEqual(parentValue,['甲','乙']);
});
test('逐项勾选期间切题或关闭开关，不能继续点击剩余选项', async () => {
  for (const mode of ['switch','disable','reset']) {
    const f = selectionFixture('checkbox'); let current = f.q, active = true, selector;
    selector = createAutoSelector({read:() => current,inputs:() => f.nodes,allowed:() => active,
      settle:async () => { if(mode === 'switch') current = {...current,heading:'2.下一题'};
        if(mode === 'disable') active = false; if(mode === 'reset') selector.reset(); }});
    assert.match(await selector.select(f.q,['甲','乙']),/未能完成/);
    assert.equal(f.clicks(),1);
  }
});
