#!/usr/bin/env node
/**
 * 脚本结构校验器单测 (O4.1 验收)
 * 用法: node scripts/test_script_validator.js
 * 覆盖: 合法四段式 / 缺 hook / 缺 twist / 缺 cta / scenes 不足 / 时长不符
 */

const assert = require('assert');
const { validateScriptStructure } = require('../workflow_engine/script_validator');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`   ✅ ${name}`);
  } catch (e) {
    failed++;
    console.error(`   ❌ ${name}: ${e.message}`);
  }
}

// ============ 测试夹具 ============
function makeValidScript(overrides = {}) {
  return {
    title: 'AI正在改变你的课堂',
    total_duration: 36,
    hook: '你孩子的老师，可能要被AI取代了？',
    cta: '关注我，下期揭秘更多AI黑科技。',
    scenes: [
      { index: 1, text: '你孩子的老师，可能要被AI取代了？', duration: 4, required_tags: ['科技感'] },
      { index: 2, text: '但是，真相可能和你想的完全相反。', duration: 6, required_tags: ['场景'] },
      { index: 3, text: 'AI其实是帮老师减负，不是取代。', duration: 8, required_tags: ['教育'] },
      { index: 4, text: '它能自动批改作业，生成个性化教案。', duration: 8, required_tags: ['数据'] },
      { index: 5, text: '所以真正会被淘汰的，是拒绝学习的人。', duration: 6, required_tags: ['警示'] },
      { index: 6, text: '关注我，下期揭秘更多AI黑科技。', duration: 4, required_tags: ['互动'] },
    ],
    ...overrides,
  };
}

// ============ 用例 ============
test('合法四段式脚本应通过', () => {
  const r = validateScriptStructure(makeValidScript());
  assert.strictEqual(r.passed, true, JSON.stringify(r.errors));
  assert.strictEqual(r.sceneRoles[0], 'hook');
  assert.strictEqual(r.sceneRoles[5], 'cta');
});

test('缺少 hook 字段应失败', () => {
  const s = makeValidScript();
  delete s.hook;
  const r = validateScriptStructure(s);
  assert.strictEqual(r.passed, false);
  assert.ok(r.errors.some(e => e.includes('hook')));
});

test('缺少 cta 字段应失败', () => {
  const s = makeValidScript();
  delete s.cta;
  const r = validateScriptStructure(s);
  assert.strictEqual(r.passed, false);
  assert.ok(r.errors.some(e => e.includes('cta') || e.includes('CTA')));
});

test('缺少反差段应失败', () => {
  const s = makeValidScript();
  // 所有场景改为普通叙述，不含任何转折/反差关键词
  s.scenes = s.scenes.map((sc, i) => ({
    ...sc,
    text: `这里是对第${i + 1}部分内容的常规介绍说明。`,
  }));
  const r = validateScriptStructure(s);
  assert.strictEqual(r.passed, false);
  assert.ok(r.errors.some(e => e.includes('反差')));
});

test('scenes 不足 5 段应失败', () => {
  const s = makeValidScript();
  s.scenes = s.scenes.slice(0, 4);
  const r = validateScriptStructure(s);
  assert.strictEqual(r.passed, false);
  assert.ok(r.errors.some(e => e.includes('至少 5 段')));
});

test('时长偏差超过容差应失败', () => {
  const s = makeValidScript({ total_duration: 99 });
  const r = validateScriptStructure(s);
  assert.strictEqual(r.passed, false);
  assert.ok(r.errors.some(e => e.includes('duration')));
});

test('单段文案超 50 字应失败', () => {
  const s = makeValidScript();
  s.scenes[3].text = '非常'.repeat(20) + '这是一个超过五十字的长文案内容测试';  // 40+15=55 字
  const r = validateScriptStructure(s);
  assert.strictEqual(r.passed, false);
  assert.ok(r.errors.some(e => e.includes('超过上限')));
});

test('显式 role 字段应被识别', () => {
  const s = makeValidScript();
  s.scenes[1].role = 'twist';
  s.scenes[2].role = 'value';
  s.scenes[3].role = 'value';
  s.scenes[4].role = 'value';
  const r = validateScriptStructure(s);
  assert.strictEqual(r.passed, true, JSON.stringify(r.errors));
});

// ============ 结果 ============
console.log(`\n单测结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
