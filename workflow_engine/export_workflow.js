#!/usr/bin/env node
/**
 * 工作流导出脚本 (T4.5)
 * 一键备份所有工作流和配置到 workflows/ 目录
 * 
 * 用法: node export_workflow.js
 */

const fs = require('fs');
const path = require('path');

const PROJECT_DIR = path.resolve(__dirname, '..');
const EXPORT_DIR = path.join(PROJECT_DIR, 'workflows');

function exportWorkflows() {
  if (!fs.existsSync(EXPORT_DIR)) {
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const exported = [];

  // 1. 导出引擎配置
  const config = {
    exported_at: timestamp,
    engine: 'workflow_engine/engine.js',
    modules: [],
    api_endpoints: [
      'POST /api/pipeline',
      'POST /api/topic-analysis',
      'POST /api/script-gen',
      'POST /api/metadata',
      'GET  /health',
    ],
  };

  // 2. 列出所有引擎模块
  const engineDir = path.join(PROJECT_DIR, 'workflow_engine');
  if (fs.existsSync(engineDir)) {
    const files = fs.readdirSync(engineDir).filter(f => f.endsWith('.js'));
    config.modules = files;

    for (const file of files) {
      const srcPath = path.join(engineDir, file);
      const destPath = path.join(EXPORT_DIR, `backup_${timestamp}_${file}`);
      fs.copyFileSync(srcPath, destPath);
      exported.push(`workflow_engine/${file} → workflows/backup_${timestamp}_${file}`);
    }
  }

  // 3. 导出 prompt 模板
  const promptsDir = path.join(PROJECT_DIR, 'prompts');
  if (fs.existsSync(promptsDir)) {
    const promptFiles = fs.readdirSync(promptsDir).filter(f => f.endsWith('.txt'));
    config.prompts = promptFiles;

    for (const file of promptFiles) {
      const srcPath = path.join(promptsDir, file);
      const destPath = path.join(EXPORT_DIR, `backup_${timestamp}_${file}`);
      fs.copyFileSync(srcPath, destPath);
      exported.push(`prompts/${file} → workflows/backup_${timestamp}_${file}`);
    }
  }

  // 4. 写配置摘要
  const summaryPath = path.join(EXPORT_DIR, `backup_${timestamp}_summary.json`);
  fs.writeFileSync(summaryPath, JSON.stringify(config, null, 2), 'utf-8');
  exported.push(`workflows/backup_${timestamp}_summary.json`);

  console.log('='.repeat(50));
  console.log(`📦 工作流导出完成: ${timestamp}`);
  console.log(`   导出文件数: ${exported.length}`);
  console.log('='.repeat(50));
  exported.forEach(f => console.log(`   ${f}`));

  return { timestamp, exported, summary: summaryPath };
}

if (require.main === module) {
  exportWorkflows();
}

module.exports = { exportWorkflows };
