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

// ============ 审核状态管理 (T1.4, T1.5) ============
const reviewStore = new Map(); // pipelineId -> { status, data, createdAt, timeout }

function createReview(pipelineId, data, reviewPoint) {
  const review = {
    pipelineId,
    reviewPoint,
    status: 'pending', // pending | approved | rejected
    data,
    createdAt: Date.now(),
    timeoutId: null,
  };

  // 24h 超时自动提醒 (T4.1)
  const TIMEOUT_MS = 24 * 60 * 60 * 1000;
  const REMINDER_MS = 12 * 60 * 60 * 1000; // 12h 提醒

  // 12h 提醒
  review.reminderId = setTimeout(() => {
    const r = reviewStore.get(pipelineId);
    if (r && r.status === 'pending') {
      console.log(`⏰ [审核提醒] Pipeline ${pipelineId} 审核点${r.reviewPoint} 已等待 12h，请尽快处理`);
    }
  }, REMINDER_MS);

  // 24h 超时
  review.timeoutId = setTimeout(() => {
    const r = reviewStore.get(pipelineId);
    if (r && r.status === 'pending') {
      console.log(`⏰ [审核超时] Pipeline ${pipelineId} 审核点${r.reviewPoint} 超过 24h 未响应，自动标记为已过期`);
      r.status = 'expired';
    }
  }, TIMEOUT_MS);

  reviewStore.set(pipelineId, review);
  return review;
}

function approveReview(pipelineId, feedback) {
  const review = reviewStore.get(pipelineId);
  if (!review) return null;
  review.status = 'approved';
  review.feedback = feedback;
  review.resolvedAt = Date.now();
  clearTimeout(review.timeoutId);
  clearTimeout(review.reminderId);
  return review;
}

