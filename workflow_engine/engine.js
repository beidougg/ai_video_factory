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
const { execSync } = require('child_process');
const { generateAndSave } = require('./remotion_props');
const { renderPipeline, generateVTT } = require('./render');
const { uploadVideo: youtubeUpload, checkAuth: youtubeStatus, startOAuthFlow: youtubeAuth } = require('./youtube');
const { validateScriptStructure } = require('./script_validator');
const { getTrendingTopicsSafe } = require('./hot_topics');

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

  // O5.2: 获取热点参考（失败降级为空列表，不影响主流程）
  console.log('   🔥 获取实时热点...');
  const trending = await getTrendingTopicsSafe();
  const trendingText = trending.length > 0
    ? trending.slice(0, 15).map((t, i) => `${i + 1}. ${t.title}`).join('\n')
    : '（当前无热点数据）';

  const userContent = [
    `用户创意：${userIdea}`,
    `\n当前热点参考：\n${trendingText}`,
  ].join('\n');

  const result = await callDeepSeek(
    PROMPTS.topic,
    userContent,
    2000, 0.8
  );
  
  const content = result.choices[0].message.content;
  const analysis = extractJSON(content);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  
  console.log(`✅ 选题分析完成 (${elapsed}s, ${result.usage.total_tokens} tokens)`);
  console.log(`   方向: ${analysis.direction}`);
  console.log(`   时长建议: ${analysis.estimated_duration}s`);
  console.log(`   热点契合度: ${analysis.hot_match?.score ?? 'N/A'}/100 (${analysis.hot_match?.level ?? 'N/A'})`);
  console.log(`   风险提示: ${analysis.risk_warning}`);
  
  return { analysis, raw: content, usage: result.usage, trending };
}

