// ==UserScript==
// @name         网络安全答题助手
// @namespace    local.quiz.helper
// @version      1.4.0
// @description  本地采集、服务器确认答案、精确匹配自动答题
// @match        https://ehallapp.imau.edu.cn/qljfwapp/sys/lwImuJzgPartyHistoryQA/*
// @grant        none
// @run-at       document-start
// ==/UserScript==
(function () {
  'use strict';
  const norm = s => String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  const title = s => norm(s).replace(/^\d+[.、．]\s*/, '').replace(/\s*[（(](单选题|多选题)[）)]\s*$/, '');
  const option = s => norm(s).replace(/^[A-Z][.、．]\s*/, '');
  const optionLabel = input => /^[A-Z]$/.test(String(input.value)) ? String(input.value) :
    (norm(input.closest('label')?.textContent).match(/^([A-Z])[.、．]/)?.[1] || '');
  function submittedAnswers(snapshot, submitted) {
    if (!snapshot || typeof submitted !== 'string' || !/^[A-Z]+$/.test(submitted)) return [];
    const labels = snapshot.inputs.map(optionLabel), selected = [...submitted];
    if (labels.some(x => !x) || new Set(labels).size !== labels.length || new Set(selected).size !== selected.length || selected.some(x => !labels.includes(x))) return [];
    return labels.flatMap((label,i) => selected.includes(label) ? [snapshot.q.options[i]] : []);
  }
  const key = q => JSON.stringify([q.type, title(q.question), q.options.map(norm).sort()]);
  function valid(q) {
    return q && ['radio', 'checkbox'].includes(q.type) && typeof q.question === 'string' && title(q.question) &&
      Array.isArray(q.options) && q.options.length >= 2 && q.options.every(x => typeof x === 'string' && norm(x)) &&
      new Set(q.options.map(norm)).size === q.options.length;
  }
  function answerOK(q, answers) {
    return valid(q) && Array.isArray(answers) && answers.length > 0 &&
      (q.type !== 'radio' || answers.length === 1) && new Set(answers).size === answers.length &&
      answers.every(a => q.options.includes(a));
  }
  function verdict(r) {
    if (String(r?.code) !== '0') return 'error';
    if (r?.datas?.result === true || r?.datas?.result === 'true') return 'correct';
    if (r?.datas?.result === false || r?.datas?.result === 'false') return 'wrong';
    return 'error';
  }
  const comboKey = a => JSON.stringify([...a].sort());
  function wrongHistory(q, rows = []) {
    if (!Array.isArray(rows) || rows.some(a => !answerOK(q, a))) throw Error('错答记录格式不合法');
    return [...new Map(rows.map(a => [comboKey(a), [...a]])).values()];
  }
  function learn(q, previous, answers, result) {
    const wrongAnswers = wrongHistory(q, previous?.wrongAnswers || []);
    if (!answerOK(q, answers) || !['correct', 'wrong'].includes(result)) return previous;
    if (result === 'correct') return {...q, answers, wrongAnswers: wrongAnswers.filter(a => comboKey(a) !== comboKey(answers)), source:'server-confirmed', verifiedVersion:2, updatedAt:Date.now()};
    return {...q, answers:[], wrongAnswers:wrongHistory(q, [...wrongAnswers, answers]), source:'invalidated', updatedAt:Date.now()};
  }
  function mergeBank(existing, rows, restoring = false) {
    if (!Array.isArray(rows) || rows.length > 100000) throw Error('需要题目数组，最多 100000 条');
    const next = new Map(existing); let skipped = 0, conflicts = 0;
    for (const row of rows) {
      if (!row || !Array.isArray(row.options) || row.options.some(x => typeof x !== 'string') || typeof row.question !== 'string') { skipped++; continue; }
      const q = {...row,question:title(row.question),options:row.options.map(norm),answers:Array.isArray(row.answers) ? row.answers.map(norm) : []};
      if (!valid(q)) { skipped++; continue; }
      const wrong = Array.isArray(row.wrongAnswers) ? row.wrongAnswers.filter(Array.isArray).map(a=>a.map(norm)).filter(a=>answerOK(q,a)) : [];
      q.wrongAnswers = wrongHistory(q,wrong);
      if (q.answers.length && !answerOK(q,q.answers)) { q.answers=[]; conflicts++; }
      const old = next.get(key(q));
      // Live observations win over a subsequently imported file. Imports must
      // never resurrect a locally rejected answer or erase a repair decision.
      if (!restoring && old && (old.verifiedVersion===2 || ['invalidated','relearn'].includes(old.source))) { next.set(key(q),old); continue; }
      if (old) {
        q.wrongAnswers = wrongHistory(q,[...(old.wrongAnswers || []),...q.wrongAnswers]);
        if (old.answers.length && q.answers.length && comboKey(old.answers)!==comboKey(q.answers)) { q.answers=[]; conflicts++; }
        else if (!q.answers.length) q.answers=old.answers;
      }
      if (q.answers.length && q.wrongAnswers.some(a=>comboKey(a)===comboKey(q.answers))) { q.answers=[]; conflicts++; }
      q.source = restoring ? (row.source || 'import') : 'import';
      q.verifiedVersion = restoring ? (row.verifiedVersion || 0) : 0;
      next.set(key(q),q);
    }
    return {bank:next,skipped,conflicts};
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = {norm, title, option, key, valid, answerOK, verdict, learn, wrongHistory, optionLabel, submittedAnswers, mergeBank}; return; }
  if (window.__quizHelper) return;
  window.__quizHelper = true;
  const STORE = 'quiz-helper-v1';
  let lastIssue = null;
  try { lastIssue = JSON.parse(localStorage.getItem('quiz-helper-last-issue') || 'null'); } catch {}
  function remember(q, answers, reason) {
    const root=document.querySelector('.question-place');
    const row={type:q?.type,question:q?.question || root?.querySelector('.title-name')?.textContent || '未识别题目',
      options:q?.options || [...(root?.querySelectorAll('.answer-place label') || [])].map(x=>norm(x.textContent)),answers,reason};
    if(JSON.stringify(row)===JSON.stringify(lastIssue)) return;
    lastIssue=row;
    try {localStorage.setItem('quiz-helper-last-issue',JSON.stringify(row));} catch {}
  }
  function publish(phase, id = '', recoverable = false) {
    try { localStorage.setItem('quiz-helper-submit-v1', JSON.stringify({phase, id, recoverable, time:Date.now()})); } catch { /* Companion stops if no acknowledgement is available. */ }
  }
  publish('ready');
  let bank = new Map(), pending = null, latest = null;
  let status = '持续采集：导入后仍自动记录新题和判分。', panel, storageError = '', readReason = '', detected = '', bytes = 0, loadBlocked=false;
  function stop(msg) { status = msg; render(); }
  function save() {
    if(loadBlocked) { stop('原存储无法读取，已阻止覆盖；请先导出题库备份，再导入有效题库。'); return false; }
    try { const serialized=JSON.stringify([...bank.values()]); bytes=serialized.length*2; localStorage.setItem(STORE, serialized); storageError=''; return true; }
    catch { storageError='保存失败：新数据仅在本页内存中，请立即导出题库，刷新会丢失未保存部分。'; stop(storageError); return false; }
  }
  function merge(rows, restoring=false) {
    const result=mergeBank(bank,rows,restoring); bank=result.bank; return result;
  }
  try { const raw=localStorage.getItem(STORE) || '[]'; bytes=raw.length*2; const report=merge(JSON.parse(raw),true);
    if(report.skipped || report.conflicts) status=`已加载可用记录，跳过 ${report.skipped} 条无效题、撤销 ${report.conflicts} 个异常答案；请导出备份。`;
  } catch { loadBlocked=true; storageError='旧题库读取失败；请先备份原题库，避免覆盖。'; status = storageError; }
  function read() {
    readReason='等待答题页面';
    const root = document.querySelector('.question-place');
    const heading = root?.querySelector('.title-name');
    if (!root || !heading || !root.getClientRects().length) return null;
    const inputs = [...root.querySelectorAll('.answer-place input[type=radio], .answer-place input[type=checkbox]')];
    if (!inputs.length || inputs.some(x => x.type !== inputs[0].type)) { readReason='题干存在，但选项控件缺失或类型混合'; return null; }
    const q = {question: title(heading.textContent), type: inputs[0].type,
      options: inputs.map(x => option(x.closest('label')?.textContent || '')), answers: []};
    if (!valid(q)) { readReason='题干/选项为空或选项文字重复，未自动匹配'; return null; }
    readReason='';
    return {q, inputs, button: root.querySelector('button.submit'), token: norm(heading.textContent)};
  }
  function collect(s) {
    latest = s.q;
    if (!bank.has(key(s.q))) { bank.set(key(s.q), s.q); if(save()) status=`已采集新题，当前 ${bank.size} 题`; }
    detected=`当前题：${bank.get(key(s.q))?.answers.length ? '已有答案' : '待验证'}（已识别）`;
  }
  let submittedSnapshot = null;
  document.addEventListener('click', event => {
    if (!event.target?.closest?.('.question-place button.submit')) return;
    const s = read();
    if (!s) return;
    // Freeze option metadata before Vue changes the displayed question.
    submittedSnapshot = {at:Date.now(), snapshot:{q:JSON.parse(JSON.stringify(s.q)), inputs:s.inputs.map(input => {
      const value = optionLabel(input), textContent = input.closest('label')?.textContent || '';
      return {value, closest:() => ({textContent})};
    })}};
  }, true);
  // Observe only the requests already issued by the page; never call quiz APIs ourselves.
  const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  const urls = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url, ...rest) { urls.set(this, String(url)); return open.call(this, method, url, ...rest); };
  XMLHttpRequest.prototype.send = function (body) {
    const url = urls.get(this) || '';
    if (/\/verifyAnswer\.do(?:\?|$)/.test(url)) {
      // Never attach an asynchronous response to whatever happens to be visible now.
      const snapshot = submittedSnapshot && Date.now()-submittedSnapshot.at < 10000 ? submittedSnapshot.snapshot : null;
      submittedSnapshot = null;
      const params = typeof body === 'string' ? new URLSearchParams(body) : body;
      const submitted = params?.get?.('ANSWER');
      const answers = submittedAnswers(snapshot, submitted);
      const request = {snapshot, answers, started: Date.now()};
      request.id = `${Date.now()}-${Math.random()}`;
      if (pending) stop('检测到重叠提交，自动答题已停止。');
      pending = request;
      publish('pending', request.id);
      this.addEventListener('loadend', () => {
        if (pending !== request) return;
        pending = null;
        try {
          const r = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
          const result = this.status >= 200 && this.status < 300 ? verdict(r) : 'error';
          if(result !== 'correct') remember(snapshot?.q || latest, answers, result==='wrong' ? '服务器判错' : '超时/判分异常');
          let saved = true;
          if (result === 'correct' && snapshot && answerOK(snapshot.q, answers)) {
            bank.set(key(snapshot.q), learn(snapshot.q, bank.get(key(snapshot.q)), answers, result)); saved=save();
            if(saved && lastIssue?.question===snapshot.q.question && comboKey(lastIssue.options)===comboKey(snapshot.q.options)) {
              lastIssue.resolved=true;
              try {localStorage.setItem('quiz-helper-last-issue',JSON.stringify(lastIssue));} catch {}
            }
            if(saved) status = '服务器判对，答案已保存。';
          } else {
            if (result === 'wrong' && snapshot && answerOK(snapshot.q, answers)) {
              bank.set(key(snapshot.q), learn(snapshot.q, bank.get(key(snapshot.q)), answers, result)); saved=save();
              stop('服务器判错，已记录本次实际提交的错误答案；下次提示其他候选。');
            } else { saved=r?.datas?.result==='overtime'; stop('超时或未取得有效判分，未修改答案。'); }
          }
          publish(saved ? result : 'error', request.id, saved && (result==='wrong' || r?.datas?.result==='overtime'));
        } catch { publish('error', request.id); stop('无法读取判分结果，已停止。'); }
        render();
      }, {once: true});
    }
    return send.call(this, body);
  };
  function download(name, data) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'}));
    const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function render() {
    if (!panel) return;
    if(panel.dataset) panel.dataset.quizStorageError = storageError;
    panel.querySelector('pre').textContent = `持续采集 | ${bank.size} 题 / ${[...bank.values()].filter(q => q.answers.length).length} 题有答案\n存储估算 ${(bytes/1024).toFixed(0)} KB\n${storageError || status}\n${readReason || detected}`;
    panel.querySelector('[data-last]').textContent = lastIssue ? `${lastIssue.reason}${lastIssue.resolved ? '（之后已答对）' : ''}\n${lastIssue.question}\n${lastIssue.options.map((x,i)=>String.fromCharCode(65+i)+'. '+x).join('\n')}\n实际提交：${lastIssue.answers.join('；') || '未提交/未识别'} ` : '暂无问题记录';
    panel.querySelector('[data-unknown]').textContent = [...bank.values()].filter(q=>!q.answers.length).map(q=>q.question).join('\n\n') || '全部已有答案';
  }
  function mount() {
    panel = document.createElement('aside');
    panel.style.cssText = 'position:fixed;right:12px;top:12px;z-index:2147483647;width:280px;background:#fff;color:#172033;padding:12px;border:2px solid #3277dc;border-radius:10px;box-shadow:0 3px 16px #0003;font:13px/1.6 sans-serif';
    panel.innerHTML = '<b>题库记录</b><pre style="white-space:pre-wrap;font:inherit"></pre><button data-export>导出题库</button> <button data-import>导入题库</button><input type="file" accept=".json" hidden><details><summary>最后一道问题题（返回首页后保留）</summary><div data-last style="white-space:pre-wrap"></div></details><details><summary>待确认题目</summary><div data-unknown style="white-space:pre-wrap;max-height:180px;overflow:auto"></div></details>';
    document.body.append(panel);
    panel.querySelector('[data-export]').onclick = () => download('答题题库.json', [...bank.values()]);
    const file = panel.querySelector('input');
    panel.querySelector('[data-import]').onclick = () => file.click();
    file.onchange = async () => { try {
      if (!file.files[0]) return;
      if (file.files[0].size > 20 * 1024 * 1024) throw Error('文件超过 20 MB');
      const parsed=JSON.parse(await file.files[0].text());
      if(loadBlocked) download('原始题库存储备份.json',{raw:localStorage.getItem(STORE)});
      const report=merge(parsed); loadBlocked=false;
      if(save()) status = `题库已合并，继续采集新题；跳过 ${report.skipped} 条无效记录，撤销 ${report.conflicts} 个异常答案。`;
    } catch (e) { stop(`导入失败：${e.message}`); } finally { file.value = ''; render(); } };
    render();
    setInterval(tick, 100);
  }
  function tick() {
    try {
      const s = read();
      if(s) collect(s);
      if (pending) {
        if (Date.now() - pending.started > 10000) { remember(pending.snapshot?.q || latest,pending.answers,'判分等待超时'); publish('error',pending.id); pending=null; stop('判分等待超时，已恢复题目采集；本次答案未确认。'); }
        render(); return;
      }
      if(!s && readReason !== '等待答题页面') remember(null, [], readReason);
      render();
    } catch (e) { stop(`脚本异常：${e.message}`); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once: true}); else mount();
})();
