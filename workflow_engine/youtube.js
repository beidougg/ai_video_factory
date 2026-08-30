#!/usr/bin/env node
/**
 * YouTube 上传模块 (T3.5)
 * OAuth 2.0 授权 + videos.insert API 上传视频
 *
 * 用法:
 *   node youtube.js auth              # 首次 OAuth 授权（打开浏览器登录）
 *   node youtube.js upload <视频文件> [元数据JSON]  # 上传视频
 *   node youtube.js status            # 检查授权状态
 *   或作为模块: const { uploadVideo, checkAuth } = require('./youtube');
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { HttpsProxyAgent } = require('https-proxy-agent');

const PROJECT_DIR = path.resolve(__dirname, '..');
const TOKEN_FILE = path.join(PROJECT_DIR, '.youtube_token.json');

// ============ 代理配置 (解决国内访问 Google 超时) ============
const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7897';
const proxyAgent = new HttpsProxyAgent(PROXY_URL);
console.log(`   🔗 使用代理: ${PROXY_URL}`);

// ============ 配置（密钥从环境变量读取，避免泄露） ============
const CONFIG = {
  CLIENT_ID: process.env.YOUTUBE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '',
  CLIENT_SECRET: process.env.YOUTUBE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '',
  REDIRECT_URI: process.env.YOUTUBE_REDIRECT_URI || 'http://localhost:3000/callback',
  REDIRECT_PORT: parseInt(process.env.YOUTUBE_REDIRECT_PORT || '3000', 10),
  SCOPES: [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.readonly',
  ],
  TOKEN_FILE,
};

// 启动时检查必要配置
if (!CONFIG.CLIENT_ID || !CONFIG.CLIENT_SECRET) {
  console.warn('⚠️  警告：未设置 YOUTUBE_CLIENT_ID/YOUTUBE_CLIENT_SECRET 环境变量，YouTube 功能将不可用');
  console.warn('   请设置: export YOUTUBE_CLIENT_ID=your_id  和  export YOUTUBE_CLIENT_SECRET=your_secret');
}

// ============ Token 管理 ============

/**
 * 加载已存储的 token
 */
function loadToken() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * 保存 token
 */
function saveToken(token) {
  token.savedAt = new Date().toISOString();
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2), 'utf-8');
  console.log(`   ✅ Token 已保存至 ${TOKEN_FILE}`);
}

/**
 * 检查授权状态
 */
function checkAuth() {
  const token = loadToken();
  if (!token) {
    return { authenticated: false, message: '未授权，请运行: node youtube.js auth' };
  }

  const expiresAt = token.expires_at ? new Date(token.expires_at) : null;
  const isExpired = expiresAt && Date.now() > expiresAt.getTime();
  const hasRefresh = !!token.refresh_token;

  return {
    authenticated: true,
    accessToken: token.access_token ? token.access_token.slice(0, 20) + '...' : null,
    expiresAt: expiresAt?.toISOString(),
    isExpired,
    canRefresh: hasRefresh,
    message: isExpired
      ? (hasRefresh ? 'Token 已过期，但可自动刷新' : 'Token 已过期且无法刷新，需重新授权')
      : '授权有效',
  };
}

// ============ OAuth 2.0 授权流程 ============

/**
 * 首次授权：打开浏览器让用户登录 Google 账号
 */
function startOAuthFlow() {
  return new Promise((resolve, reject) => {
    const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: CONFIG.CLIENT_ID,
      redirect_uri: CONFIG.REDIRECT_URI,
      response_type: 'code',
      scope: CONFIG.SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
    }).toString();

    console.log('\n🔐 YouTube OAuth 2.0 授权');
    console.log('='.repeat(50));
    console.log('\n正在打开浏览器，请在浏览器中登录 Google 账号并授权...\n');

    // 启动本地服务器等待回调
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${CONFIG.REDIRECT_PORT}`);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        return res.end('Not found');
      }

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>授权失败</h1><p>错误: ${error}</p>`);
        server.close();
        reject(new Error(`授权失败: ${error}`));
        return;
      }

      if (!code) {
        res.writeHead(400);
        res.end('Missing code');
        return;
      }

      // 用 code 换取 token
      try {
        const token = await exchangeCodeForToken(code);
        saveToken(token);

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <html><body style="font-family:sans-serif;text-align:center;padding:50px">
          <h1 style="color:#4CAF50">✅ 授权成功！</h1>
          <p>YouTube 授权已完成，可以关闭此页面。</p>
          <p>Token 已保存，现在可以上传视频了。</p>
          </body></html>
        `);
        server.close();
        resolve(token);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>Token 交换失败</h1><p>${e.message}</p>`);
        server.close();
        reject(e);
      }
    });

    server.listen(CONFIG.REDIRECT_PORT, () => {
      console.log(`   📡 本地回调服务已启动: http://localhost:${CONFIG.REDIRECT_PORT}/callback`);
      console.log(`\n   如果浏览器没有自动打开，请手动访问:\n`);
      console.log(`   ${authUrl}\n`);

      // 尝试自动打开浏览器
      try {
        const startCmd = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        execSync(`${startCmd} "${authUrl}"`, { stdio: 'ignore' });
        console.log('   🌐 浏览器已打开，请在浏览器中完成授权...');
      } catch {
        console.log('   ⚠️ 无法自动打开浏览器，请手动复制上方链接到浏览器');
      }
    });

    // 超时处理
    setTimeout(() => {
      try { server.close(); } catch {}
      reject(new Error('授权超时（5分钟），请重试'));
    }, 300000);
  });
}

