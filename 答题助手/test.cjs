'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const core = require('./quiz-helper.user.js');
const q = {type:'radio', question:'1.测试题（单选题）', options:['甲','乙'], answers:['乙']};
test('题号、题型后缀和选项顺序不影响匹配', () => {
  assert.equal(core.key(q), core.key({...q, question:'99.测试题 （单选题）', options:['乙','甲']}));
});
test('否定词、标点和不同选项不能误匹配', () => {
  for (const other of [{...q, question:'不测试题'}, {...q, question:'测试题？'}, {...q, options:['甲','丙']}, {...q, type:'checkbox'}]) assert.notEqual(core.key(q), core.key(other));
});
test('拒绝重复选项、单选多答案和缺失答案', () => {
  assert.equal(core.valid({...q, options:['甲','甲']}), false);
  for (const answers of [[], ['甲','乙'], ['丙'], ['乙','乙']]) assert.equal(core.answerOK(q, answers), false);
  assert.equal(core.answerOK({...q,type:'checkbox'}, ['甲','乙']), true);
});
test('仅明确的成功判分可学习，超时和未知值均不是成功', () => {
  for (const result of [true,'true']) assert.equal(core.verdict({code:0,datas:{result}}), 'correct');
  for (const result of [false,'false']) assert.equal(core.verdict({code:'0',datas:{result}}), 'wrong');
  for (const result of ['overtime','yes',null,1]) assert.equal(core.verdict({code:0,datas:{result}}), 'error');
  assert.equal(core.verdict({code:1,datas:{result:true}}), 'error');
});
// Minimal browser fixture exercises the actual installed script and XHR callbacks.
function fixture(rows = [q], delayed = false) {
  let tick, stored, submitted = 0, seq = 1, failSave=false, clock=Date.now();
  const listeners = {};
  class XHR {
    open() {} send() { submitted++; }
    addEventListener(name, fn) { this[name] = fn; }
    finish(result) { this.status = 200; this.responseText = JSON.stringify({code:0,datas:{result}}); this.loadend(); }
  }
  const inputs = ['甲','乙'].map((text,i) => ({type:'radio', value:String.fromCharCode(65+i), checked:false,
    closest:() => ({textContent:`${String.fromCharCode(65+i)}.${text}`}),
    click() { inputs.forEach(x => x.checked = false); this.checked = true; }}));
  let xhr, deferredSend, questionText = '测试题';
  const submit = {disabled:false, click() {
    listeners.click?.({target:{closest:() => submit}});
    const body = 'ANSWER=' + inputs.filter(x => x.checked).map(x => x.value).join('');
    const send = () => { xhr = new XHR(); xhr.open('POST','/api/verifyAnswer.do'); xhr.send(body); };
    if (delayed) { deferredSend = send; questionText = '下一道不同的题'; } else send();
    seq++; inputs.forEach(x => x.checked = false);
  }};
  const root = {getClientRects:() => [1], querySelectorAll:() => inputs,
    querySelector:s => s === '.title-name' ? {textContent:`${seq}.${questionText}（单选题）`} : submit};
  const controls = Object.fromEntries(['pre','[data-export]','[data-import]','[data-last]','[data-unknown]','input'].map(s => [s, {}]));
  const panel = {style:{},dataset:{},click(){}, querySelector:s => controls[s]};
  const document = {readyState:'loading', addEventListener:(s,f) => listeners[s] = f,
    querySelector:s => s === '.question-place' ? root : {textContent:'19'},
    createElement:() => panel, body:{append() {}}};
  const context = {window:{}, document, XMLHttpRequest:XHR, URLSearchParams,
    localStorage:{getItem:k => k==='quiz-helper-v1' ? JSON.stringify(rows) : null, setItem:(k,v) => { if(k === 'quiz-helper-v1') {if(failSave) throw Error('quota');stored = JSON.parse(v);} }},
    Date:class extends Date {static now(){return clock;}},Blob,URL:{createObjectURL:()=>'',revokeObjectURL(){}},
    setInterval:f => tick = f, setTimeout:()=>{}, console};
  vm.runInNewContext(fs.readFileSync(require.resolve('./quiz-helper.user.js'),'utf8'), context);
  listeners.DOMContentLoaded();
  return {tick:() => tick(), finish:r => xhr.finish(r),
    manual:i => { inputs[i].click(); submit.click(); },
    flush:() => deferredSend(),
    setQuestion:text=>questionText=text, advance:ms=>clock+=ms, failSave:()=>failSave=true,
    importRows:async data=>{controls.input.files=[{size:100,text:async()=>JSON.stringify(data)}];await controls.input.onchange();},
    last:()=>controls['[data-last]'].textContent, unknown:()=>controls['[data-unknown]'].textContent, count:() => submitted, stored:() => stored, status:() => controls.pre.textContent};
}
test('导入303题后持续采集到304、305；判分请求挂起也不阻塞采集', async () => {
  const rows=Array.from({length:303},(_,i)=>({...q,question:`题库题${i}`}));
  const f=fixture([]);await f.importRows(rows);f.tick();assert.equal(f.stored().length,304);
  f.manual(0);f.setQuestion('新题305');f.tick();assert.equal(f.stored().length,305);
  f.advance(11000);f.tick();assert.match(f.status(),/恢复题目采集/);
  f.setQuestion('新题306');f.tick();assert.equal(f.stored().length,306);
});
test('保存失败不会被判对提示覆盖，内存中的新题仍可导出', () => {
  const f=fixture();f.failSave();f.manual(0);f.finish('true');
  assert.match(f.status(),/保存失败/);assert.doesNotMatch(f.status(),/服务器判对，答案已保存/);
});
test('合并坏记录不导致整库丢失，长题干不受长度截断',()=>{
  const rows=Array.from({length:303},(_,i)=>({...q,question:`合成题 ${i}`}));
  const report=core.mergeBank(new Map(),rows,true);assert.equal(report.bank.size,303);assert.equal(report.skipped,0);
  const long={...q,question:'长题干'.repeat(10000)};
  const next=core.mergeBank(report.bank,[null,{options:null},long]);assert.equal(next.bank.size,304);assert.equal(next.skipped,2);
});
test('服务器记录实际提交选项，刷新后保留错答，之后答对仍保留其他错答', () => {
  const f = fixture(); f.manual(0); f.finish('false');
  assert.deepEqual(f.stored()[0].wrongAnswers, [['甲']]);
  const reloaded = fixture(f.stored()); reloaded.manual(1); reloaded.finish('true');
  assert.deepEqual(reloaded.stored()[0].answers,['乙']);
  assert.deepEqual(reloaded.stored()[0].wrongAnswers,[['甲']]);
});
test('超时不增加错误答案，重复错误不重复计数，多选保留组合语义', () => {
  const prev = {...q, wrongAnswers:[['甲']]};
  assert.equal(core.learn(q,prev,['乙'],'error'),prev);
  assert.equal(core.learn(q,prev,[],'wrong'),prev);
  assert.deepEqual(core.learn(q,prev,['甲'],'wrong').wrongAnswers,[['甲']]);
  const multi = {...q,type:'checkbox'};
  assert.deepEqual(core.learn(multi,null,['甲','乙'],'wrong').wrongAnswers,[['甲','乙']]);
  assert.deepEqual(core.learn(q,prev,['甲'],'correct').wrongAnswers,[]);
});
test('点击后先切题再异步发送，判分仍记录到提交时的题目', () => {
  const f=fixture([q],true);f.manual(1);f.flush();f.finish('true');
  assert.equal(f.stored()[0].question,'测试题');
  assert.deepEqual(f.stored()[0].answers,['乙']);
  assert.equal(f.stored().some(x=>x.question==='下一道不同的题'),false);
});

test('答错后保留实际题目和选择，后续答对不覆盖问题题',()=>{
  const f=fixture();f.manual(0);f.finish('false');assert.match(f.last(),/服务器判错/);assert.match(f.last(),/实际提交：甲/);
  f.manual(1);f.finish('true');assert.match(f.last(),/之后已答对/);assert.match(f.last(),/实际提交：甲/);
});
test('无答案题在左侧列表可见',()=>{const f=fixture([{...q,answers:[]}]);f.tick();assert.match(f.unknown(),/测试题/);});
