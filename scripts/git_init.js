#!/usr/bin/env node
/**
 * T0.7 Git 初始化脚本 (纯 JS，无需安装 Git for Windows)
 * 使用 isomorphic-git 创建初始提交
 */
const git = require('isomorphic-git');
const http = require('isomorphic-git/http/node');
const fs = require('fs');
const path = require('path');

const PROJECT_DIR = path.resolve(__dirname, '..');

// 递归获取所有需要跟踪的文件
function getAllFiles(dir, baseDir = dir) {
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    // 跳过不需要跟踪的
    if (entry.name === '.git' || entry.name === 'node_modules' || 
        entry.name === '.env' || entry.name.startsWith('.')) continue;
    
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
    
    if (entry.isDirectory()) {
      files.push(...getAllFiles(fullPath, baseDir));
    } else {
      files.push(relativePath);
    }
  }
  return files;
}

async function main() {
  console.log('========================================');
  console.log('📦 初始化 Git 仓库 (isomorphic-git)');
  console.log('========================================\n');

  // 1. 初始化仓库
  console.log('1. 初始化仓库...');
  await git.init({ fs, dir: PROJECT_DIR });
  console.log('   ✅ .git 目录已创建');

  // 2. 获取所有文件
  const allFiles = getAllFiles(PROJECT_DIR);
  console.log(`\n2. 扫描文件: ${allFiles.length} 个`);
  allFiles.slice(0, 10).forEach(f => console.log(`   ${f}`));
  if (allFiles.length > 10) console.log(`   ... 共 ${allFiles.length} 个文件`);

  // 3. 添加到暂存区
  console.log('\n3. 添加到暂存区...');
  for (const file of allFiles) {
    try {
      await git.add({ fs, dir: PROJECT_DIR, filepath: file });
    } catch (e) {
      console.log(`   ⚠️ 跳过: ${file} - ${e.message}`);
    }
  }
  console.log('   ✅ 已暂存');

  // 4. 创建初始提交
  console.log('\n4. 创建初始提交...');
  const author = {
    name: 'AI Video Factory',
    email: 'ai-video-factory@local.dev',
  };
  
  const sha = await git.commit({
    fs,
    dir: PROJECT_DIR,
    author,
    message: `🎬 初始提交: AI Video Factory 项目骨架

Phase 0-4 已完成模块:
  - workflow_engine/engine.js    # 工作流引擎 (API + 管线)
  - workflow_engine/tts.js       # TTS 配音生成
  - workflow_engine/qc.js        # 视频质检
  - workflow_engine/asset_search.js  # 素材检索
  - workflow_engine/export_workflow.js  # 工作流导出
  - prompts/                     # 4 个 LLM 模板
  - templates/product_showcase/  # Remotion 模板
  - scripts/                     # 工具脚本
  - specs/video-factory-arch/    # SDD 文档
  - constitution.md              # 项目宪法

状态: 21/37 任务完成`,
  });

  console.log(`   ✅ 提交成功: ${sha.slice(0, 7)}`);

  // 5. 查看状态
  const status = await git.statusMatrix({ fs, dir: PROJECT_DIR });
  const staged = status.filter(([, , head, work]) => head === 0 && work === 2).length;
  const modified = status.filter(([, head, , work]) => head === 1 && work === 2).length;
  const untracked = status.filter(([, head, , work]) => head === 0 && work === 2 && status.indexOf([]));

  // 6. 查看日志
  const commits = await git.log({ fs, dir: PROJECT_DIR, depth: 1 });
  console.log(`\n========================================`);
  console.log('✅ Git 初始化完成!');
  console.log('========================================');
  console.log(`   仓库: ${PROJECT_DIR}`);
  console.log(`   提交: ${sha.slice(0, 7)}`);
  console.log(`   作者: ${author.name} <${author.email}>`);
  console.log(`   日期: ${new Date().toISOString()}`);
  console.log(`   文件: ${allFiles.length} 个`);
  console.log();

  // 7. 创建 .gitignore
  const gitignore = `# 环境变量 (含 API Key)
.env

# 依赖
node_modules/

# n8n 数据库
~/.n8n/

# 输出文件
outputs/*.mp4
outputs/*.mp3
outputs/*.vtt

# 脚本生成结果
scripts/pipe_*.json

# 工作流备份
workflows/backup_*.js
workflows/backup_*.txt
`;
  fs.writeFileSync(path.join(PROJECT_DIR, '.gitignore'), gitignore, 'utf-8');
  console.log('   .gitignore 已创建 ✅');
  console.log();
  
  // 再次提交 .gitignore
  await git.add({ fs, dir: PROJECT_DIR, filepath: '.gitignore' });
  const sha2 = await git.commit({
    fs, dir: PROJECT_DIR, author,
    message: '🔧 添加 .gitignore',
  });
  console.log(`   第二次提交 (.gitignore): ${sha2.slice(0, 7)} ✅`);
}

main().catch(err => {
  console.error('❌ 失败:', err.message);
  process.exit(1);
});