/**
 * 用 authorization code 换取 access_token + refresh_token
 */
function exchangeCodeForToken(code) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      code,
      client_id: CONFIG.CLIENT_ID,
      client_secret: CONFIG.CLIENT_SECRET,
      redirect_uri: CONFIG.REDIRECT_URI,
      grant_type: 'authorization_code',
    }).toString();

    const options = {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
      agent: proxyAgent,  // 使用代理
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const token = JSON.parse(data);
          if (token.error) {
            reject(new Error(`${token.error}: ${token.error_description || ''}`));
            return;
          }
          // 计算过期时间
          token.expires_at = new Date(Date.now() + (token.expires_in - 60) * 1000).toISOString();
          resolve(token);
        } catch (e) {
          reject(new Error(`Token 解析失败: ${e.message}, raw: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * 使用 refresh_token 刷新 access_token
 */
function refreshAccessToken(refreshToken) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      client_id: CONFIG.CLIENT_ID,
      client_secret: CONFIG.CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString();

    const options = {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
      agent: proxyAgent,  // 使用代理
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const token = JSON.parse(data);
          if (token.error) {
            reject(new Error(`${token.error}: ${token.error_description || ''}`));
            return;
          }
          token.refresh_token = refreshToken; // 保留 refresh_token
          token.expires_at = new Date(Date.now() + (token.expires_in - 60) * 1000).toISOString();
          resolve(token);
        } catch (e) {
          reject(new Error(`刷新 token 解析失败: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * 获取有效的 access_token（自动刷新）
 */
async function getValidAccessToken() {
  const token = loadToken();
  if (!token) {
    throw new Error('未授权，请先运行: node youtube.js auth');
  }

  const expiresAt = new Date(token.expires_at);
  if (Date.now() < expiresAt.getTime()) {
    // token 仍然有效
    return token.access_token;
  }

  if (!token.refresh_token) {
    throw new Error('Token 已过期且无法刷新，请重新运行: node youtube.js auth');
  }

  console.log('   🔄 Token 已过期，自动刷新中...');
  const newToken = await refreshAccessToken(token.refresh_token);
  saveToken(newToken);
  return newToken.access_token;
}

// ============ 视频上传 ============

/**
 * 上传视频到 YouTube (T3.5)
 * @param {string} videoFile - 视频文件路径
 * @param {Object} metadata - { title, description, tags, category, privacyStatus }
 * @returns {Object} { success, videoId, videoUrl }
 */
async function uploadVideo(videoFile, metadata = {}) {
  console.log('\n📤 YouTube 视频上传');
  console.log('='.repeat(50));
  console.log(`   文件: ${videoFile}`);
  console.log(`   标题: ${metadata.title || '未命名'}`);

  // 1. 检查文件
  if (!fs.existsSync(videoFile)) {
    throw new Error(`视频文件不存在: ${videoFile}`);
  }

  const fileSize = fs.statSync(videoFile).size;
  const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(1);
  console.log(`   大小: ${fileSizeMB} MB`);

  if (fileSize === 0) {
    throw new Error('视频文件为空');
  }

  // 2. 获取 access_token
  const accessToken = await getValidAccessToken();
  console.log('   ✅ 授权有效');

  // 3. 准备元数据
  const videoMetadata = {
    snippet: {
      title: (metadata.title || 'AI Video Factory').slice(0, 100),
      description: (metadata.description || '').slice(0, 5000),
      tags: (metadata.tags || []).slice(0, 500),
      categoryId: metadata.categoryId || '22', // 22 = People & Blogs, 27 = Education, 28 = Science & Technology
    },
    status: {
      privacyStatus: metadata.privacyStatus || 'private', // private | unlisted | public
      selfDeclaredMadeForKids: false,
    },
  };

  console.log(`   隐私: ${videoMetadata.status.privacyStatus}`);
  console.log(`   标签: ${videoMetadata.snippet.tags.join(', ') || '无'}`);

  // 4. 发起 resumable upload
  const uploadUrl = await initiateResumableUpload(accessToken, videoMetadata, fileSize);
  console.log(`   ✅ 上传会话已创建`);

  // 5. 上传视频文件
  const videoId = await uploadFileChunks(uploadUrl, videoFile, fileSize, accessToken);

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  console.log(`\n✅ 上传成功！`);
  console.log(`   Video ID: ${videoId}`);
  console.log(`   URL: ${videoUrl}`);

  return { success: true, videoId, videoUrl };
}

/**
 * 发起 resumable upload 请求
 */
function initiateResumableUpload(accessToken, metadata, fileSize) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(metadata);

    const options = {
      hostname: 'www.googleapis.com',
      path: '/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Upload-Content-Type': 'video/*',
        'X-Upload-Content-Length': fileSize,
      },
      agent: proxyAgent,  // 使用代理
    };

    const req = https.request(options, (res) => {
      if (res.statusCode === 200 || res.statusCode === 201) {
        const uploadUrl = res.headers.location;
        if (uploadUrl) {
          resolve(uploadUrl);
        } else {
          reject(new Error('未收到 upload URL'));
        }
      } else {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          reject(new Error(`发起上传失败 (${res.statusCode}): ${data.slice(0, 500)}`));
        });
      }
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * 分块上传视频文件
 */
function uploadFileChunks(uploadUrl, videoFile, fileSize, accessToken) {
  return new Promise((resolve, reject) => {
    const fileData = fs.readFileSync(videoFile);
    const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB per chunk
    let uploaded = 0;

    function uploadChunk(start) {
      const end = Math.min(start + CHUNK_SIZE - 1, fileSize - 1);
      const chunk = fileData.slice(start, end + 1);
      const contentRange = `bytes ${start}-${end}/${fileSize}`;

      const url = new URL(uploadUrl);
      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'PUT',
        headers: {
          'Content-Length': chunk.length,
          'Content-Range': contentRange,
        },
        agent: proxyAgent,  // 使用代理
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));

        if (res.statusCode === 200 || res.statusCode === 201) {
          // 上传完成
          try {
            const response = JSON.parse(data);
            resolve(response.id);
          } catch {
            reject(new Error(`上传完成但响应解析失败: ${data.slice(0, 200)}`));
          }
        } else if (res.statusCode === 308) {
          // 部分上传成功，继续下一块
          uploaded = end + 1;
          const progress = ((uploaded / fileSize) * 100).toFixed(0);
          process.stdout.write(`\r   📤 上传进度: ${progress}%`);
          if (uploaded < fileSize) {
            uploadChunk(uploaded);
          }
        } else {
          reject(new Error(`上传失败 (${res.statusCode}): ${data.slice(0, 300)}`));
        }
      });
      req.on('error', reject);
      req.write(chunk);
      req.end();
    }

    uploadChunk(0);
  });
}

