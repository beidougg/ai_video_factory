#!/usr/bin/env node
/**
 * 视频质检脚本 (T2.4)
 * 使用 ffprobe 检查视频关键参数
 * 
 * 用法:
 *   node qc.js <视频文件路径>
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 目标参数
const TARGET = {
  resolution: '1920x1080',
  min_width: 1280,
  min_height: 720,
  max_duration_diff: 2,    // 时长偏差 ≤ 2 秒
  expected_codec: 'h264',
  must_have_audio: true,
  min_bitrate: 1000,       // 最低 1000 kbps
};

/**
 * 使用 ffprobe 提取视频信息
 */
function probeVideo(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }

  const output = execSync(
    `ffprobe -v quiet -print_format json -show_format -show_streams "${filePath}"`,
    { timeout: 15000, encoding: 'utf-8' }
  );

  const data = JSON.parse(output);

  // 提取关键信息
  const videoStream = data.streams?.find(s => s.codec_type === 'video');
  const audioStream = data.streams?.find(s => s.codec_type === 'audio');
  const format = data.format || {};

  return {
    file: filePath,
    file_size_mb: (fs.statSync(filePath).size / (1024 * 1024)).toFixed(1),
    resolution: videoStream ? `${videoStream.width}x${videoStream.height}` : 'unknown',
    width: videoStream?.width || 0,
    height: videoStream?.height || 0,
    codec: videoStream?.codec_name || 'unknown',
    fps: evalFPS(videoStream?.r_frame_rate),
    duration: parseFloat(format.duration || '0'),
    bitrate_kbps: Math.round(parseInt(format.bit_rate || '0') / 1000),
    has_audio: !!audioStream,
    audio_codec: audioStream?.codec_name || 'none',
    audio_channels: audioStream?.channels || 0,
    format: format.format_name || 'unknown',
  };
}

function evalFPS(rate) {
  if (!rate) return 0;
  const parts = rate.split('/');
  if (parts.length === 2 && parseInt(parts[1]) !== 0) {
    return Math.round(parseInt(parts[0]) / parseInt(parts[1]));
  }
  return parseFloat(rate);
}

/**
 * 执行质检
 */
function runQC(filePath, expectedDuration = null) {
  console.log(`\n🔍 [QC] 质检: ${path.basename(filePath)}`);
  console.log('='.repeat(50));

  let info;
  try {
    info = probeVideo(filePath);
  } catch (e) {
    return { passed: false, error: e.message, checks: {} };
  }

  const checks = {};
  let passed = true;

  // 1. 分辨率检查
  checks.resolution = {
    expected: TARGET.resolution,
    actual: info.resolution,
    passed: info.width >= TARGET.min_width && info.height >= TARGET.min_height,
  };
  if (!checks.resolution.passed) passed = false;

  // 2. 编码格式检查
  checks.codec = {
    expected: TARGET.expected_codec,
    actual: info.codec,
    passed: info.codec.includes(TARGET.expected_codec) || info.codec === 'av1',
  };

  // 3. 音轨检查
  checks.audio = {
    expected: '存在',
    actual: info.has_audio ? `${info.audio_codec} (${info.audio_channels}ch)` : '无音轨',
    passed: info.has_audio === TARGET.must_have_audio,
  };
  if (!checks.audio.passed) passed = false;

  // 4. 时长检查
  if (expectedDuration) {
    const diff = Math.abs(info.duration - expectedDuration);
    checks.duration = {
      expected: `${expectedDuration}s`,
      actual: `${info.duration.toFixed(1)}s`,
      passed: diff <= TARGET.max_duration_diff,
    };
    if (!checks.duration.passed) passed = false;
  }

  // 5. 码率检查
  checks.bitrate = {
    expected: `≥ ${TARGET.min_bitrate} kbps`,
    actual: `${info.bitrate_kbps} kbps`,
    passed: info.bitrate_kbps >= TARGET.min_bitrate || info.bitrate_kbps === 0,
  };

  // 6. 帧率检查
  const fpsOk = info.fps >= 24 && info.fps <= 60;
  checks.fps = {
    expected: '24-60',
    actual: `${info.fps}`,
    passed: fpsOk,
  };

  // 汇总
  console.log(`   文件: ${info.file}`);
  console.log(`   大小: ${info.file_size_mb} MB | 码率: ${info.bitrate_kbps} kbps`);
  console.log(`   分辨率: ${info.resolution} | 编码: ${info.codec} | FPS: ${info.fps}`);
  console.log(`   时长: ${info.duration.toFixed(1)}s | 音轨: ${info.has_audio ? info.audio_codec : '无'}`);

  console.log('\n   检查项:');
  for (const [key, check] of Object.entries(checks)) {
    const icon = check.passed ? '✅' : '❌';
    console.log(`   ${icon} ${key}: ${check.actual} (期望: ${check.expected})`);
  }

  const failedChecks = Object.entries(checks).filter(([, c]) => !c.passed).map(([k]) => k);
  console.log(`\n${passed ? '✅ 质检通过' : '❌ 质检失败: ' + failedChecks.join(', ')}`);

  return {
    passed,
    info,
    checks,
    failed_checks: failedChecks,
  };
}

// ============ CLI ============
if (require.main === module) {
  const videoFile = process.argv[2];
  const expectedDur = process.argv[3] ? parseFloat(process.argv[3]) : null;

  if (!videoFile) {
    console.log('用法: node qc.js <视频文件路径> [期望时长秒数]');
    process.exit(1);
  }

  const result = runQC(videoFile, expectedDur);
  process.exit(result.passed ? 0 : 1);
}

module.exports = { probeVideo, runQC };
