#!/usr/bin/env node
/**
 * FFmpeg/ffprobe 定位模块
 * 自动查找 ffmpeg/ffprobe 可执行文件（系统 PATH 或 WinGet 安装目录）
 *
 * 用法:
 *   const { ffmpeg, ffprobe } = require('./ffmpeg');
 *   execSync(`"${ffmpeg}" -version`);
 */

const { execSync } = require('child_process');
const path = require('path');

/**
 * 查找可执行文件
 * @param {string} name - 'ffmpeg' 或 'ffprobe'
 * @returns {string} 可执行文件完整路径
 */
function findBin(name) {
  const winGetBase = path.join(
    process.env.LOCALAPPDATA || '',
    'Microsoft', 'WinGet', 'Packages',
    'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-8.1-full_build', 'bin'
  );
  const candidates = [
    name,
    path.join(winGetBase, `${name}.exe`),
  ];
  for (const c of candidates) {
    try {
      execSync(`"${c}" -version`, { stdio: 'ignore' });
      return c;
    } catch {}
  }
  throw new Error(`未找到 ${name}，请安装 FFmpeg 或将其加入 PATH`);
}

// 惰性缓存
let _ffmpeg = null;
let _ffprobe = null;

module.exports = {
  get ffmpeg() {
    if (!_ffmpeg) _ffmpeg = findBin('ffmpeg');
    return _ffmpeg;
  },
  get ffprobe() {
    if (!_ffprobe) _ffprobe = findBin('ffprobe');
    return _ffprobe;
  },
  findBin,
};
