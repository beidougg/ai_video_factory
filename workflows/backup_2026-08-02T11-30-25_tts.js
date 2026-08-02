#!/usr/bin/env node
/**
 * TTS 配音生成模块 (T1.10)
 * 使用 edge-tts 将脚本转换为 MP3 配音 + 时间戳 JSON
 * 
 * 用法:
 *   node tts.js <脚本JSON文件> [输出目录]
 */

const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.resolve(__dirname, '..', 'outputs');

/**
 * 将脚本 JSON 生成配音 MP3
 * @param {object} script - 分镜脚本 JSON
 * @param {string} outDir - 输出目录
 * @returns {object} { mp3_path, timestamps, segments }
 */
async function generateVoice(script, outDir) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = outDir || path.join(OUTPUT_DIR, timestamp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  console.log('\n🔊 [TTS] 开始生成配音...');

  // 1. 拼接完整文案
  let fullText = '';
  const segments = [];

  for (let i = 0; i < script.scenes.length; i++) {
    const scene = script.scenes[i];
    const text = scene.text.trim();
    fullText += text + '\n';
    segments.push({
      index: i + 1,
      text: text,
      char_start: fullText.length - text.length - 1,
      char_end: fullText.length - 1,
    });
  }

  // 2. 用 edge-tts 生成 MP3 + 字幕文件
  const vttPath = path.join(dir, 'subtitles.vtt');
  const mp3Path = path.join(dir, 'voice.mp3');

  try {
    console.log(`   生成配音: ${mp3Path}`);
    execSync(
      `python -m edge_tts --voice zh-CN-XiaoxiaoNeural --rate "+10%" --text "${fullText.replace(/"/g, '\\"').replace(/\n/g, ' ')}" --write-media "${mp3Path}" --write-subtitles "${vttPath}"`,
      { timeout: 30000, stdio: 'pipe' }
    );
  } catch (err) {
    // 备用: 写文本文件再读
    const textPath = path.join(dir, 'text.txt');
    fs.writeFileSync(textPath, fullText, 'utf-8');
    execSync(
      `python -m edge_tts --voice zh-CN-XiaoxiaoNeural --rate "+10%" -f "${textPath}" --write-media "${mp3Path}" --write-subtitles "${vttPath}"`,
      { timeout: 30000, stdio: 'pipe' }
    );
  }

  // 3. 解析 VTT 字幕获取时间戳
  const timestamps = parseVTT(vttPath);

  // 4. 将时间戳与分镜对齐
  const alignedScenes = alignWithScenes(timestamps, segments);

  // 5. 保存时间戳 JSON
  const tsPath = path.join(dir, 'timestamps.json');
  fs.writeFileSync(tsPath, JSON.stringify(alignedScenes, null, 2), 'utf-8');

  const fileSize = (fs.statSync(mp3Path).size / 1024).toFixed(1);
  console.log(`✅ TTS 配音完成: ${mp3Path} (${fileSize} KB)`);
  console.log(`   分镜数: ${alignedScenes.length}`);
  console.log(`   时间戳: ${tsPath}`);

  return {
    mp3_path: mp3Path,
    vtt_path: vttPath,
    timestamps: alignedScenes,
    output_dir: dir,
  };
}

/**
 * 解析 VTT 字幕文件提取时间戳
 */
function parseVTT(vttPath) {
  if (!fs.existsSync(vttPath)) return [];

  const content = fs.readFileSync(vttPath, 'utf-8');
  const cues = [];
  const lines = content.split('\n');
  let i = 0;

  while (i < lines.length) {
    // 跳过 WEBVTT 头
    if (lines[i].startsWith('WEBVTT') || lines[i].trim() === '') {
      i++;
      continue;
    }
    // 匹配时间戳行: 00:00:01.000 --> 00:00:03.500
    const match = lines[i]?.match(/([\d:.]+)\s*-->\s*([\d:.]+)/);
    if (match) {
      cues.push({
        start: timeToSeconds(match[1]),
        end: timeToSeconds(match[2]),
        text: (lines[i + 1] || '').trim(),
      });
      i += 2;
    } else {
      i++;
    }
  }

  return cues;
}

function timeToSeconds(t) {
  const parts = t.split(':');
  if (parts.length === 3) {
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
  }
  return parseFloat(t);
}

/**
 * 将 VTT 时间戳对齐到分镜
 */
function alignWithScenes(cues, segments) {
  if (cues.length === 0) {
    return segments.map((s, i) => ({
      index: i + 1,
      text: s.text,
      start: i * 5,  // fallback average
      end: (i + 1) * 5,
      duration: 5,
    }));
  }

  // 简单对齐: 按字符比例分配时间
  const totalChars = segments.reduce((sum, s) => sum + s.text.length, 0);
  const totalDuration = cues[cues.length - 1]?.end || segments.length * 5;

  return segments.map((seg) => {
    const ratio = seg.text.length / totalChars;
    const duration = Math.max(1, totalDuration * ratio);
    return {
      index: seg.index,
      text: seg.text,
      start: seg.index === 1 ? 0 : undefined, // 由累加确定
      end: undefined,
      duration: Math.round(duration * 10) / 10,
    };
  }).map((seg, i, arr) => {
    const start = i === 0 ? 0 : arr[i - 1].start + arr[i - 1].duration;
    seg.start = Math.round(start * 10) / 10;
    seg.end = Math.round((start + seg.duration) * 10) / 10;
    return seg;
  });
}

// ============ CLI 入口 ============
if (require.main === module) {
  const args = process.argv.slice(2);
  const scriptFile = args[0];
  const outDir = args[1];

  if (!scriptFile) {
    console.log('用法: node tts.js <脚本JSON文件> [输出目录]');
    console.log('示例: node tts.js ../scripts/pipe_xxx_script.json');
    process.exit(1);
  }

  const scriptJSON = JSON.parse(fs.readFileSync(scriptFile, 'utf-8'));
  // 支持包装格式 { script: {...} } 或直接 script {...}
  const script = scriptJSON.script || scriptJSON;

  generateVoice(script, outDir).then((result) => {
    console.log('\n📁 输出:', JSON.stringify(result, null, 2));
  }).catch((err) => {
    console.error('❌ TTS 失败:', err.message);
    process.exit(1);
  });
}

module.exports = { generateVoice, parseVTT };
