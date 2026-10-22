/* ============================================================
   零依赖本地服务（Node ≥ 18）
   - 静态文件：仓库根目录（训练器 index.html、对局 table.html）
   - LLM 代理：POST /api/llm/chat、GET /api/llm/models
     目标地址由请求头 x-llm-base 指定，必须在白名单内（预置服务商 + 环境变量 LLM_PROXY_ALLOW）
   安全：只监听 127.0.0.1；只接受同源请求（防止其他网页借用本机代理）；不记录 API key
   运行：node server.js            → http://127.0.0.1:5173/table.html
        PORT=8080 node server.js
   ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 5173;
const VERSION = require('./package.json').version;
const UA = `mahjong-trainer/${VERSION} (+local proxy)`;

/* 与 src/llm/providers.mjs 保持一致 */
const ALLOW = new Set([
  'https://api.openai.com/v1',
  'https://api.deepseek.com',
  'https://openrouter.ai/api/v1',
  'https://api.moonshot.cn/v1',
  'https://opencode.ai/inference/go/openai/v1',
  ...String(process.env.LLM_PROXY_ALLOW || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean)
]);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8'
};

const PUBLIC_FILES = new Set(['index.html', 'table.html', 'favicon.ico']);
const PUBLIC_DIRS = new Set(['src', 'docs']);

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveStatic(req, res) {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return send(res, 400, 'bad url'); }
  if (rel === '/') rel = '/table.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep)) return send(res, 403, 'forbidden');
  // 只对外提供页面和前端源码；隐藏文件、.git、tools、work 等一律 404
  const parts = path.relative(ROOT, file).split(path.sep);
  const publicFile = parts.length === 1 ? PUBLIC_FILES.has(parts[0]) : PUBLIC_DIRS.has(parts[0]);
  if (!publicFile || parts.some(p => p.startsWith('.'))) return send(res, 404, 'not found');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

/* 只允许本服务自己的页面调用代理 */
function sameOrigin(req) {
  const host = req.headers.host;
  if (host !== `${HOST}:${PORT}` && host !== `localhost:${PORT}`) return false;     // 防 DNS 重绑定
  const origin = req.headers.origin;
  if (!origin) return req.headers['sec-fetch-site'] === 'same-origin' || !req.headers['sec-fetch-site'];
  return origin === `http://${HOST}:${PORT}` || origin === `http://localhost:${PORT}`;
}

const processSession = crypto.randomUUID();

async function proxy(req, res, kind) {
  if (!sameOrigin(req)) return send(res, 403, JSON.stringify({ error: { message: '代理只接受本页面的同源请求' } }), MIME['.json']);
  const base = String(req.headers['x-llm-base'] || '').replace(/\/+$/, '');
  if (!ALLOW.has(base)) {
    return send(res, 400, JSON.stringify({ error: { message: `目标地址不在代理白名单：${base || '(空)'}；可用环境变量 LLM_PROXY_ALLOW 追加` } }), MIME['.json']);
  }
  const headers = { 'User-Agent': UA, Accept: kind === 'chat' ? 'text/event-stream, application/json' : 'application/json' };
  if (req.headers.authorization) headers.Authorization = req.headers.authorization;
  if (base.startsWith('https://opencode.ai/')) {
    // OpenCode Go 要求每个会话带稳定的 x-opencode-session；UA 如实标明本工具身份
    const sid = String(req.headers['x-llm-session'] || '');
    headers['x-opencode-session'] = /^[\w-]{8,64}$/.test(sid) ? sid : processSession;
  }
  let body;
  if (kind === 'chat') {
    const chunks = [];
    let size = 0;
    for await (const c of req) { size += c.length; if (size > 1e6) return send(res, 413, 'too large'); chunks.push(c); }
    body = Buffer.concat(chunks);
    headers['Content-Type'] = 'application/json';
  }
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  let upstream;
  try {
    upstream = await fetch(`${base}/${kind === 'chat' ? 'chat/completions' : 'models'}`, { method: kind === 'chat' ? 'POST' : 'GET', headers, body, signal: ac.signal });
  } catch (e) {
    if (ac.signal.aborted) return;
    return send(res, 502, JSON.stringify({ error: { message: `代理连接上游失败：${e.message}` } }), MIME['.json']);
  }
  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
    'Cache-Control': 'no-store'
  });
  try {
    for await (const chunk of upstream.body) res.write(chunk);
  } catch { /* 客户端中断 */ }
  res.end();
  console.log(`[proxy] ${kind} → ${base} ${upstream.status}`);
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/api/llm/chat' && req.method === 'POST') return proxy(req, res, 'chat');
  if (url === '/api/llm/models' && req.method === 'GET') return proxy(req, res, 'models');
  if (url.startsWith('/api/')) return send(res, 404, 'not found');
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
  serveStatic(req, res);
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`川麻 AI 对局：http://${HOST}:${PORT}/table.html`);
    console.log(`牌效训练器：  http://${HOST}:${PORT}/index.html`);
  });
}

module.exports = { server, ALLOW };
