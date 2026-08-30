#!/usr/bin/env node
/**
 * BGM 混音模块 (O2.2)
 * 用 FFmpeg 将语音与背景音乐混合：BGM 音量 ≤30%、淡入淡出、时长适配语音
 *
 * 用法:
 *   node bgm.js <语音mp3> [BGM文件或ID] [输出路径]
 *   或作为模块: const { mixBGM, pickBGM } = require('./bgm');
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ffmpeg: _ffmpeg, ffprobe: _ffprobe } = require('./ffmpeg');

const PROJECT_DIR = path.resolve(__dirname, '..');
const BGM_DIR = path.join(PROJECT_DIR, 'assets', 'bgm');

// ============ 默认配置 ============
const DEFAULT_OPTIONS = {
  volume: 0.3,      // BGM 音量 30%
  fadeIn: 2,        // 淡入 2 秒
  fadeOut: 2,       // 淡出 2 秒
};

/**
 * 获取音频时长（秒）
 */
function getAudioDuration(ffprobe, file) {
  const out = execSync(
    `"${ffprobe}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${file}"`,
    { encoding: 'utf-8' }
  ).trim();
  const dur = parseFloat(out);
  if (isNaN(dur)) throw new Error(`无法解析音频时长: ${file}`);
  return dur;
}

/**
 * 加载 BGM manifest（若存在）
 */
function loadBgmManifest() {
  const p = path.join(BGM_DIR, 'manifest.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

/**
 * 根据 ID 或 mood 选择 BGM 文件路径
 * @param {string} bgmRef - BGM 文件路径 或 ID 或 mood
 * @returns {string} BGM 文件绝对路径
 */
function pickBGM(bgmRef) {
  // 1. 直接是文件路径
  if (bgmRef && fs.existsSync(bgmRef)) return path.resolve(bgmRef);

  // 2. 是目录下的文件名（如 bright_upbeat.mp3）
  if (bgmRef && fs.existsSync(path.join(BGM_DIR, bgmRef))) {
    return path.join(BGM_DIR, bgmRef);
  }

  // 3. 是 ID（如 bright_upbeat）
  if (bgmRef) {
    const byId = path.join(BGM_DIR, `${bgmRef}.mp3`);
    if (fs.existsSync(byId)) return byId;

    // 按 mood 匹配 manifest
    const manifest = loadBgmManifest();
    if (manifest) {
      const match = manifest.bgms?.find(b => b.id === bgmRef || b.mood === bgmRef || b.name === bgmRef);
      if (match) return path.join(BGM_DIR, match.file);
    }
  }

  // 4. 随机选一个
  const files = fs.readdirSync(BGM_DIR).filter(f => f.endsWith('.mp3'));
  if (files.length === 0) throw new Error(`BGM 目录为空: ${BGM_DIR}`);
  const pick = files[Math.floor(Math.random() * files.length)];
  return path.join(BGM_DIR, pick);
}

/**
 * 将语音与 BGM 混合 (O2.2)
 * @param {string} voicePath - 人声音频路径
 * @param {string} bgmRef - BGM 文件路径或 ID
 * @param {string} outputPath - 输出路径
 * @param {Object} options - { volume, fadeIn, fadeOut }
 * @returns {string} 输出文件路径
 */
function mixBGM(voicePath, bgmRef, outputPath, options = {}) {
  const ffmpeg = _ffmpeg;
  const ffprobe = _ffprobe;
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (!fs.existsSync(voicePath)) throw new Error(`语音文件不存在: ${voicePath}`);
  const bgmPath = pickBGM(bgmRef);
  if (!fs.existsSync(bgmPath)) throw new Error(`BGM 文件不存在: ${bgmPath}`);

  // 语音时长
  const duration = getAudioDuration(ffprobe, voicePath);
  const fadeOutStart = Math.max(0, +(duration - opts.fadeOut).toFixed(2));

  console.log(`\n🎧 BGM 混音`);
  console.log(`   语音: ${path.basename(voicePath)} (${duration.toFixed(1)}s)`);
  console.log(`   BGM:  ${path.basename(bgmPath)} (音量 ${(opts.volume * 100).toFixed(0)}%)`);

  // 确保输出目录存在
  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // filter: BGM 降音量 + 循环 + 淡入淡出；与语音混合，时长以语音为准
  // 两条链用 ; 分隔：链1 处理 BGM 输出 [bgm]；链2 将语音与 BGM 混合
  const filter =
    `[1:a]volume=${opts.volume},` +
    `afade=t=in:st=0:d=${opts.fadeIn},` +
    `afade=t=out:st=${fadeOutStart}:d=${opts.fadeOut}` +
    `[bgm];` +
    `[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=2[aout]`;

  execSync(
    `"${ffmpeg}" -y -i "${voicePath}" -stream_loop -1 -i "${bgmPath}" ` +
    `-filter_complex "${filter}" -map "[aout]" -c:a libmp3lame -q:a 2 "${outputPath}"`,
    { stdio: 'inherit', timeout: 300000 }
  );

  console.log(`   ✅ 混音完成: ${outputPath}`);
  return outputPath;
}

// ============ CLI ============
if (require.main === module) {
  const voicePath = process.argv[2];
  const bgmRef = process.argv[3];
  const outputPath = process.argv[4];

  if (!voicePath) {
    console.log('用法: node bgm.js <语音mp3> [BGM文件或ID] [输出路径]');
    console.log('示例: node bgm.js outputs/xxx/voice.mp3 bright_upbeat outputs/xxx/mixed.mp3');
    process.exit(1);
  }

  const out = outputPath || voicePath.replace(/\.mp3$/, '_mixed.mp3');
  try {
    mixBGM(voicePath, bgmRef, out);
  } catch (e) {
    console.error('❌ 混音失败:', e.message);
    process.exit(1);
  }
}

module.exports = { mixBGM, pickBGM, getAudioDuration };
