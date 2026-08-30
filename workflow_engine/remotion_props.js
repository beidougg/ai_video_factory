#!/usr/bin/env node
/**
 * Remotion Props 生成器 (T2.2)
 * 将脚本 JSON + 素材检索结果 → Remotion 可渲染的 props JSON
 *
 * 用法:
 *   node remotion_props.js <脚本JSON文件> [素材检索结果JSON] [配音MP3路径]
 *   或作为模块: const { generateProps } = require('./remotion_props');
 */

const fs = require('fs');
const path = require('path');
const { resolveTemplate } = require('./render');

const PROJECT_DIR = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_DIR, 'outputs');

// ============ 配置 ============
const CONFIG = {
  width: 1920,
  height: 1080,
  fps: 30,
  defaultSubtitleStyle: {
    fontSize: 42,
    color: '#ffffff',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
};

/**
 * 根据 options 解析模板（O1.3）
 * 若指定 platform，则自动映射到对应方向的默认模板及尺寸
 * @returns {{ template: string, width: number, height: number, orientation: string }}
 */
function resolveTemplateOptions(options = {}) {
  // 无 platform 时用显式模板或默认横屏
  if (!options.platform && !options.orientation) {
    return {
      template: options.template || 'product_showcase',
      width: options.width || CONFIG.width,
      height: options.height || CONFIG.height,
      orientation: 'landscape',
    };
  }

  // 有 platform/orientation 时走注册表解析
  try {
    const tpl = resolveTemplate({ template: options.template, platform: options.platform, orientation: options.orientation });
    return {
      template: tpl.id,
      width: options.width || tpl.dimensions.width,
      height: options.height || tpl.dimensions.height,
      orientation: tpl.orientation,
    };
  } catch (e) {
    // 注册表缺失时回退到默认
    console.warn(`⚠️ 模板解析失败，使用默认横屏: ${e.message}`);
    return {
      template: options.template || 'product_showcase',
      width: options.width || CONFIG.width,
      height: options.height || CONFIG.height,
      orientation: 'landscape',
    };
  }
}

// ============ 工具函数 ============
/**
 * 递归查找包含 scenes 数组的对象 (兼容多种 JSON 结构)
 */
function findScript(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.scenes && Array.isArray(obj.scenes)) return obj;
  for (const key of Object.keys(obj)) {
    const found = findScript(obj[key]);
    if (found) return found;
  }
  return null;
}

/**
 * 从资产检索结果中提取候选素材
 */
function extractCandidates(searchResult, sceneIndex) {
  if (!searchResult) return [];

  // 兼容多种结构
  const results = searchResult.results || searchResult.scenes || searchResult.data || searchResult;
  if (Array.isArray(results)) {
    // 按 index 匹配
    const match = results.find(r => {
      const idx = r.index || r.scene_index;
      return idx === sceneIndex;
    });
    if (match) return match.candidates || [];
  }

  // 对象格式: { "1": [...], "2": [...] }
  if (typeof results === 'object') {
    const key = String(sceneIndex);
    if (results[key]) return results[key];
  }

  return [];
}

/**
 * 计算分镜的累积起始时间
 */
function calculateSceneTimings(scenes) {
  let cumulative = 0;
  return scenes.map((scene, i) => {
    const start = cumulative;
    const duration = scene.duration || 5;
    cumulative += duration;
    return {
      index: scene.index || i + 1,
      text: scene.text || '',
      start,
      duration,
      end: cumulative,
      suggestion: scene.suggestion || '',
      requiredTags: scene.required_tags || [],
      candidates: [],
    };
  });
}

// ============ 核心函数 ============
/**
 * 生成 Remotion props JSON
 * @param {Object} scriptData - 脚本数据 (含 scenes 数组)
 * @param {Object|null} assetResults - 素材检索结果
 * @param {string|null} audioSrc - 配音 MP3 路径 (绝对路径)
 * @param {Object} options - 可选配置
 * @returns {Object} Remotion 兼容的 props
 */
