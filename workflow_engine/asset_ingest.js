#!/usr/bin/env node
/**
 * AI 素材入库器 (M11)
 *
 * 职责:
 *   - 图像 Buffer → 尺寸归一化（供应商长边受限，放大到目标分辨率）→ 落盘素材库
 *   - 透明 PNG: FFmpeg colorkey 绿幕去背（确定性图像处理，非本地 AI 模型）
 *   - 生成素材元数据 JSON（可被 asset_search.js 检索）
 *
 * 命名规范（constitution 第 5 条扩展）:
 *   ai_{类别}_{序号}_{方向}.png   例: ai_scene_003_landscape.png
 *   落盘: assets/images/ai/{类别}/
 *   元数据: assets/metadata/{文件名}.json
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { ffmpeg, ffprobe } = require('./ffmpeg');

const PROJECT_DIR = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(PROJECT_DIR, 'assets');
const IMAGES_ROOT = path.join(ASSETS_DIR, 'images', 'ai');
const METADATA_DIR = path.join(ASSETS_DIR, 'metadata');

const TYPE_TO_CATEGORY = {
  scene: 'scene',
  cover: 'cover',
  background: 'bg',
  transparent_png: 'overlay',
};

const TYPE_SCENARIO = {
  scene: '分镜配图',
  cover: '视频封面',
  background: '背景图',
  transparent_png: '透明叠加元素',
};

/**
 * 尺寸归一化：若生成尺寸小于目标尺寸，FFmpeg lanczos 放大
 */
function normalizeSize(inputBuf, targetW, targetH, tmpTag) {
  const tmpIn = path.join(PROJECT_DIR, 'logs', `ingest_in_${tmpTag}.png`);
  const tmpOut = path.join(PROJECT_DIR, 'logs', `ingest_out_${tmpTag}.png`);
  fs.writeFileSync(tmpIn, inputBuf);
  try {
    const probe = execSync(
      `"${ffprobe}" -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${tmpIn}"`,
      { encoding: 'utf-8' }
    ).trim();
    const [w, h] = probe.split(',').map(Number);
    if (w >= targetW && h >= targetH) return inputBuf; // 已达标
    execSync(
      `"${ffmpeg}" -y -i "${tmpIn}" -vf "scale=${targetW}:${targetH}:flags=lanczos" -frames:v 1 "${tmpOut}"`,
      { stdio: 'pipe' }
    );
    return fs.readFileSync(tmpOut);
  } finally {
    for (const f of [tmpIn, tmpOut]) if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

/**
 * 绿幕去背：FFmpeg colorkey → 带 Alpha 的 PNG
 */
function removeGreenScreen(inputBuf, tmpTag) {
  const tmpIn = path.join(PROJECT_DIR, 'logs', `ck_in_${tmpTag}.png`);
  const tmpOut = path.join(PROJECT_DIR, 'logs', `ck_out_${tmpTag}.png`);
  fs.writeFileSync(tmpIn, inputBuf);
  try {
    execSync(
      `"${ffmpeg}" -y -i "${tmpIn}" -vf "colorkey=0x00FF00:0.3:0.2,format=rgba" -frames:v 1 "${tmpOut}"`,
      { stdio: 'pipe' }
    );
    return fs.readFileSync(tmpOut);
  } finally {
    for (const f of [tmpIn, tmpOut]) if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

/** 目录内下一序号（001 起） */
function nextSeq(category) {
  const dir = path.join(IMAGES_ROOT, category);
  if (!fs.existsSync(dir)) return 1;
  const n = fs.readdirSync(dir).filter((f) => /^ai_.*_\d+_/.test(f)).length;
  return n + 1;
}

/**
 * AI 素材入库
 * @param {Buffer} imageBuffer - 原始图像
 * @param {object} meta - { type, orientation, targetWidth, targetHeight, prompt, negativePrompt, pipelineId, sceneIndex, cost, provider, keywords }
 * @returns {object} 素材元数据（即 candidates 元素 + 元数据文件内容）
 */
function saveAsset(imageBuffer, meta) {
  const {
    type = 'scene',
    orientation = 'landscape',
    targetWidth,
    targetHeight,
    prompt = '',
    negativePrompt = '',
    pipelineId = '',
    sceneIndex = -1,
    cost = 0,
    provider = '',
    keywords = [],
  } = meta;

  const category = TYPE_TO_CATEGORY[type] || 'scene';
  const seq = nextSeq(category);
  const filename = `ai_${category}_${String(seq).padStart(3, '0')}_${orientation}.png`;
  const dir = path.join(IMAGES_ROOT, category);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(METADATA_DIR)) fs.mkdirSync(METADATA_DIR, { recursive: true });

  const tmpTag = `${Date.now()}_${seq}`;
  let buf = imageBuffer;

  // 1. 尺寸归一化（spec AC-3：横 ≥1920×1080，竖 ≥1080×1920，透明 ≥1024×1024）
  if (targetWidth && targetHeight) {
    buf = normalizeSize(buf, targetWidth, targetHeight, tmpTag);
  }

  // 2. 透明 PNG 去背
  if (type === 'transparent_png') {
    buf = removeGreenScreen(buf, tmpTag);
  }

  // 3. 落盘
  const absPath = path.join(dir, filename);
  fs.writeFileSync(absPath, buf);

  // 4. 元数据（plan §3.3）
  const relPath = `assets/images/ai/${category}/${filename}`;
  const metadata = {
    file: filename,
    file_path: relPath,
    type: 'image',
    resolution: targetWidth && targetHeight ? `${targetWidth}x${targetHeight}` : 'unknown',
    tags: ['AI生成', ...keywords],
    scenario: TYPE_SCENARIO[type] || '分镜配图',
    quality: 'B',
    source: 'ai_generated',
    prompt,
    negative_prompt: negativePrompt,
    pipeline_id: pipelineId,
    scene_index: sceneIndex,
    generated_at: new Date().toISOString(),
    cost,
    provider,
    usage_count: 0,
    avg_retention: null,
  };
  fs.writeFileSync(path.join(METADATA_DIR, filename.replace(/\.png$/, '.json')), JSON.stringify(metadata, null, 2), 'utf-8');

  console.log(`   💾 入库: ${relPath} (¥${cost})`);
  return metadata;
}

module.exports = { saveAsset, removeGreenScreen, normalizeSize };
