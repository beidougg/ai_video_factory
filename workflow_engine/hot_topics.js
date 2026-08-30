#!/usr/bin/env node
/**
 * 热点话题 Provider (O5.1)
 * 接入多个免费热榜 API（抖音热榜等），带降级逻辑
 *
 * 设计:
 * - 依次尝试多个免费源，任一成功即返回
 * - 全部失败时返回空数组（绝不抛异常，保证下游流程可用）
 * - 可选走代理（从 HTTPS_PROXY/HTTP_PROXY 环境变量读取，与项目其他模块一致）
 * - 可选写缓存文件，避免频繁请求第三方 API
 *
 * 用法:
 *   const { getTrendingTopics } = require('./hot_topics');
 *   const topics = await getTrendingTopics();  // [{ title, hot, url, source }]
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

let HttpsProxyAgent = null;
try {
  HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent;
} catch {}

const PROJECT_DIR = path.resolve(__dirname, '..');
const CACHE_FILE = path.join(PROJECT_DIR, 'outputs', 'hot_topics_cache.json');
const REQUEST_TIMEOUT = 8000; // 单源超时
const MAX_TOPICS = 20;        // 最多返回条数

// 免费热榜源列表（依次尝试）
const SOURCES = [
  {
    name: 'vvhan_douyin',
    url: 'https://api.vvhan.com/api/hotlist/douyinHot',
    parse: (json) => (json.data || []).map((item) => ({
      title: item.title || item.word || '',
      hot: item.hot || item.hotValue || 0,
      url: item.url || item.mobil_url || '',
    })),
  },
  {
    name: 'oioweb_douyin',
    url: 'https://api.oioweb.cn/api/common/HotList?type=douyin',
    parse: (json) => {
      const list = json.result?.list || json.data?.list || [];
      return list.map((item) => ({
        title: item.title || item.name || item.word || '',
        hot: item.hot || item.hotValue || 0,
        url: item.url || item.mobil_url || '',
      }));
    },
  },
  {
    name: 'vvhan_baidu',
    url: 'https://api.vvhan.com/api/hotlist/baiduRD',
    parse: (json) => (json.data || []).map((item) => ({
      title: item.title || item.word || '',
      hot: item.hot || 0,
      url: item.url || '',
    })),
  },
];

/**
 * 获取代理配置（环境变量优先，硬编码 fallback 与 youtube.js 一致）
 */
function getProxyUrl() {
  return process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7897';
}

/**
 * 发起 HTTPS GET 请求（可选代理）
 */
function fetchJson(url, useProxy) {
  return new Promise((resolve, reject) => {
    const options = { timeout: REQUEST_TIMEOUT, rejectUnauthorized: false };
    if (useProxy && HttpsProxyAgent) {
      options.agent = new HttpsProxyAgent(useProxy);
    }

    const req = https.get(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('JSON 解析失败'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
  });
}

/**
 * 读取缓存（若有）
 */
function readCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    // 缓存 1 小时内有效
    if (Date.now() - data.fetchedAt > 3600000) return null;
    return data.topics || [];
  } catch {
    return null;
  }
}

/**
 * 写入缓存
 */
function writeCache(topics) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ fetchedAt: Date.now(), topics }, null, 2), 'utf-8');
  } catch {}
}

/**
 * 获取热点话题（O5.1）
 * @param {Object} options - { useProxy?: boolean, refresh?: boolean }
 * @returns {Promise<Array<{title, hot, url, source}>>} 失败返回空数组
 */
async function getTrendingTopics(options = {}) {
  const useProxy = options.useProxy !== undefined ? options.useProxy : !!getProxyUrl();
  const proxy = useProxy ? getProxyUrl() : null;

  // 1. 尝试缓存（避免频繁请求第三方 API）
  if (!options.refresh) {
    const cached = readCache();
    if (cached && cached.length > 0) {
      console.log(`   📊 热点使用缓存 (${cached.length} 条)`);
      return cached;
    }
  }

  // 2. 依次尝试各源
  for (const source of SOURCES) {
    try {
      const json = await fetchJson(source.url, proxy);
      let topics = source.parse(json);
      topics = topics
        .filter((t) => t.title)
        .slice(0, MAX_TOPICS)
        .map((t) => ({ ...t, source: source.name }));

      if (topics.length > 0) {
        writeCache(topics);
        console.log(`   🔥 热点获取成功: ${source.name} (${topics.length} 条)`);
        return topics;
      }
      console.log(`   ⚠️ 热点源 ${source.name} 返回空列表`);
    } catch (e) {
      console.log(`   ⚠️ 热点源 ${source.name} 不可用: ${e.message}`);
    }
  }

  // 3. 全部失败：返回缓存（即使过期）或空数组（O5.1 降级：不抛异常）
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const stale = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      if (stale.topics?.length > 0) {
        console.log(`   📊 热点源全部不可用，使用过期缓存 (${stale.topics.length} 条)`);
        return stale.topics;
      }
    }
  } catch {}

  console.log('   ⚠️ 热点源全部不可用，返回空列表（降级）');
  return [];
}

/**
 * 同步版本：不抛异常，永远返回数组（供普通流程调用）
 */
function getTrendingTopicsSafe(options = {}) {
  return getTrendingTopics(options).catch(() => []);
}

// ============ CLI ============
if (require.main === module) {
  getTrendingTopics({ refresh: process.argv.includes('--refresh') })
    .then((topics) => {
      console.log(`\n获取热点 ${topics.length} 条:`);
      topics.slice(0, 10).forEach((t, i) => {
        console.log(`   ${i + 1}. [${t.hot || '?'}] ${t.title}`);
      });
    })
    .catch(() => {
      console.log('获取热点失败（返回空）');
    });
}

module.exports = { getTrendingTopics, getTrendingTopicsSafe, SOURCES };
