// 飞书 Webhook 接收服务 v2
const http = require('http');
const crypto = require('crypto');

const PORT = 5678;

// ============ 飞书配置 ============
const FEISHU_VERIFICATION_TOKEN = 'OZpiHzrgEca84569uGHOqdHovpCYyb7p';
const FEISHU_ENCRYPT_KEY = 'ai-video-factory-2024-secret';

// ============ 解密函数（飞书 AES-256-CBC） ============
// 飞书加密格式：base64decode(encrypt) = IV(16字节) + 密文
function decrypt(encryptKey, encrypt) {
  try {
    const key = crypto.createHash('sha256').update(encryptKey).digest();
    const ciphertext = Buffer.from(encrypt, 'base64');
    const iv = ciphertext.subarray(0, 16);
    const encryptedData = ciphertext.subarray(16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedData, null, 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    console.error('解密失败:', e.message);
    return null;
  }
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    console.log(`\n=== ${new Date().toISOString()} ===`);
    console.log('原始 body:', body.substring(0, 300));

    let data;
    try {
      data = JSON.parse(body);
    } catch (e) {
      console.error('JSON 解析失败:', e.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid json' }));
      return;
    }

    // 飞书 v2 加密格式：整个 body 是 {"encrypt":"..."}
    if (data.encrypt) {
      console.log('检测到加密数据，开始解密...');
      const decrypted = decrypt(FEISHU_ENCRYPT_KEY, data.encrypt);
      if (!decrypted) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'decrypt failed' }));
        return;
      }
      console.log('解密后:', decrypted.substring(0, 500));

      try {
        data = JSON.parse(decrypted);
      } catch (e) {
        console.error('解密后 JSON 解析失败:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'parse decrypted failed' }));
        return;
      }
    }

    // URL 验证（旧版格式）
    if (data.type === 'url_verification') {
      console.log('URL 验证 (旧版), challenge:', data.challenge);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ challenge: data.challenge }));
      return;
    }

    // URL 验证（新版 schema 格式）
    if (data.schema === '2.0' && data.header) {
      console.log('事件 v2.0, 类型:', data.header.event_type);
      
      if (data.header.event_type === 'url_verification') {
        const challenge = data.event && data.event.token;
        console.log('URL 验证 (v2), token:', challenge);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const response = { challenge: challenge };
        console.log('返回:', JSON.stringify(response));
        res.end(JSON.stringify(response));
        return;
      }

      // 业务事件（消息接收等）
      console.log('业务事件:', data.header.event_type);
      if (data.event) {
        console.log('事件内容:', JSON.stringify(data.event).substring(0, 500));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0 }));
      return;
    }

    // 旧版事件
    if (data.header && data.header.event_type) {
      console.log('事件 (旧版), 类型:', data.header.event_type);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0 }));
      return;
    }

    // 其他
    console.log('未知格式, keys:', Object.keys(data));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 0 }));
  });
});

server.listen(PORT, () => {
  console.log(`飞书 Webhook 服务已启动: http://localhost:${PORT}/webhook/feishu`);
  console.log(`Encrypt Key: ${FEISHU_ENCRYPT_KEY}`);
  console.log('等待飞书回调...');
});
