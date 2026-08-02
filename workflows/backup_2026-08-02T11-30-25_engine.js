#!/usr/bin/env node
/**
 * AI Video Factory 工作流引擎
 * 核心管线: 创意输入 → DeepSeek选题分析 → 脚本生成 → 审核暂停 → 后续流程
 * 
 * 用法:
 *   node engine.js start           # 启动 HTTP 服务 (默认 5678)
 *   node engine.js test <创意文本>  # 命令行测试完整流程
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ============ 配置 ============
const CONFIG = {
  PORT: 5678,
  DEEPSEEK_API_KEY: 'sk-4a6e00338ce94e15bf9b8a9c79a6119d',
  DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1',
  DEEPSEEK_MODEL: 'deepseek-chat',
  FEISHU_APP_ID: 'cli_aae46311a3781cee',
  PROJECT_DIR: path.resolve(__dirname, '..'),
};

// ============ Prompt 模板加载 ============
function loadPrompt(name) {
  const filePath = path.join(CONFIG.PROJECT_DIR, 'prompts', name);
  return fs.readFileSync(filePath, 'utf-8');
}

const PROMPTS = {
  topic: loadPrompt('topic_analysis.txt'),
  script: loadPrompt('script_gen.txt'),
  storyboard: loadPrompt('storyboard.txt'),
  metadata: loadPrompt('metadata.txt'),
};

// ============ DeepSeek API 调用 ============
async function callDeepSeek(systemPrompt, userContent, maxTokens = 2000, temperature = 0.8) {
  const body = JSON.stringify({
    model: CONFIG.DEEPSEEK_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature,
    max_tokens: maxTokens,
  });

  return new Promise((resolve, reject) => {
    const url = new URL(`${CONFIG.DEEPSEEK_BASE_URL}/chat/completions`);
    const transport = url.protocol === 'https:' ? https : http;
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.DEEPSEEK_API_KEY}`,
      },
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse failed: ${e.message}, raw: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ============ JSON 提取 ============
function extractJSON(text) {
  let cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  // 尝试找到第一个 { 和最后一个 }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end !== -1) {
    cleaned = cleaned.slice(start, end + 1);
  }
  return JSON.parse(cleaned);
}

// ============ 步骤 1: 选题分析 ============
async function stepTopicAnalysis(userIdea) {
  console.log('\n📝 [步骤1] 选题分析中...');
  const startTime = Date.now();
  
  const result = await callDeepSeek(
    PROMPTS.topic,
    `用户创意：${userIdea}`,
    2000, 0.8
  );
  
  const content = result.choices[0].message.content;
  const analysis = extractJSON(content);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  
  console.log(`✅ 选题分析完成 (${elapsed}s, ${result.usage.total_tokens} tokens)`);
  console.log(`   方向: ${analysis.direction}`);
  console.log(`   时长建议: ${analysis.estimated_duration}s`);
  console.log(`   风险提示: ${analysis.risk_warning}`);
  
  return { analysis, raw: content, usage: result.usage };
}

// ============ 步骤 2: 脚本生成 ============
async function stepScriptGeneration(topicAnalysis, assetTags) {
  console.log('\n✍️ [步骤2] 脚本生成中...');
  const startTime = Date.now();
  
  const userContent = [
    `选题分析报告：${JSON.stringify(topicAnalysis, null, 2)}`,
    `\n可用素材标签索引：${assetTags.join(', ')}`
  ].join('\n');
  
  const result = await callDeepSeek(
    PROMPTS.script,
    userContent,
    4000, 0.8
  );
  
  const content = result.choices[0].message.content;
  const script = extractJSON(content);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  
  console.log(`✅ 脚本生成完成 (${elapsed}s, ${result.usage.total_tokens} tokens)`);
  console.log(`   标题: ${script.title}`);
  console.log(`   时长: ${script.total_duration}s`);
  console.log(`   分镜数: ${script.scenes.length}`);
  console.log(`   钩子: ${script.hook}`);
  
  return { script, raw: content, usage: result.usage };
}

// ============ 步骤 3: 元数据生成 ============
async function stepMetadataGeneration(script, videoInfo) {
  console.log('\n🏷️ [步骤3] 元数据生成中...');
  const startTime = Date.now();
  
  const userContent = [
    `视频脚本：${JSON.stringify(script, null, 2)}`,
    `\n视频信息：${JSON.stringify(videoInfo, null, 2)}`
  ].join('\n');
  
  const result = await callDeepSeek(
    PROMPTS.metadata,
    userContent,
    2000, 0.5
  );
  
  const content = result.choices[0].message.content;
  const metadata = extractJSON(content);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  
  console.log(`✅ 元数据生成完成 (${elapsed}s, ${result.usage.total_tokens} tokens)`);
  console.log(`   YouTube: ${metadata.youtube?.title}`);
  console.log(`   快手: ${metadata.kuaishou?.title}`);
  
  return { metadata, raw: content, usage: result.usage };
}

// ============ 完整 Pipeline 测试 ============
async function runFullPipeline(userIdea) {
  const pipelineId = `pipe_${Date.now()}`;
  console.log('='.repeat(60));
  console.log(`🚀 AI Video Factory 完整管线测试`);
  console.log(`   Pipeline ID: ${pipelineId}`);
  console.log(`   创意: ${userIdea}`);
  console.log('='.repeat(60));
  
  const results = { pipelineId, userIdea, startTime: new Date().toISOString() };
  
  try {
    // Step 1
    const topicResult = await stepTopicAnalysis(userIdea);
    results.topicAnalysis = topicResult;
    
    // Step 2
    const assetTags = ['产品展示', '科技感界面', '医疗场景', '实验室', '数据可视化', '人物访谈', '街头访问', '动画演示', '场景展示', '产品特写', '俯拍'];
    const scriptResult = await stepScriptGeneration(topicResult.analysis, assetTags);
    results.script = scriptResult;
    
    // Step 3
    const videoInfo = {
      resolution: '1920x1080',
      fps: 30,
      codec: 'h264',
      duration: scriptResult.script.total_duration || 60,
    };
    const metadataResult = await stepMetadataGeneration(scriptResult.script, videoInfo);
    results.metadata = metadataResult;
    
    // 汇总
    const totalTokens = [topicResult.usage, scriptResult.usage, metadataResult.usage]
      .reduce((sum, u) => sum + u.total_tokens, 0);
    const totalCost = (totalTokens / 1_000_000 * 1).toFixed(4); // ¥1/百万tokens
    
    console.log('\n' + '='.repeat(60));
    console.log('📊 管线完成汇总');
    console.log(`   总 Token: ${totalTokens}`);
    console.log(`   预估费用: ¥${totalCost}`);
    console.log(`   输出文件: scripts/${pipelineId}_script.json`);
    console.log('='.repeat(60));
    
    // 保存结果
    const outputDir = path.join(CONFIG.PROJECT_DIR, 'scripts');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, `${pipelineId}_result.json`),
      JSON.stringify(results, null, 2),
      'utf-8'
    );
    console.log(`\n📁 结果已保存至 scripts/${pipelineId}_result.json`);
    
    return results;
  } catch (err) {
    console.error(`\n❌ 管线执行失败:`, err.message);
    throw err;
  }
}

// ============ HTTP 服务模式 (供 n8n 或前端调用) ============
function startServer() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    
    const url = new URL(req.url, `http://localhost:${CONFIG.PORT}`);
    
    // 健康检查
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', version: '1.0.0' }));
    }
    
    // API: 选题分析
    if (url.pathname === '/api/topic-analysis' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const { idea } = JSON.parse(body);
        const result = await stepTopicAnalysis(idea);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, data: result }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: e.message }));
      }
    }
    
    // API: 脚本生成
    if (url.pathname === '/api/script-gen' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const { analysis, assetTags } = JSON.parse(body);
        const result = await stepScriptGeneration(analysis, assetTags || []);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, data: result }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: e.message }));
      }
    }
    
    // API: 元数据生成
    if (url.pathname === '/api/metadata' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const { script, videoInfo } = JSON.parse(body);
        const result = await stepMetadataGeneration(script, videoInfo || {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, data: result }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: e.message }));
      }
    }
    
    // API: 完整管线
    if (url.pathname === '/api/pipeline' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const { idea } = JSON.parse(body);
        const result = await runFullPipeline(idea);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, data: result }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: e.message }));
      }
    }
    
    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found', endpoints: [
      'POST /api/topic-analysis',
      'POST /api/script-gen',
      'POST /api/metadata',
      'POST /api/pipeline',
      'GET /health',
    ]}));
  });
  
  server.listen(CONFIG.PORT, () => {
    console.log(`\n🎬 AI Video Factory 引擎已启动`);
    console.log(`   地址: http://localhost:${CONFIG.PORT}`);
    console.log(`   API:  http://localhost:${CONFIG.PORT}/api/pipeline`);
    console.log(`   健康: http://localhost:${CONFIG.PORT}/health`);
    console.log(`\n   curl -X POST http://localhost:${CONFIG.PORT}/api/pipeline \\`);
    console.log(`     -H "Content-Type: application/json" \\`);
    console.log(`     -d '{"idea":"你的创意描述"}'`);
    console.log();
  });
  
  return server;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// ============ 入口 ============
const command = process.argv[2];

if (command === 'start') {
  startServer();
} else if (command === 'test') {
  const idea = process.argv[3] || 'AI在医疗领域的革命性应用';
  runFullPipeline(idea).catch(console.error);
} else {
  console.log('AI Video Factory 工作流引擎');
  console.log('用法:');
  console.log('  node engine.js start              启动 HTTP 服务');
  console.log('  node engine.js test <创意文本>     命令行测试完整管线');
  console.log('\n示例:');
  console.log('  node engine.js test "AI如何改变教育行业"');
}
