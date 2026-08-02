#!/usr/bin/env node
/**
 * 视频渲染管线 (T2.3 + T2.5)
 * Remotion 渲染 + FFmpeg 字幕合成 + 质检 + 自动重试
 *
 * 用法:
 *   node render.js <props目录或render.json> [pipelineId]
 *   或作为模块: const { renderPipeline } = require('./render');
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { runQC } = require('./qc');

const PROJECT_DIR = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_DIR, 'outputs');
const MAX_RETRIES = 2; // T2.5: 最多重试 2 次

// ============ 配置 ============
const CONFIG = {
  // Remotion 命令行参数
  remotion: {
    fps: 30,
    codec: 'h264',
    crf: 23,
    quality: 'high',
    pixelFormat: 'yuv420p',
    timeout: 600000, // 10 分钟超时
  },
  // FFmpeg 字幕合成参数
  ffmpeg: {
    fontName: 'Noto Sans CJK SC',
    fontSize: 36,
    primaryColor: '#FFFFFF',
    outlineColor: '#000000',
    outlineWidth: 3,
    alignment: 2, // 底部居中
    marginV: 80,
  },
};

// ============ 工具函数 ============
/**
 * 查找 props 数据 (兼容目录或文件)
 */
function loadRenderData(inputPath) {
  let renderJsonPath, propsDir;

  if (fs.statSync(inputPath).isDirectory()) {
    propsDir = inputPath;
    renderJsonPath = path.join(inputPath, 'render.json');
  } else {
    propsDir = path.dirname(inputPath);
    renderJsonPath = inputPath;
  }

  if (!fs.existsSync(renderJsonPath)) {
    // 尝试 props.json
    const propsJson = path.join(propsDir, 'props.json');
    if (fs.existsSync(propsJson)) {
      return { propsDir, renderJsonPath, data: JSON.parse(fs.readFileSync(propsJson, 'utf-8')) };
    }
    throw new Error(`找不到 render.json 或 props.json: ${inputPath}`);
  }

  return {
    propsDir,
    renderJsonPath,
    data: JSON.parse(fs.readFileSync(renderJsonPath, 'utf-8')),
  };
}

/**
 * 生成 VTT 字幕文件 (从 props 的 scenes 生成)
 */
function generateVTT(renderData, outputPath) {
  const scenes = renderData.props?.scenes || [];
  if (scenes.length === 0) return null;

  let vtt = 'WEBVTT\n\n';
  for (const scene of scenes) {
    const start = formatVTTTime(scene.start);
    const end = formatVTTTime(scene.start + scene.duration);
    vtt += `${start} --> ${end}\n`;
    vtt += `${scene.text}\n\n`;
  }

  fs.writeFileSync(outputPath, vtt, 'utf-8');
  console.log(`   📝 VTT 字幕已生成: ${outputPath}`);
  return outputPath;
}

function formatVTTTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = (seconds % 60).toFixed(3);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(6, '0')}`;
}

// ============ 渲染步骤 ============

/**
 * Step 1: Remotion 渲染
 * @returns {{ success: boolean, outputFile: string, duration: number }}
 */
async function stepRemotionRender(propsDir, renderData, attempt = 1) {
  const entry = renderData.entry || 'templates/product_showcase/src/index.tsx';
  const entryPath = path.join(PROJECT_DIR, entry);
  const tempOutput = path.join(propsDir, `raw_${attempt}.mp4`);

  console.log(`   🎬 Remotion 渲染 (尝试 #${attempt})...`);

  // 将 props 写入临时文件
  const propsJson = path.join(propsDir, 'props.json');
  const props = {
    ...(renderData.props || renderData),
    // Remotion 根参数
  };
  fs.writeFileSync(propsJson, JSON.stringify(props, null, 2), 'utf-8');

  const args = [
    'npx', 'remotion', 'render',
    entry,
    tempOutput,
    `--props=${propsJson}`,
    `--fps=${renderData.fps || CONFIG.remotion.fps}`,
    `--codec=${CONFIG.remotion.codec}`,
    `--pixel-format=${CONFIG.remotion.pixelFormat}`,
  ];

  // 如果有 duration (frames 或 seconds)
  if (renderData.durationInFrames) {
    args.push(`--frames=${renderData.durationInFrames}`);
  }

  const startTime = Date.now();

  try {
    execSync(args.join(' '), {
      cwd: path.join(PROJECT_DIR, 'templates/product_showcase'),
      timeout: CONFIG.remotion.timeout,
      stdio: 'inherit',
    });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`   ✅ Remotion 渲染完成: ${tempOutput} (${elapsed}s)`);
    return { success: true, outputFile: tempOutput, duration: elapsed };
  } catch (e) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`   ❌ Remotion 渲染失败 (${elapsed}s):`, e.message);
    return { success: false, outputFile: null, duration: elapsed, error: e.message };
  }
}

/**
 * Step 2: FFmpeg 字幕合成
 */
