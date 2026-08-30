#!/usr/bin/env node
/**
 * 脚本结构校验器 (O4.1)
 * 四段式结构（钩子 Hook / 反差 Twist / 干货 Value / 行动号召 CTA）自动校验
 *
 * 支持两种模式:
 * 1. 显式 role: scenes[i].role ∈ {hook, twist, value, cta}（O4.2 生成后）
 * 2. 启发式: 通过 hook/cta 字段 + 位置 + 关键词推断
 *
 * 用法:
 *   const { validateScriptStructure } = require('./script_validator');
 *   const result = validateScriptStructure(script);
 */

const MAX_TEXT_LEN = 50;      // 每段文案上限
const MIN_SCENES = 5;         // 最少分镜数
const MAX_DURATION_DIFF = 2;  // 时长偏差容差（秒）

// 反差/转折关键词（启发式判断 twist 段）
const TWIST_KEYWORDS = [
  '但是', '然而', '可是', '不过', '其实', '没想到', '反转', '真相',
  '误区', '错', '原来', '竟然', '居然', '事实上', '关键是', '真正',
  'but', 'however', 'actually', 'surprisingly', 'twist', 'trap',
];

// 行动号召关键词（启发式判断 cta 段）
const CTA_KEYWORDS = [
  '关注', '点赞', '评论', '收藏', '转发', '分享', '订阅', '关注我',
  '关注我们', '下期', '评论区', '别忘了', '喜欢的话', '记得', 'follow',
  'like', 'subscribe', 'share', 'comment',
];

/**
 * 推断单个 scene 的段落类型（启发式）
 */
function inferRole(scene, index, total, script) {
  const text = (scene.text || '') + (scene.role ? '' : '');
  // 显式 role 优先
  if (scene.role && ['hook', 'twist', 'value', 'cta'].includes(scene.role)) {
    return scene.role;
  }

  // 第一段 → hook（若脚本有 hook 字段，钩子通常也是开场）
  if (index === 0) return 'hook';

  // 最后一段 → cta
  if (index === total - 1) return 'cta';

  // 含反差关键词 → twist
  if (TWIST_KEYWORDS.some(k => text.includes(k))) return 'twist';

  // 默认干货
  return 'value';
}

/**
 * 校验脚本四段式结构
 * @param {Object} script - 脚本 JSON
 * @returns {{ passed: boolean, errors: string[], warnings: string[], structure: Object, sceneRoles: string[] }}
 */
function validateScriptStructure(script) {
  const errors = [];
  const warnings = [];

  if (!script || typeof script !== 'object') {
    return { passed: false, errors: ['脚本为空或非对象'], warnings: [], structure: null, sceneRoles: [] };
  }

  // ============ 基础校验 ============
  if (!script.title || !String(script.title).trim()) {
    errors.push('缺少 title（视频标题）');
  }

  // 基础校验：hook/cta 必须为脚本显式字段（O4.2 prompt 强制输出）
  if (!script.hook || !String(script.hook).trim()) {
    errors.push('缺少 hook 字段（开场钩子文案）');
  }

  const cta = script.cta;
  if (!cta || !String(cta).trim()) {
    errors.push('缺少 cta 字段（结尾行动号召）');
  }

  const scenes = script.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) {
    errors.push('缺少 scenes 数组');
    return { passed: false, errors, warnings, structure: null, sceneRoles: [] };
  }

  if (scenes.length < MIN_SCENES) {
    errors.push(`scenes 至少 ${MIN_SCENES} 段，当前 ${scenes.length} 段`);
  }

  // 每段内容校验
  scenes.forEach((scene, i) => {
    const text = (scene.text || '').trim();
    if (!text) {
      errors.push(`scene[${i + 1}] 缺少 text`);
    } else if ([...text].length > MAX_TEXT_LEN) {
      errors.push(`scene[${i + 1}] 文案 ${[...text].length} 字，超过上限 ${MAX_TEXT_LEN} 字`);
    }

    if (!scene.required_tags || scene.required_tags.length === 0) {
      warnings.push(`scene[${i + 1}] 缺少 required_tags`);
    }
  });

  // 时长校验
  const totalDuration = script.total_duration || 0;
  const durationSum = scenes.reduce((sum, s) => sum + (parseFloat(s.duration) || 0), 0);
  if (totalDuration > 0 && Math.abs(durationSum - totalDuration) > MAX_DURATION_DIFF) {
    errors.push(`duration 之和 ${durationSum}s 与 total_duration ${totalDuration}s 偏差超过 ${MAX_DURATION_DIFF}s`);
  }

  // ============ 四段式结构校验 ============
  const sceneRoles = scenes.map((scene, i) => inferRole(scene, i, scenes.length, script));
  const structure = {
    hook: { found: false, evidence: [] },
    twist: { found: false, evidence: [] },
    value: { found: false, evidence: [] },
    cta: { found: false, evidence: [] },
  };

  sceneRoles.forEach((role, i) => {
    structure[role].found = true;
    structure[role].evidence.push(scenes[i].text.slice(0, 20));
  });

  // hook 要求：必须存在，且位于开头（前两段内）
  if (!structure.hook.found) {
    errors.push('缺少 钩子(Hook) 段：开场 3 秒必须制造悬念或抛出痛点');
  } else {
    const hookIdx = sceneRoles.indexOf('hook');
    if (hookIdx > 1) {
      warnings.push(`钩子应在开头（前两段内），实际出现在第 ${hookIdx + 1} 段`);
    }
  }

  // twist 要求：必须存在反差/转折段
  if (!structure.twist.found) {
    errors.push('缺少 反差(Twist) 段：需要制造对比/意外/反转来打破预期');
  }

  // value 要求：至少 1 段干货
  if (!structure.value.found) {
    errors.push('缺少 干货(Value) 段：需要输出核心信息/知识点');
  }

  // cta 要求：必须存在，且位于末尾
  if (!structure.cta.found) {
    errors.push('缺少 行动号召(CTA) 段：结尾需引导关注/点赞/评论');
  } else {
    const ctaIdx = sceneRoles.lastIndexOf('cta');
    if (ctaIdx !== scenes.length - 1) {
      warnings.push(`CTA 应在最后一段，实际位于第 ${ctaIdx + 1} 段（后面还有 ${scenes.length - 1 - ctaIdx} 段）`);
    }
  }

  // 顺序校验：hook 在 twist 前，twist 在 value 前（若都存在）
  if (structure.hook.found && structure.twist.found && structure.value.found) {
    const h = sceneRoles.indexOf('hook');
    const t = sceneRoles.indexOf('twist');
    const v = sceneRoles.indexOf('value');
    const c = sceneRoles.lastIndexOf('cta');
    if (!(h < t && t < c)) {
      errors.push(`四段式顺序应为 钩子→反差→干货→CTA，实际 hook@${h} twist@${t} value@${v} cta@${c}`);
    }
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
    structure,
    sceneRoles,
  };
}

// ============ CLI ============
if (require.main === module) {
  const scriptFile = process.argv[2];
  if (!scriptFile) {
    console.log('用法: node script_validator.js <脚本JSON文件>');
    process.exit(1);
  }
  const script = JSON.parse(require('fs').readFileSync(scriptFile, 'utf-8'));
  const result = validateScriptStructure(script);
  console.log(result.passed ? '✅ 通过' : '❌ 失败');
  console.log(JSON.stringify({ ...result, structure: result.structure }, null, 2));
  process.exit(result.passed ? 0 : 1);
}

module.exports = { validateScriptStructure, inferRole, TWIST_KEYWORDS, CTA_KEYWORDS };