// ============ CLI ============
if (require.main === module) {
  const command = process.argv[2];

  if (command === 'auth') {
    startOAuthFlow()
      .then(() => {
        console.log('\n🎉 YouTube 授权完成！现在可以上传视频了。');
        process.exit(0);
      })
      .catch((err) => {
        console.error('\n❌ 授权失败:', err.message);
        process.exit(1);
      });
  } else if (command === 'status') {
    const status = checkAuth();
    console.log('\n📊 YouTube 授权状态');
    console.log('='.repeat(30));
    console.log(JSON.stringify(status, null, 2));
  } else if (command === 'upload') {
    const videoFile = process.argv[3];
    const metadataFile = process.argv[4];
    let metadata = {};
    if (metadataFile && fs.existsSync(metadataFile)) {
      metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf-8'));
    }
    uploadVideo(videoFile, metadata)
      .then((result) => {
        console.log(`\n🎬 视频已上传: ${result.videoUrl}`);
        process.exit(0);
      })
      .catch((err) => {
        console.error('\n❌ 上传失败:', err.message);
        process.exit(1);
      });
  } else {
    console.log('YouTube 上传模块 (T3.5)');
    console.log('用法:');
    console.log('  node youtube.js auth                       # 首次 OAuth 授权');
    console.log('  node youtube.js status                     # 检查授权状态');
    console.log('  node youtube.js upload <视频文件> [元数据JSON]  # 上传视频');
    console.log('\n示例:');
    console.log('  node youtube.js auth');
    console.log('  node youtube.js upload outputs/pipe_xxx/final.mp4 metadata.json');
  }
}

module.exports = { uploadVideo, checkAuth, startOAuthFlow, getValidAccessToken };