function stepFFmpegBurnSubtitles(rawVideo, subtitlesPath, outputFile) {
  console.log('   🎤 FFmpeg 字幕合成...');

  // 尝试从 VTT 文件烧录字幕
  const vttFile = subtitlesPath || path.join(path.dirname(rawVideo), 'subtitles.vtt');

  if (fs.existsSync(vttFile)) {
    try {
      execSync(
        `ffmpeg -y -i "${rawVideo}" -vf "subtitles=${path.basename(vttFile)}:force_style='FontName=${CONFIG.ffmpeg.fontName},FontSize=${CONFIG.ffmpeg.fontSize},PrimaryColour=${CONFIG.ffmpeg.primaryColor},OutlineColour=${CONFIG.ffmpeg.outlineColor},Alignment=${CONFIG.ffmpeg.alignment}'" -c:a copy "${outputFile}"`,
        { cwd: path.dirname(vttFile), stdio: 'inherit', timeout: 300000 }
      );
      console.log(`   ✅ 字幕已烧录: ${outputFile}`);
      return outputFile;
    } catch (e) {
      console.warn(`   ⚠️ 字幕烧录失败: ${e.message}, 使用原始视频`);
    }
  }

  // 无字幕或烧录失败，直接复制
  fs.copyFileSync(rawVideo, outputFile);
  console.log(`   ℹ️ 跳过字幕 (使用原始视频)`);
  return outputFile;
}

/**
 * Step 3: 质检
 */
function stepQC(videoPath) {
  console.log('   🔍 质检...');
  const result = runQC(videoPath);
  if (result.passed) {
    console.log('   ✅ 质检通过');
  } else {
    console.log(`   ❌ 质检失败: ${result.failed_checks?.join(', ')}`);
  }
  return result;
}

// ============ 完整管线 ============
/**
 * 执行完整渲染管线 (含自动重试)
 * @param {string} inputPath - props 目录或 render.json 路径
 * @param {string} pipelineId - 管线 ID
 * @returns {{ success: boolean, outputFile: string, qcResult, retries: number, duration: number }}
 */
async function renderPipeline(inputPath, pipelineId = `render_${Date.now()}`) {
  console.log('\n' + '='.repeat(60));
  console.log(`🎬 渲染管线启动`);
  console.log(`   Pipeline: ${pipelineId}`);
  console.log(`   输入: ${inputPath}`);
  console.log('='.repeat(60));

  const startTime = Date.now();

  // 1. 加载数据
  console.log('\n📂 加载渲染数据...');
  const { propsDir, data: renderData } = loadRenderData(inputPath);
  console.log(`   模板: ${renderData.entry || 'product_showcase'}`);
  console.log(`   分镜: ${renderData.props?.scenes?.length || '?'} 个`);

  // 2. 生成 VTT 字幕
  const vttPath = path.join(propsDir, 'subtitles.vtt');
  generateVTT(renderData, vttPath);

  // 3. 渲染 + 重试
  const finalPath = path.join(propsDir, 'final.mp4');
  let renderSuccess = false;
  let retries = 0;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    retries = attempt - 1;

    const renderResult = await stepRemotionRender(propsDir, renderData, attempt);
    if (!renderResult.success) {
      lastError = renderResult.error;
      if (attempt <= MAX_RETRIES) {
        console.log(`   🔄 自动重试 (${attempt}/${MAX_RETRIES})...`);
        continue;
      }
      console.error(`   ❌ 已达最大重试次数 (${MAX_RETRIES}次)`);
      break;
    }

    // 字幕合成
    const rawVideo = renderResult.outputFile;
    stepFFmpegBurnSubtitles(rawVideo, vttPath, finalPath);

    // 质检
    const qcResult = stepQC(finalPath);
    if (qcResult.passed) {
      renderSuccess = true;
      break;
    }

    // T2.5: 质检失败，清除非音频检查失败后重试
    if (attempt <= MAX_RETRIES) {
      const nonAudio = qcResult.failed_checks?.filter(c => c !== 'audio');
      if (nonAudio?.length > 0) {
        console.log(`   🔄 质检失败 (${qcResult.failed_checks.join(', ')}), 自动重试...`);
        continue;
      }
      // 音频问题无法通过重试解决
      console.log(`   ❌ 音频质检失败，无法通过重试修复`);
      break;
    }
  }

  const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);

  // 4. 输出最终结果
  console.log('\n' + '='.repeat(60));
  console.log('📊 渲染管线完成');
  console.log(`   成功: ${renderSuccess ? '✅' : '❌'}`);
  console.log(`   输出: ${renderSuccess ? finalPath : '无'}`);
  console.log(`   重试: ${retries} 次`);
  console.log(`   耗时: ${totalDuration}s`);
  console.log('='.repeat(60));

  const result = {
    success: renderSuccess,
    pipelineId,
    outputFile: renderSuccess ? finalPath : null,
    outputDir: propsDir,
    retries,
    duration: totalDuration,
    renderData: {
      entry: renderData.entry,
      sceneCount: renderData.props?.scenes?.length || 0,
      totalDuration: renderData.props?.total_duration || 0,
    },
  };

  // 保存管线结果
  fs.writeFileSync(
    path.join(propsDir, 'render_result.json'),
    JSON.stringify(result, null, 2),
    'utf-8'
  );

  return result;
}

// ============ CLI ============
if (require.main === module) {
  const inputPath = process.argv[2];
  const pipelineId = process.argv[3];

  if (!inputPath) {
    console.log('用法: node render.js <props目录或render.json> [pipelineId]');
    console.log('示例: node render.js outputs/pipe_xxx/');
    console.log('      node render.js outputs/pipe_xxx/render.json');
    process.exit(1);
  }

  renderPipeline(inputPath, pipelineId)
    .then(result => {
      process.exit(result.success ? 0 : 1);
    })
    .catch(err => {
      console.error('渲染管线崩溃:', err.message);
      process.exit(2);
    });
}

module.exports = { renderPipeline, loadRenderData, generateVTT, stepRemotionRender, stepQC };