// ============ 步骤 2: 脚本生成 ============
async function stepScriptGeneration(topicAnalysis, assetTags) {
  console.log('\n✍️ [步骤2] 脚本生成中...');
  const startTime = Date.now();
  
  const userContent = [
    `选题分析报告：${JSON.stringify(topicAnalysis, null, 2)}`,
    `\n可用素材标签索引：${assetTags.join(', ')}`
  ].join('\n');
  
  // O4.2: 生成后执行四段式结构校验，失败自动重试 1 次
  let result;
  let script;
  let lastErrors = [];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = PROMPTS.script + (attempt === 2 && lastErrors.length > 0
      ? `\n\n## 上次生成未通过结构校验，错误如下，请修正后重新生成：\n${lastErrors.join('\n')}`
      : '');

    result = await callDeepSeek(prompt, userContent, 4000, 0.8);
    const content = result.choices[0].message.content;
    script = extractJSON(content);

    const validation = validateScriptStructure(script);
    if (validation.passed) {
      console.log(`   ✅ 四段式结构校验通过`);
      break;
    }
    lastErrors = validation.errors;
    console.warn(`   ⚠️ 四段式结构校验未通过 (尝试 ${attempt}): ${validation.errors.join('; ')}`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  
  console.log(`✅ 脚本生成完成 (${elapsed}s, ${result.usage.total_tokens} tokens)`);
  console.log(`   标题: ${script.title}`);
  console.log(`   时长: ${script.total_duration}s`);
  console.log(`   分镜数: ${script.scenes.length}`);
  console.log(`   钩子: ${script.hook}`);
  
  const validation = validateScriptStructure(script);
  return { script, raw: result.choices[0].message.content, usage: result.usage, structureValid: validation.passed, structureErrors: validation.errors };
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

// ============ 步骤 4: TTS 配音生成 (T1.10) ============
async function stepTTS(script, pipelineId) {
  console.log('\n🔊 [步骤4] TTS 配音生成中...');
  const ttsScript = path.join(CONFIG.PROJECT_DIR, 'workflow_engine', 'tts.js');
  const outDir = path.join(CONFIG.PROJECT_DIR, 'outputs', pipelineId);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // 将脚本写入临时文件
  const scriptFile = path.join(outDir, 'script.json');
  fs.writeFileSync(scriptFile, JSON.stringify(script, null, 2), 'utf-8');

  try {
    const result = execSync(`node "${ttsScript}" "${scriptFile}" "${outDir}"`, {
      timeout: 120000,
      encoding: 'utf-8',
    });
    console.log(result.slice(-500)); // 只打印最后 500 字符

    const voicePath = path.join(outDir, 'voice.mp3');
    const timestampsPath = path.join(outDir, 'timestamps.json');

    return {
      success: fs.existsSync(voicePath),
      voicePath,
      timestampsPath,
      ttsOutput: result,
    };
  } catch (e) {
    console.error('   ❌ TTS 失败:', e.message);
    return { success: false, error: e.message };
  }
}

// ============ 步骤 5: 素材检索 (T1.7) ============
async function stepAssetSearch(script, pipelineId) {
  console.log('\n🔍 [步骤5] 素材检索中...');
  const searchScript = path.join(CONFIG.PROJECT_DIR, 'workflow_engine', 'asset_search.js');
  const outDir = path.join(CONFIG.PROJECT_DIR, 'outputs', pipelineId);
  const scriptFile = path.join(outDir, 'script.json');

  // 确保脚本文件存在
  if (!fs.existsSync(scriptFile)) {
    fs.writeFileSync(scriptFile, JSON.stringify(script, null, 2), 'utf-8');
  }

  try {
    const result = execSync(`node "${searchScript}" "${scriptFile}"`, {
      timeout: 30000,
      encoding: 'utf-8',
    });
    console.log(result.slice(-500));

    // 尝试解析搜索结果的 JSON 输出
    let searchResults = null;
    try {
      // asset_search.js 输出包含 JSON，提取它
      const jsonStart = result.indexOf('{');
      if (jsonStart !== -1) {
        const candidates = JSON.parse(result.slice(jsonStart));
        // 检查是否包含 results
        searchResults = candidates.results || candidates;
      }
    } catch {
      searchResults = null;
    }

    return {
      success: true,
      searchResults,
      rawOutput: result,
    };
  } catch (e) {
    console.error('   ❌ 素材检索失败:', e.message);
    return { success: false, error: e.message, searchResults: null };
  }
}

// ============ 步骤 6: 分镜匹配 + 审阅点2 创建 (T1.8) ============
async function stepStoryboardReview(pipelineId, script, ttsResult, assetResult) {
  console.log('\n🎬 [步骤6] 分镜匹配 + 审阅点2...');

  const reviewData = {
    pipelineId,
    script,
    tts: ttsResult,
    assetSearch: assetResult,
    scenesCount: script.scenes?.length || 0,
    totalDuration: script.total_duration || 0,
  };

  createReview(pipelineId, reviewData, 2);

  console.log(`   ✅ 审阅点2 已创建: ${script.scenes?.length || 0} 个分镜`);
  return reviewData;
}

// ============ 步骤 7: Remotion Props → 渲染 → QC → 审阅点3 (T2.2/T2.3/T2.5/T2.6) ============
async function stepRenderWithReview(pipelineId, script, ttsResult, assetResult) {
  console.log('\n🎥 [步骤7] Remotion Props → 渲染管线...');

  // 7a: 生成 Remotion props
  const propsResult = generateAndSave(script, assetResult?.searchResults, ttsResult?.voicePath, pipelineId);

  // 7b: 渲染
  const renderResult = await renderPipeline(propsResult.outDir, pipelineId);

  // 7c: 创建审阅点 3
  const reviewData = {
    pipelineId,
    script,
    props: propsResult.props,
    renderResult,
    outputFile: renderResult.outputFile,
    outputDir: renderResult.outputDir,
    qcPassed: renderResult.success,
    retries: renderResult.retries,
  };

  createReview(pipelineId, reviewData, 3);

  console.log(`   ✅ 审阅点3 已创建: ${renderResult.success ? '质检通过' : '质检失败'}`);
  return reviewData;
}

// ============ 完整管线汇总 ============
async function runFullPipeline(userIdea, options = {}) {
  const pipelineId = options.pipelineId || `pipe_${Date.now()}`;
  const skipTTS = options.skipTTS || false;
  const skipRender = options.skipRender || false;
  
  console.log('='.repeat(60));
  console.log(`🚀 AI Video Factory 完整管线`);
  console.log(`   Pipeline ID: ${pipelineId}`);
  console.log(`   创意: ${userIdea}`);
  console.log('='.repeat(60));
  
  const results = { pipelineId, userIdea, startTime: new Date().toISOString(), steps: [] };
  const pipeStartTime = Date.now();
  
  try {
    // Step 1: 选题分析
    console.log('\n📝 [步骤1/7] 选题分析...');
    const topicResult = await stepTopicAnalysis(userIdea);
    results.topicAnalysis = topicResult;
    results.steps.push({ name: 'topic_analysis', tokens: topicResult.usage?.total_tokens || 0, ok: true });
    
    // Step 2: 脚本生成
    console.log('\n✍️ [步骤2/7] 脚本生成...');
    const assetTags = ['产品展示', '科技感界面', '医疗场景', '实验室', '数据可视化', '动画演示', '场景展示'];
    const scriptResult = await stepScriptGeneration(topicResult.analysis, assetTags);
    results.script = scriptResult;
    results.steps.push({ name: 'script_gen', tokens: scriptResult.usage?.total_tokens || 0, ok: true });
    
    // Step 3: 元数据生成
    console.log('\n🏷️ [步骤3/7] 元数据生成...');
    const videoInfo = {
      resolution: '1920x1080', fps: 30, codec: 'h264',
      duration: scriptResult.script.total_duration || 60,
    };
    const metadataResult = await stepMetadataGeneration(scriptResult.script, videoInfo);
    results.metadata = metadataResult;
    results.steps.push({ name: 'metadata_gen', tokens: metadataResult.usage?.total_tokens || 0, ok: true });
    
    // Step 4: TTS 配音 (可跳过)
    if (!skipTTS) {
      console.log('\n🔊 [步骤4/7] TTS 配音生成...');
      const ttsResult = await stepTTS(scriptResult.script, pipelineId);
      results.tts = ttsResult;
      results.steps.push({ name: 'tts', tokens: 0, ok: ttsResult.success });
      if (!ttsResult.success) {
        console.warn('   ⚠️ TTS 失败，继续流程（使用静音音频）');
      }
    } else {
      results.tts = { success: false, error: '已跳过' };
      results.steps.push({ name: 'tts', tokens: 0, ok: false, skip: true });
    }
    
    // Step 5: 素材检索
    console.log('\n🔍 [步骤5/7] 素材检索...');
    const assetResult = await stepAssetSearch(scriptResult.script, pipelineId);
    results.assetSearch = assetResult;
    results.steps.push({ name: 'asset_search', tokens: 0, ok: assetResult.success });
    
    // Step 6: Remotion Props 生成
    if (!skipRender) {
      console.log('\n🎬 [步骤6/7] 渲染管线...');
      const { generateAndSave } = require('./remotion_props');
      const propsResult = generateAndSave(
        scriptResult.script,
        assetResult?.searchResults,
        results.tts?.voicePath || null,
        pipelineId,
        { template: 'animation_knowledge' }
      );
      results.props = propsResult;
      results.steps.push({ name: 'props_gen', tokens: 0, ok: true });
      
      // Step 7: 渲染 + 质检
      console.log('\n🎥 [步骤7/7] 视频渲染 + 质检...');
      const renderResult = await renderPipeline(propsResult.outDir, pipelineId);
      results.render = renderResult;
      results.steps.push({ name: 'render', tokens: 0, ok: renderResult.success });
    } else {
      results.steps.push({ name: 'props_gen', tokens: 0, skip: true });
      results.steps.push({ name: 'render', tokens: 0, skip: true });
    }
    
    // 汇总
    const totalTokens = results.steps
      .filter(s => s.tokens > 0)
      .reduce((sum, s) => sum + s.tokens, 0);
    const totalCost = (totalTokens / 1_000_000 * 1).toFixed(4);
    const okSteps = results.steps.filter(s => s.ok).length;
    const totalSteps = results.steps.filter(s => !s.skip).length;
    const totalTime = ((Date.now() - pipeStartTime) / 1000).toFixed(1);
    
    console.log('\n' + '='.repeat(60));
    console.log('📊 管线完成汇总');
    console.log(`   步骤: ${okSteps}/${totalSteps} 成功`);
    console.log(`   耗时: ${totalTime}s`);
    console.log(`   Token: ${totalTokens} (¥${totalCost})`);
    if (results.render?.outputFile) {
      console.log(`   视频: ${results.render.outputFile}`);
    }
    console.log('='.repeat(60));
    
    // 保存结果
    const outputDir = path.join(CONFIG.PROJECT_DIR, 'scripts');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const resultJson = {
      pipelineId, userIdea,
      startTime: results.startTime,
      totalTime, totalTokens, totalCost,
      steps: results.steps,
      topicAnalysis: results.topicAnalysis?.analysis,
      script: results.script?.script,
      metadata: results.metadata?.metadata,
      render: results.render ? {
        success: results.render.success,
        outputFile: results.render.outputFile,
        retries: results.render.retries,
      } : null,
    };
    fs.writeFileSync(
      path.join(outputDir, `${pipelineId}_result.json`),
      JSON.stringify(resultJson, null, 2),
      'utf-8'
    );
    console.log(`\n📁 结果已保存至 scripts/${pipelineId}_result.json`);
    
    return results;
  } catch (err) {
    console.error(`\n❌ 管线执行失败:`, err.message);
    const outputDir = path.join(CONFIG.PROJECT_DIR, 'scripts');
    fs.writeFileSync(
      path.join(outputDir, `${pipelineId}_error.json`),
      JSON.stringify({ error: err.message, steps: results.steps }, null, 2),
      'utf-8'
    );
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
      
      // API: 审核通过 (T1.5 + T1.9 + T2.6)
      if (url.pathname.endsWith('/approve') && url.pathname.includes('/api/review/') && req.method === 'POST') {
        const id = url.pathname.split('/')[3];
        const body = await readBody();
        const { feedback } = JSON.parse(body || '{}');

        const review = reviewStore.get(id);
        if (!review) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: '审核不存在' }));
        }

        // 标记当前审核点为通过
        approveReview(id, feedback);

        try {
          // ============ 审核点 1: 脚本确认 → TTS + 素材检索 → 审阅点2 ============
          if (review.reviewPoint === 1) {
            const script = review.data.script.script;
            const ttsResult = await stepTTS(script, id);
            const assetResult = await stepAssetSearch(script, id);
            const storyboardReview = await stepStoryboardReview(id, script, ttsResult, assetResult);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              success: true,
              pipelineId: id,
              status: 'pending_review',
              review_point: 2,
              review_url: `/api/review/${id}`,
              summary: {
                tts_ok: ttsResult.success,
                voice_path: ttsResult.voicePath,
                scenes_count: script.scenes?.length || 0,
                total_duration: script.total_duration || 0,
              },
              message: '审阅点2: 请确认分镜与素材匹配，通过后调用 POST /api/review/:id/approve',
            }));
          }

          // ============ 审核点 2: 分镜确认 → Remotion Props → 渲染 → 审阅点3 ============
          if (review.reviewPoint === 2) {
            const script = review.data.script;
            const ttsResult = review.data.tts;
            const assetResult = review.data.assetSearch;
            const renderReview = await stepRenderWithReview(id, script, ttsResult, assetResult);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              success: true,
              pipelineId: id,
              status: 'pending_review',
              review_point: 3,
              review_url: `/api/review/${id}`,
              summary: {
                output_file: renderReview.outputFile,
                qc_passed: renderReview.qcPassed,
                retries: renderReview.retries,
                scenes_count: script.scenes?.length || 0,
              },
              message: '审阅点3: 请确认成片效果，通过后调用 POST /api/review/:id/approve 生成元数据',
            }));
          }

          // ============ 审核点 3: 成片确认 → 元数据生成 → 完成 ============
          if (review.reviewPoint === 3) {
            const script = review.data.script;
            const videoInfo = {
              resolution: '1920x1080', fps: 30, codec: 'h264',
              duration: script.total_duration || 60,
            };
            const metadataResult = await stepMetadataGeneration(script, videoInfo);

            // 保存完整管线结果
            const outputDir = path.join(CONFIG.PROJECT_DIR, 'scripts');
            const fullResult = {
              pipelineId: id,
              userIdea: review.data.pipelineId ? '待补充' : '',
              script,
              tts: review.data.tts,
              render: {
                outputFile: review.data.outputFile,
                outputDir: review.data.outputDir,
                qcPassed: review.data.qcPassed,
                retries: review.data.retries,
              },
              metadata: metadataResult,
              reviews: {
                point1: { status: 'approved', time: new Date(review.createdAt).toISOString() },
                point3: { status: 'approved', feedback, time: new Date().toISOString() },
              },
              completedAt: new Date().toISOString(),
            };
            fs.writeFileSync(
              path.join(outputDir, `${id}_result.json`),
              JSON.stringify(fullResult, null, 2), 'utf-8'
            );

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              success: true,
              pipelineId: id,
              status: 'completed',
              metadata: metadataResult.metadata,
              output: `scripts/${id}_result.json`,
              message: '🎉 管线完成! 所有步骤已执行并保存',
            }));
          }

          // 未知审核点
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: `未知审核点: ${review.reviewPoint}` }));
        } catch (e) {
          console.error(`审核点${review.reviewPoint} 执行失败:`, e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: e.message, review_point: review.reviewPoint }));
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
      
      // API: 独立渲染 (T2.3) - 从 props 目录触发渲染管线
      if (url.pathname === '/api/render' && req.method === 'POST') {
        const body = await readBody();
        const { propsDir, pipelineId } = JSON.parse(body);

        if (!propsDir) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: '缺少 propsDir 参数' }));
        }

        const result = await renderPipeline(propsDir, pipelineId || `render_${Date.now()}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: result.success, data: result }));
      }

      // API: TTS 配音生成 (T1.10)
      if (url.pathname === '/api/tts' && req.method === 'POST') {
        const body = await readBody();
        const { script, pipelineId } = JSON.parse(body);
        const result = await stepTTS(script, pipelineId || `tts_${Date.now()}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: result.success, data: result }));
      }

      // API: YouTube 授权状态 (T3.1)
      if (url.pathname === '/api/youtube/status' && req.method === 'GET') {
        const status = youtubeStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(status));
      }

      // API: YouTube OAuth 授权 (T3.1) - 触发浏览器授权流程
      if (url.pathname === '/api/youtube/auth' && req.method === 'POST') {
        try {
          const token = await youtubeAuth();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true, message: 'YouTube 授权成功', expires_at: token.expires_at }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: e.message }));
        }
      }

      // API: YouTube 视频上传 (T3.5)
      if (url.pathname === '/api/youtube/upload' && req.method === 'POST') {
        const body = await readBody();
        const { videoFile, metadata } = JSON.parse(body);

        if (!videoFile) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: '缺少 videoFile 参数' }));
        }

        try {
          const result = await youtubeUpload(videoFile, metadata || {});
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
        'POST /api/pipeline              # 完整管线（无审核）',
        'POST /api/pipeline-with-review  # 带审核管线（审核点1→2→3 级联）',
        'POST /api/topic-analysis        # 单独选题分析',
        'POST /api/script-gen             # 单独脚本生成',
        'POST /api/metadata               # 单独元数据生成',
        'POST /api/tts                    # 单独 TTS 配音生成',
        'POST /api/render                 # 独立渲染管线（含 QC + 重试）',
        'GET  /api/youtube/status         # YouTube 授权状态',
        'POST /api/youtube/auth           # YouTube OAuth 授权（打开浏览器）',
        'POST /api/youtube/upload         # YouTube 视频上传',
        'GET  /api/review/:id             # 查询审核状态',
        'POST /api/review/:id/approve     # 审核通过（自动级联到下一阶段）',
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
