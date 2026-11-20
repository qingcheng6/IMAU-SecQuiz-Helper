'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const ai = require('./deepseek-hints.user.js');
const record = require('./quiz-helper.user.js');
// Reproduce the site's checkbox markup without including a real quiz page.
const html = ['甲','乙','丙','丁'].map((text,i) =>
  `<label><input type="checkbox" class="mint-checkbox-new-input"><span>${'ABCD'[i]}.${text}</span></label>`).join('');
const labels = [...html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)]
  .map(m => m[1]).filter(s => /mint-checkbox-new-input/.test(s));
function fixture() {
  return labels.map(s => ({type:'checkbox',value:'on',checked:false,
    closest:() => ({textContent:s.replace(/<[^>]*>/g,' ')}),
    click() {this.checked = !this.checked;}}));
}
test('四个无 value 多选框能够读取 A/B/C/D', () => {
  assert.equal(labels.length,4);
  assert.equal(labels.some(s => /<input[^>]*\bvalue=/.test(s)),false);
  assert.deepEqual(fixture().map(ai.optionLabel),['A','B','C','D']);
  assert.deepEqual(fixture().map(record.optionLabel),['A','B','C','D']);
});
test('实际无 value 多选框可勾选多个，并将提交字母映射为正确/错误组合记录', async () => {
  const inputs = fixture();
  const q = {heading:'13.回归测试（多选题）',question:'回归测试',type:'checkbox',remaining:10,
    options:inputs.map(x => record.option(x.closest('label').textContent)),labels:inputs.map(ai.optionLabel)};
  const answers = [q.options[1],q.options[2],q.options[3]];
  const selector = ai.createAutoSelector({read:() => q,inputs:() => inputs,settle:async () => {}});
  assert.match(await selector.select(q,answers),/已自动勾选/);
  assert.deepEqual(inputs.map(x => x.checked),[false,true,true,true]);
  const actual = record.submittedAnswers({q,inputs},'BCD');
  assert.deepEqual(actual,answers);
  assert.deepEqual(record.learn(q,null,actual,'correct').answers,answers);
  assert.deepEqual(record.learn(q,null,actual,'wrong').wrongAnswers,[answers]);
  for(const invalid of ['', 'on', 'BB', 'Z']) assert.deepEqual(record.submittedAnswers({q,inputs},invalid),[]);
});
