#!/usr/bin/env node
/**
 * 素材检索模块 (T1.7)
 * 基于标签 + 场景 + 质量三维度匹配素材
 * 
 * 用法:
 *   node asset_search.js <分镜JSON文件> [素材元数据目录]
 */

const fs = require('fs');
const path = require('path');

const ASSETS_DIR = path.resolve(__dirname, '..', 'assets');

/**
 * 加载所有素材元数据
 */
function loadAssetMetadata(metadataDir) {
  const dir = metadataDir || path.join(ASSETS_DIR, 'metadata');
  if (!fs.existsSync(dir)) {
    console.warn(`⚠️ 素材元数据目录不存在: ${dir}`);
    return [];
  }

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const assets = [];

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
      assets.push(data);
    } catch (e) {
      console.warn(`跳过无效元数据: ${file}`);
    }
  }

  return assets;
}

/**
 * 标签匹配得分
 */
function tagMatchScore(requiredTags, assetTags) {
  if (!requiredTags || requiredTags.length === 0) return 0.5; // 无要求时给中等分
  const overlap = requiredTags.filter(t => assetTags.includes(t)).length;
  return overlap / Math.max(requiredTags.length, 1);
}

/**
 * 场景匹配得分
 */
function scenarioMatchScore(suggestion, assetScenario) {
  if (!suggestion || !assetScenario) return 0;
  const s = suggestion.toLowerCase();
  const a = assetScenario.toLowerCase();
  // 简单关键词匹配
  const keywords = ['特写', '展示', '场景', '采访', '动画', '数据', '科技', '产品', '实拍'];
  let matches = 0;
  for (const kw of keywords) {
    if (s.includes(kw) && a.includes(kw)) matches++;
  }
  return Math.min(1, matches / 3);
}

/**
 * 质量得分
 */
function qualityScore(quality) {
  const map = { 'S': 1.0, 'A': 0.8, 'B': 0.6, 'C': 0.4 };
  return map[quality] || 0.5;
}

/**
 * 时长适配得分
 */
function durationFitScore(requiredDuration, assetDuration, start, end) {
  const available = (end || assetDuration) - (start || 0);
  if (available <= 0) return 0;
  const ratio = Math.min(available, requiredDuration) / Math.max(available, requiredDuration);
  return ratio;
}

/**
 * 为单个分镜匹配候选素材
 * @param {object} scene - 分镜 { required_tags, suggestion, duration }
 * @param {array} assets - 素材列表
 * @param {object} options - { topK, usedAssets }
 * @returns {array} 候选素材列表（按 score 降序）
 */
function matchScene(scene, assets, options = {}) {
  const { topK = 5, usedAssets = new Set() } = options;
  const results = [];

  for (const asset of assets) {
    const file = asset.file || asset.file_path || '';
    const assetTags = asset.tags || [];
    const scenario = asset.scenario || '';
    const quality = asset.quality || 'B';
    const duration = asset.duration || 0;

    // 去重：同一素材不在相邻分镜重复使用
    if (usedAssets.has(file)) continue;

    const tagScore = tagMatchScore(scene.required_tags, assetTags);
    const scenarioScore = scenarioMatchScore(scene.suggestion, scenario);
    const qScore = qualityScore(quality);
    const durScore = durationFitScore(scene.duration, duration, 0, duration);

    // 加权求和
    const score = tagScore * 0.4 + scenarioScore * 0.3 + qScore * 0.2 + durScore * 0.1;

    results.push({
      file: file,
      file_path: asset.file_path || `assets/videos/${file}`,
      start: 0,
      end: duration,
      score: Math.round(score * 100) / 100,
      tags: assetTags,
      quality: quality,
      match_reason: buildMatchReason(tagScore, scenarioScore, qScore, durScore),
    });
  }

  // 按 score 降序排序
  results.sort((a, b) => b.score - a.score);

  // 取 topK
  const candidates = results.slice(0, topK).filter(r => r.score > 0);

  // 如果没有匹配素材
  if (candidates.length === 0) {
    return [];
  }

  // 标记已使用（第一个候选）
  if (candidates.length > 0) {
    usedAssets.add(candidates[0].file);
  }

  return candidates;
}

function buildMatchReason(tag, scenario, quality, duration) {
  const parts = [];
  if (tag > 0.5) parts.push('标签匹配');
  if (scenario > 0.5) parts.push('场景匹配');
  if (quality > 0.7) parts.push('高质量素材');
  if (duration > 0.8) parts.push('时长适配');
  return parts.join(' + ') || '综合匹配';
}

/**
 * 为完整分镜脚本匹配所有素材
 * @param {object} script - 分镜脚本 JSON (含 scenes 数组)
 * @param {array} assets - 素材列表
 * @param {object} options
 * @returns {object} 增强的分镜 JSON
 */
function matchAllScenes(script, assets, options = {}) {
  const usedAssets = new Set();
  const enhancedScenes = [];

  for (const scene of (script.scenes || [])) {
    const candidates = matchScene(scene, assets, { ...options, usedAssets });
    enhancedScenes.push({
      ...scene,
      candidates: candidates,
      no_match: candidates.length === 0,
    });
  }

  return {
    ...script,
    scenes: enhancedScenes,
  };
}

// ============ CLI ============
if (require.main === module) {
  const args = process.argv.slice(2);
  const scriptFile = args[0];
  const metadataDir = args[1];

  if (!scriptFile) {
    console.log('用法: node asset_search.js <分镜JSON文件> [素材元数据目录]');
    console.log('示例: node asset_search.js ../scripts/pipe_xxx_script.json');
    process.exit(1);
  }

  const scriptData = JSON.parse(fs.readFileSync(scriptFile, 'utf-8'));
  const script = scriptData.script || scriptData;
  const assets = loadAssetMetadata(metadataDir);

  console.log(`📂 素材库: ${assets.length} 条素材`);
  console.log(`🎬 分镜数: ${(script.scenes || []).length}`);

  const result = matchAllScenes(script, assets);

  const matchCount = result.scenes.filter(s => !s.no_match).length;
  console.log(`✅ 匹配成功: ${matchCount}/${result.scenes.length}`);
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { matchScene, matchAllScenes, loadAssetMetadata };