function rejectReview(pipelineId, feedback) {
  const review = reviewStore.get(pipelineId);
  if (!review) return null;
  review.status = 'rejected';
  review.feedback = feedback;
  review.resolvedAt = Date.now();
  clearTimeout(review.timeoutId);
  clearTimeout(review.reminderId);
  return review;
}
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
    // 全局错误拦截 (T4.2)
    const safeHandler = async () => {
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
        return res.end(JSON.stringify({ status: 'ok', version: '2.0.0', pending_reviews: reviewStore.size }));
      }
      
      // API: 选题分析
      if (url.pathname === '/api/topic-analysis' && req.method === 'POST') {
        const body = await readBody(req);
        const { idea } = JSON.parse(body);
        const result = await stepTopicAnalysis(idea);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, data: result }));
      }
      
      // API: 脚本生成
      if (url.pathname === '/api/script-gen' && req.method === 'POST') {
        const body = await readBody(req);
        const { analysis, assetTags } = JSON.parse(body);
        const result = await stepScriptGeneration(analysis, assetTags || []);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, data: result }));
      }
      
      // API: 元数据生成
      if (url.pathname === '/api/metadata' && req.method === 'POST') {
        const body = await readBody(req);
        const { script, videoInfo } = JSON.parse(body);
        const result = await stepMetadataGeneration(script, videoInfo || {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, data: result }));
      }
      
      // API: 带审核暂停的管线 (T1.4)
      if (url.pathname === '/api/pipeline-with-review' && req.method === 'POST') {
        const body = await readBody(req);
        const { idea } = JSON.parse(body);
        const pipelineId = `pipe_${Date.now()}`;
        
        // Step 1: 选题分析
        const topicResult = await stepTopicAnalysis(idea);
        
        // Step 2: 脚本生成
        const assetTags = ['产品展示', '科技感界面', '实验室', '数据可视化', '人物访谈', '街头访问', '动画演示', '场景展示', '产品特写', '俯拍'];
        const scriptResult = await stepScriptGeneration(topicResult.analysis, assetTags);
        
        // 创建审核 (审核点 1)
        const reviewData = {
          pipelineId,
          idea,
          topicAnalysis: topicResult,
          script: scriptResult,
        };
        createReview(pipelineId, reviewData, 1);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          pipelineId,
          status: 'pending_review',
          review_point: 1,
          review_url: `/api/review/${pipelineId}`,
          summary: {
            direction: topicResult.analysis.direction,
            script_title: scriptResult.script.title,
            estimated_duration: scriptResult.script.total_duration,
            scenes_count: scriptResult.script.scenes.length,
          },
          message: '请在飞书中审核脚本，通过后调用 POST /api/review/:id/approve 或打回 POST /api/review/:id/reject',
        }));
      }
      
      // API: 完整管线 (无审核快速模式)
      if (url.pathname === '/api/pipeline' && req.method === 'POST') {
        const body = await readBody(req);
        const { idea } = JSON.parse(body);
        const result = await runFullPipeline(idea);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, data: result }));
      }
      
      // API: 审核状态查询 (T1.4)
      if (url.pathname.startsWith('/api/review/') && req.method === 'GET') {
        const id = url.pathname.split('/').pop();
        const review = reviewStore.get(id);
        if (!review) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: '审核不存在或已过期' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          pipelineId: review.pipelineId,
          reviewPoint: review.reviewPoint,
          status: review.status,
          createdAt: new Date(review.createdAt).toISOString(),
          waitMinutes: Math.floor((Date.now() - review.createdAt) / 60000),
        }));
      }
      
      // API: 审核通过 (T1.5)
      if (url.pathname.endsWith('/approve') && url.pathname.includes('/api/review/') && req.method === 'POST') {
        const id = url.pathname.split('/')[3];
        const body = await readBody();
        const { feedback } = JSON.parse(body || '{}');
        
        const review = approveReview(id, feedback);
        if (!review) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: '审核不存在' }));
        }
        
        // 自动执行后续步骤: 元数据生成
        try {
          const videoInfo = {
            resolution: '1920x1080', fps: 30, codec: 'h264',
            duration: review.data.script.script.total_duration || 60,
          };
          const metadataResult = await stepMetadataGeneration(review.data.script.script, videoInfo);
          
          const outputDir = path.join(CONFIG.PROJECT_DIR, 'scripts');
          const fullResult = {
            ...review.data,
            metadata: metadataResult,
            review: { status: 'approved', feedback },
            completedAt: new Date().toISOString(),
          };
          fs.writeFileSync(
            path.join(outputDir, `${review.pipelineId}_result.json`),
            JSON.stringify(fullResult, null, 2), 'utf-8'
          );
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: true,
            pipelineId: id,
            status: 'completed',
            metadata: metadataResult.metadata,
            output: `scripts/${review.pipelineId}_result.json`,
          }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: e.message }));
        }
      }
      
      // API: 审核打回 (T1.5)
      if (url.pathname.endsWith('/reject') && url.pathname.includes('/api/review/') && req.method === 'POST') {
        const id = url.pathname.split('/')[3];
        const body = await readBody();
        const { feedback } = JSON.parse(body || '{}');
        
        const review = rejectReview(id, feedback);
        if (!review) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: '审核不存在' }));
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          pipelineId: id,
          status: 'rejected',
          feedback,
          message: '请根据反馈重新提交创意',
        }));
      }
      
      // 404
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', endpoints: [
        'POST /api/pipeline              # 完整管线（无审核）',
        'POST /api/pipeline-with-review  # 带审核管线（审核点1）',
        'POST /api/topic-analysis        # 单独选题分析',
        'POST /api/script-gen             # 单独脚本生成',
        'POST /api/metadata               # 单独元数据生成',
        'GET  /api/review/:id             # 查询审核状态',
        'POST /api/review/:id/approve     # 审核通过',
        'POST /api/review/:id/reject      # 审核打回',
        'GET  /health                     # 健康检查',
      ]}));
    };
    
    // 全局错误处理包装
    try {
      await safeHandler();
    } catch (e) {
      console.error(`❌ [全局错误] ${req.method} ${req.url}:`, e.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message, type: e.constructor.name }));
      }
    }
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
