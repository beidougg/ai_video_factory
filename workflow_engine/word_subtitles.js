#!/usr/bin/env node
/**
 * 逐字字幕生成模块 (O3.2)
 * 基于 edge-tts 词级时间戳聚合成字幕行（每行 ≤15 字），生成 VTT
 *
 * 用法:
 *   node word_subtitles.js <词级时间戳JSON> [输出VTT] [每行最大字数]
 *   或作为模块: const { aggregateWords, generateWordVTT, loadWordTimestamps } = require('./word_subtitles');
 */

const fs = require('fs');
const path = require('path');

const MAX_CHARS = 15;  // 每行最大字数（O3.2 验收标准）

/**
 * 秒 → VTT 时间格式 (HH:MM:SS.mmm)
 */
function vttTime(seconds) {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(millis, 3)}`;
}

/**
 * 加载词级时间戳 JSON（兼容 edge_tts_word.py 输出）
 */
function loadWordTimestamps(jsonPath) {
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  const words = data.words || data;
  if (!Array.isArray(words)) throw new Error(`无效的词级时间戳文件: ${jsonPath}`);
  return words;
}

/**
 * 聚合词级时间戳为字幕行（每行 ≤ maxChars 字，遇标点换行）
 * @param {Array} words - [{ text, start, end }]
 * @param {number} maxChars - 每行最大字数
 * @returns {Array} [{ text, start, end }]
 */
function aggregateWords(words, maxChars = MAX_CHARS) {
  const lines = [];
  let cur = { text: '', start: null, end: null, charCount: 0 };
  // 标点集合：遇到则换行
  const PUNCT = /[，。！？；：、,.!?;:]/;

  for (const w of words) {
    const text = w.text || '';
    const charCount = [...text].length; // 按 Unicode 字符数（中文按字）

    // 新行初始化
    if (cur.start === null) cur.start = w.start;

    // 判断是否换行：当前行已满 或 该词是标点结尾
    const willOverflow = cur.charCount + charCount > maxChars;
    const isPunct = PUNCT.test(text.trim());

    if (willOverflow && cur.charCount > 0) {
      // 结束当前行
      lines.push({ text: cur.text, start: cur.start, end: cur.end ?? w.start });
      cur = { text: '', start: w.start, end: null, charCount: 0 };
    }

    cur.text += text;
    cur.charCount += charCount;
    cur.end = w.end ?? w.start;

    // 标点结尾则换行
    if (isPunct) {
      lines.push({ text: cur.text, start: cur.start, end: cur.end });
      cur = { text: '', start: null, end: null, charCount: 0 };
    }
  }

  // 收尾
  if (cur.text && cur.start !== null) {
    lines.push({ text: cur.text, start: cur.start, end: cur.end ?? cur.start });
  }

  return lines;
}

/**
 * 生成 VTT 内容
 * @param {Array} words - 词级时间戳数组
 * @param {number} maxChars - 每行最大字数
 * @returns {string} VTT 文本
 */
function generateWordVTT(words, maxChars = MAX_CHARS) {
  const lines = aggregateWords(words, maxChars);
  const cues = lines.map((l, i) => {
    const start = vttTime(l.start);
    const end = vttTime(Math.max(l.end, l.start + 0.1)); // 保证至少 0.1s
    return `${start} --> ${end}\n${l.text}`;
  });
  return ['WEBVTT', '', ...cues, ''].join('\n');
}

// ============ CLI ============
if (require.main === module) {
  const jsonPath = process.argv[2];
  const outputPath = process.argv[3];
  const maxChars = parseInt(process.argv[4] || String(MAX_CHARS), 10);

  if (!jsonPath) {
    console.log('用法: node word_subtitles.js <词级时间戳JSON> [输出VTT] [每行最大字数]');
    process.exit(1);
  }

  try {
    const words = loadWordTimestamps(jsonPath);
    const vtt = generateWordVTT(words, maxChars);
    const out = outputPath || jsonPath.replace(/\.json$/, '.vtt');
    fs.writeFileSync(out, vtt, 'utf-8');
    const lines = aggregateWords(words, maxChars);
    console.log(`✅ 逐字字幕生成: ${out}`);
    console.log(`   词数: ${words.length}, 字幕行: ${lines.length}, 每行≤${maxChars}字`);
  } catch (e) {
    console.error('❌ 生成失败:', e.message);
    process.exit(1);
  }
}

module.exports = { aggregateWords, generateWordVTT, loadWordTimestamps, vttTime, MAX_CHARS };