function generateProps(scriptData, assetResults = null, audioSrc = null, options = {}) {
  // 1. 提取脚本
  const script = findScript(scriptData);
  if (!script || !script.scenes) {
    throw new Error('无效的脚本数据: 缺少 scenes 数组');
  }

  // 2. 计算时间线
  const scenes = calculateSceneTimings(script.scenes);

  // 3. 匹配素材
  for (const scene of scenes) {
    const candidates = extractCandidates(assetResults, scene.index);
    scene.candidates = candidates.map(c => ({
      file: c.file || path.basename(c.file_path || ''),
      file_path: c.file_path || '',
      start: c.start || 0,
      end: c.end || scene.duration,
      score: c.score || 0,
    }));
  }

  // 4. 解析模板及尺寸（O1.3：支持 platform 自动映射横/竖屏）
  const tplOptions = resolveTemplateOptions(options);

  // 5. 构建 props
  const totalDuration = scenes.reduce((sum, s) => sum + s.duration, 0);

  return {
    // Remotion 渲染参数
    durationInFrames: Math.ceil(totalDuration * CONFIG.fps),
    fps: CONFIG.fps,
    width: tplOptions.width,
    height: tplOptions.height,

    // 模板名称
    template: tplOptions.template,
    // 平台/方向（供 render.js 解析模板用）
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.orientation ? { orientation: options.orientation } : {}),
    // BGM（供 render.js 混音用，O2.2）
    ...(options.bgm ? { bgm: options.bgm } : {}),

    // props 传递给组件
    props: {
      scenes,
      total_duration: totalDuration,
      audioSrc: audioSrc || '',
      subtitleStyle: {
        ...CONFIG.defaultSubtitleStyle,
        ...(options.subtitleStyle || {}),
      },
      title: script.title || '',
      // 模板自定义字段
      custom: options.custom || {},
    },

    // 元信息
    meta: {
      generatedAt: new Date().toISOString(),
      sceneCount: scenes.length,
      totalDuration,
      hasAudio: !!audioSrc,
      hasAssets: scenes.some(s => s.candidates.length > 0),
      scenesSummary: scenes.map(s => ({
        index: s.index,
        text: s.text.slice(0, 40),
        duration: s.duration,
        candidates: s.candidates.length,
      })),
    },
  };
}

/**
 * 生成并保存 props 文件
 */
function generateAndSave(scriptData, assetResults, audioSrc, pipelineId, options = {}) {
  const props = generateProps(scriptData, assetResults, audioSrc, options);

  // 确保输出目录存在
  const outDir = path.join(OUTPUT_DIR, pipelineId || `props_${Date.now()}`);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // 保存完整的 render.json (Remotion 渲染用)
  const renderJsonPath = path.join(outDir, 'render.json');
  const renderData = {
    entry: `templates/${props.template}/src/index.tsx`,
    ...props,
  };
  fs.writeFileSync(renderJsonPath, JSON.stringify(renderData, null, 2), 'utf-8');

  // 保存纯净的 props.json (组件用)
  const propsJsonPath = path.join(outDir, 'props.json');
  fs.writeFileSync(propsJsonPath, JSON.stringify(props.props, null, 2), 'utf-8');

  console.log(`✅ Remotion props 已生成:`);
  console.log(`   render.json: ${renderJsonPath}`);
  console.log(`   props.json:  ${propsJsonPath}`);
  console.log(`   分镜数: ${props.meta.sceneCount}, 总时长: ${props.meta.totalDuration}s`);

  return { props, renderJsonPath, propsJsonPath, outDir };
}

// ============ CLI ============
if (require.main === module) {
  const scriptFile = process.argv[2];
  const assetFile = process.argv[3];
  const audioPath = process.argv[4];
  const pipelineId = process.argv[5];

  if (!scriptFile) {
    console.log('用法: node remotion_props.js <脚本JSON> [素材检索JSON] [配音MP3] [pipelineId]');
    console.log('示例: node remotion_props.js scripts/pipe_xxx_result.json outputs/test_tts/voice.mp3');
    process.exit(1);
  }

  // 加载数据
  const scriptData = JSON.parse(fs.readFileSync(scriptFile, 'utf-8'));
  const assetResults = assetFile ? JSON.parse(fs.readFileSync(assetFile, 'utf-8')) : null;

  const result = generateAndSave(scriptData, assetResults, audioPath, pipelineId);
  console.log(`\n📦 输出目录: ${result.outDir}`);
}

module.exports = { generateProps, generateAndSave, findScript, calculateSceneTimings };
