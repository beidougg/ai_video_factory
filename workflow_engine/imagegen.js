#!/usr/bin/env node
/**
 * AI 文生图补位模块 (M9 Prompt 构建器 + M10 生成客户端)
 *
 * 职责:
 *   - buildImagePrompt: 分镜 JSON → 结构化图像 prompt（DeepSeek，失败有兜底）
 *   - generateImage: 统一图像生成接口（多供应商可配置，超时/重试/降级风格/成本日志）
 *   - getMonthlyCost: 当月生成成本汇总（供预算熔断）
 *
 * 供应商:
 *   - dashscope    阿里万相 wanx2.1-t2i-turbo（异步任务轮询）
 *   - siliconflow  FLUX.1-schnell（同步）
 *   - mock         本地 FFmpeg 生成测试图（非 AI，仅用于无 key 时的集成验证）
 *
 * 用法:
 *   node imagegen.js test                    # 用 mock 生成一张测试图
 *   node imagegen.js cost                    # 输出当月成本汇总
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execSync } = require('child_process');
const { ffmpeg } = require('./ffmpeg');

require('./env');

const PROJECT_DIR = path.resolve(__dirname, '..');
const LOGS_DIR = path.join(PROJECT_DIR, 'logs');
const CALL_LOG = path.join(LOGS_DIR, 'imagegen_calls.jsonl');

const CONFIG = {
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
  DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
  DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  IMAGE_PROVIDER: process.env.IMAGE_PROVIDER || 'mock',
  DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY || '',
  SILICONFLOW_API_KEY: process.env.SILICONFLOW_API_KEY || '',
  MONTHLY_BUDGET: parseFloat(process.env.IMAGEGEN_MONTHLY_BUDGET || '30'),
  CALL_TIMEOUT_MS: 60000,
};

// 供应商刊例价（元/张），以官网实时价为准，I0.2 实测校正
const PROVIDER_COST = { dashscope: 0.08, siliconflow: 0.014, volcengine: 0.2, mock: 0 };

// 供应商支持的最大长边（超出则先降采样生成，入库时再放大到目标尺寸）
const PROVIDER_MAX_LONG_EDGE = { dashscope: 1440, siliconflow: 1536, volcengine: 2048, mock: 99999 };

// 需要真实画面的场景，本地预检命中即跳过（spec AC-1）
const SKIP_KEYWORDS = ['实拍', '采访', '街拍', '真人出镜', '纪录片', '街景'];

const DEFAULT_NEGATIVE = 'watermark, text, logo, qr code, face closeup, deformed hands, blurry';
const DEFAULT_STYLE = '扁平插画风格，简洁现代，高饱和度配色';
const FALLBACK_STYLE = '极简线条风格，纯色背景，主体居中'; // 降级备用风格

// ============ 工具函数 ============

function extractJSON(text) {
  if (!text) return null;
  // 去掉 markdown 代码围栏
  let t = String(text).replace(/```json\s*/gi, '').replace(/```\s*/g, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

function httpRequest({ url, method = 'GET', headers = {}, body = null, timeout = CONFIG.CALL_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const transport = u.protocol === 'https:' ? https : http;
    const req = transport.request(
      { hostname: u.hostname, path: u.pathname + u.search, method, headers, timeout },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, body: buf });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`请求超时 (${timeout}ms)`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function httpJSON(options) {
  const body = options.body ? JSON.stringify(options.body) : null;
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const res = await httpRequest({ ...options, headers, body });
  const text = res.body.toString('utf-8');
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`响应非 JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (res.status >= 400) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return json;
}

