#!/usr/bin/env node
/**
 * 轻量 .env 加载器（无第三方依赖）
 * 从项目根目录读取 .env 文件并注入 process.env
 *
 * 用法:
 *   require('./env');  // 只需加载一次，之后 process.env.XXX 可用
 */
const fs = require('fs');
const path = require('path');

const PROJECT_DIR = path.resolve(__dirname, '..');
const ENV_FILE = path.join(PROJECT_DIR, '.env');

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return;

  const content = fs.readFileSync(ENV_FILE, 'utf-8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    // 跳过空行与注释
    if (!line || line.startsWith('#') || !line.includes('=')) continue;

    const idx = line.indexOf('=');
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();

    // 去掉首尾引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // 不覆盖已存在的环境变量
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnv();

module.exports = { loadEnv, ENV_FILE };