async function downloadToBuffer(url) {
  const res = await httpRequest({ url });
  if (res.status >= 400) throw new Error(`下载图像失败 HTTP ${res.status}`);
  return res.body;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============ 调用日志（M10 数据源） ============

function appendCallLog(entry) {
  try {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(CALL_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf-8');
  } catch (e) {
    console.warn('   ⚠️ 写生成日志失败:', e.message);
  }
}

/** 当月累计生成成本（元） */
function getMonthlyCost(month) {
  const m = month || new Date().toISOString().slice(0, 7); // YYYY-MM
  if (!fs.existsSync(CALL_LOG)) return { month: m, total: 0, count: 0, failures: 0 };
  let total = 0, count = 0, failures = 0;
  for (const line of fs.readFileSync(CALL_LOG, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (!e.ts || !e.ts.startsWith(m)) continue;
      if (e.ok) { total += e.cost || 0; count++; } else { failures++; }
    } catch { /* 跳过坏行 */ }
  }
  return { month: m, total: Math.round(total * 1000) / 1000, count, failures };
}

// ============ M9: Prompt 构建器 ============

function loadPromptTemplate() {
  return fs.readFileSync(path.join(PROJECT_DIR, 'prompts', 'image_prompt.txt'), 'utf-8');
}

async function callDeepSeek(systemPrompt, userContent, maxTokens = 1200, temperature = 0.6) {
  const json = await httpJSON({
    url: `${CONFIG.DEEPSEEK_BASE_URL}/chat/completions`,
    method: 'POST',
    headers: { Authorization: `Bearer ${CONFIG.DEEPSEEK_API_KEY}` },
    body: {
      model: CONFIG.DEEPSEEK_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature,
      max_tokens: maxTokens,
    },
  });
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek 返回为空');
  return content;
}

/**
 * LLM 失败兜底：分镜文案原文 + 类型约束 + 风格拼接（plan §5 风险缓解）
 */
function buildFallbackPrompt(scene, { style, type, orientation }) {
  const styleToken = style || DEFAULT_STYLE;
  let prompt = `${scene.text || scene.suggestion || '抽象概念画面'}，${styleToken}`;
  if (type === 'background') prompt += '，低对比度简洁背景';
  if (type === 'cover') prompt += '，主体大而醒目，视觉冲击力强';
  if (type === 'transparent_png') prompt += '，单个图标元素，主体居中，纯绿色背景(#00FF00)，背景纯净无渐变无阴影';
  if (orientation === 'portrait') prompt += '，竖屏垂直构图，主体居中偏上';
  return {
    skip: false,
    reason: 'LLM 不可用，使用兜底 prompt',
    prompt,
    negative_prompt: DEFAULT_NEGATIVE,
    keywords: [],
    _fallback: true,
  };
}

/**
 * 分镜 → 图像 prompt
 * @param {object} scene - { text, suggestion, required_tags }
 * @param {object} options - { style, type, orientation, feedback }
 * @returns {Promise<{skip, reason, prompt, negative_prompt, keywords}>}
 */
async function buildImagePrompt(scene, options = {}) {
  const { style = '', type = 'scene', orientation = 'landscape', feedback = '' } = options;

  // 本地预检：真实画面场景直接跳过，省 LLM 调用
  const haystack = `${scene.suggestion || ''} ${(scene.required_tags || []).join(' ')}`;
  const hit = SKIP_KEYWORDS.find((k) => haystack.includes(k));
  if (hit) {
    return { skip: true, reason: `分镜指向真实画面（命中"${hit}"），不触发 AI 生成`, prompt: '', negative_prompt: '', keywords: [] };
  }

  const template = loadPromptTemplate();
  const systemPrompt = template
    .replace('{{scene_text}}', scene.text || '')
    .replace('{{suggestion}}', scene.suggestion || '')
    .replace('{{type}}', type)
    .replace('{{orientation}}', orientation)
    .replace('{{style}}', style || DEFAULT_STYLE);

  const userContent = feedback
    ? `请生成图像提示词。用户对上一版的修改意见：${feedback}（请在保持分镜约束的前提下按意见调整）`
    : '请生成图像提示词。';

  try {
    const content = await callDeepSeek(systemPrompt, userContent);
    const parsed = extractJSON(content);
    if (!parsed || typeof parsed.skip === 'undefined') throw new Error('LLM 输出无法解析');
    if (parsed.skip) return { ...parsed, prompt: '', negative_prompt: '' };
    if (!parsed.prompt) throw new Error('LLM 输出缺少 prompt 字段');
    return parsed;
  } catch (e) {
    console.warn(`   ⚠️ Prompt 构建 LLM 失败（${e.message}），使用兜底`);
    return buildFallbackPrompt(scene, { style, type, orientation });
  }
}

// ============ M10: 生成客户端 ============

/** 按供应商上限降采样，保持宽高比 */
function providerSize(provider, width, height) {
  const maxLong = PROVIDER_MAX_LONG_EDGE[provider] || 1440;
  const long = Math.max(width, height);
  if (long <= maxLong) return { width, height };
  const ratio = maxLong / long;
  return { width: Math.round(width * ratio / 2) * 2, height: Math.round(height * ratio / 2) * 2 };
}

// ---- DashScope（阿里万相，异步任务） ------------
async function genDashScope({ prompt, negativePrompt, width, height }) {
  if (!CONFIG.DASHSCOPE_API_KEY) throw new Error('未配置 DASHSCOPE_API_KEY');
  const size = providerSize('dashscope', width, height);
  const create = await httpJSON({
    url: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CONFIG.DASHSCOPE_API_KEY}`,
      'X-DashScope-Async': 'enable',
    },
    body: {
      model: 'wanx2.1-t2i-turbo',
      input: { prompt, negative_prompt: negativePrompt },
      parameters: { size: `${size.width}*${size.height}`, n: 1 },
    },
  });
  const taskId = create.output?.task_id;
  if (!taskId) throw new Error(`DashScope 未返回 task_id: ${JSON.stringify(create).slice(0, 200)}`);

  const deadline = Date.now() + CONFIG.CALL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(2000);
    const task = await httpJSON({
      url: `https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`,
      headers: { Authorization: `Bearer ${CONFIG.DASHSCOPE_API_KEY}` },
    });
    const status = task.output?.task_status;
    if (status === 'SUCCEEDED') {
      const imgUrl = task.output?.results?.[0]?.url;
      if (!imgUrl) throw new Error('任务成功但无图像 URL');
      return { imageBuffer: await downloadToBuffer(imgUrl), genSize: size };
    }
    if (status === 'FAILED' || status === 'CANCELED') {
      throw new Error(`DashScope 任务${status}: ${task.output?.message || ''}`);
    }
    // PENDING / RUNNING → 继续轮询
  }
  throw new Error('DashScope 任务超时');
}

// ---- SiliconFlow（FLUX，同步） ------------
async function genSiliconFlow({ prompt, negativePrompt, width, height }) {
  if (!CONFIG.SILICONFLOW_API_KEY) throw new Error('未配置 SILICONFLOW_API_KEY');
  const size = providerSize('siliconflow', width, height);
  const json = await httpJSON({
    url: 'https://api.siliconflow.cn/v1/images/generations',
    method: 'POST',
    headers: { Authorization: `Bearer ${CONFIG.SILICONFLOW_API_KEY}` },
    body: {
      model: 'black-forest-labs/FLUX.1-schnell',
      prompt: `${prompt}. Negative: ${negativePrompt}`,
      width: size.width,
      height: size.height,
      n: 1,
    },
  });
  const imgUrl = json.images?.[0]?.url;
  if (!imgUrl) throw new Error(`SiliconFlow 未返回图像: ${JSON.stringify(json).slice(0, 200)}`);
  return { imageBuffer: await downloadToBuffer(imgUrl), genSize: size };
}

// ---- Mock（本地 FFmpeg 测试图，非 AI 调用，仅供无 key 时集成验证） ------------
async function genMock({ prompt, width, height, type }) {
  const outFile = path.join(LOGS_DIR, `mock_${Date.now()}_${width}x${height}.png`);
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
  if (type === 'transparent_png') {
    // 绿幕 + 居中色块，验证 colorkey 去背链路
    execSync(
      `"${ffmpeg}" -y -f lavfi -i "color=c=0x00FF00:s=${width}x${height}:d=1" -vf "drawbox=x=iw/4:y=ih/4:w=iw/2:h=ih/2:c=0x3366FF:t=fill" -frames:v 1 "${outFile}"`,
      { stdio: 'pipe' }
    );
  } else {
    execSync(
      `"${ffmpeg}" -y -f lavfi -i "gradients=s=${width}x${height}:c0=0x1A2A6C:c1=0xB21F1F:c2=0xFDBB2D" -frames:v 1 "${outFile}"`,
      { stdio: 'pipe' }
    );
  }
  const imageBuffer = fs.readFileSync(outFile);
  fs.unlinkSync(outFile);
  return { imageBuffer, genSize: { width, height } };
}

const PROVIDERS = {
  dashscope: genDashScope,
  siliconflow: genSiliconFlow,
  volcengine: async () => { throw new Error('volcengine 通道留接口未实现（plan §1.3），请改用 dashscope 或 siliconflow'); },
  mock: genMock,
};

/**
 * 统一图像生成接口（plan §3.1）
 * 容错：超时 60s → 同 prompt 重试 1 次 → 备用风格重试 1 次 → throw（由 M12 降级）
 *
 * @param {object} opts - { prompt, negativePrompt, width, height, type, pipelineId, sceneIndex }
 * @returns {Promise<{imageBuffer, cost, provider, latencyMs, genSize}>}
 */
async function generateImage(opts) {
  const { width, height, type = 'scene', pipelineId = '', sceneIndex = -1 } = opts;
  const provider = CONFIG.IMAGE_PROVIDER;
  const gen = PROVIDERS[provider];
  if (!gen) throw new Error(`未知 IMAGE_PROVIDER: ${provider}`);

  const attempts = [
    { label: '首次', prompt: opts.prompt, negativePrompt: opts.negativePrompt || DEFAULT_NEGATIVE },
    { label: '重试', prompt: opts.prompt, negativePrompt: opts.negativePrompt || DEFAULT_NEGATIVE },
    { label: '备用风格', prompt: `${opts.prompt}，${FALLBACK_STYLE}`, negativePrompt: opts.negativePrompt || DEFAULT_NEGATIVE },
  ];

  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    const t0 = Date.now();
    try {
      const { imageBuffer, genSize } = await gen({ prompt: a.prompt, negativePrompt: a.negativePrompt, width, height, type });
      const latencyMs = Date.now() - t0;
      const cost = PROVIDER_COST[provider] || 0;
      appendCallLog({ pipeline_id: pipelineId, scene_index: sceneIndex, type, size: `${width}x${height}`, provider, ok: true, cost, latency_ms: latencyMs, attempt: i + 1 });
      return { imageBuffer, cost, provider, latencyMs, genSize };
    } catch (e) {
      lastErr = e;
      appendCallLog({ pipeline_id: pipelineId, scene_index: sceneIndex, type, size: `${width}x${height}`, provider, ok: false, cost: 0, latency_ms: Date.now() - t0, attempt: i + 1, error: e.message.slice(0, 200) });
      console.warn(`   ⚠️ 生成失败[${a.label}]: ${e.message}`);
    }
  }
  throw new Error(`图像生成 3 次尝试均失败: ${lastErr?.message}`);
}

// ============ CLI ============
if (require.main === module) {
  const cmd = process.argv[2];
  (async () => {
    if (cmd === 'test') {
      const type = process.argv[3] || 'scene';
      console.log(`🧪 mock 生成测试 (type=${type}, provider=${CONFIG.IMAGE_PROVIDER})`);
      const r = await generateImage({ prompt: '测试画面', width: 1920, height: 1080, type, pipelineId: 'manual_test' });
      const out = path.join(LOGS_DIR, `test_${type}_${Date.now()}.png`);
      fs.writeFileSync(out, r.imageBuffer);
      console.log(`✅ ${out} (${r.latencyMs}ms, ¥${r.cost})`);
    } else if (cmd === 'cost') {
      console.log(JSON.stringify(getMonthlyCost(), null, 2));
    } else {
      console.log('用法: node imagegen.js test [scene|transparent_png] | node imagegen.js cost');
    }
  })().catch((e) => { console.error('❌', e.message); process.exit(1); });
}

module.exports = { buildImagePrompt, generateImage, getMonthlyCost, DEFAULT_NEGATIVE, DEFAULT_STYLE };
