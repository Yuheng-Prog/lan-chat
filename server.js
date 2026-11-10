'use strict';
/**
 * ============================================================================
 * server.js —— 局域网聊天系统（后端）
 * ============================================================================
 *
 * 【技术选型说明】
 *   只用 HTML5 + CSS3 + JavaScript：
 *     - 前端：public/ 下的 .html / .css / .js，由本文件静态托管
 *     - 后端：Node.js（JavaScript 运行时）+ 内置 http 模块
 *     - 数据库：SQLite，通过 Node 内置的 node:sqlite 驱动直连（见 db.js）
 *   全程零 npm 依赖，不联网也能启动。
 *
 * 【启动】node server.js
 *   默认监听 0.0.0.0:8000 —— 绑定 0.0.0.0 而不是 127.0.0.1，
 *   局域网内其它设备才能访问；只想本机用就把 HOST 改成 '127.0.0.1'。
 *
 * 【运维要点】
 *   - 端口：环境变量 PORT 可覆盖，例如 PORT=9000 node server.js（Windows PowerShell 用 $env:PORT=9000）
 *   - 数据：全部在 data/chat.db（含 -wal / -shm 两个伴随文件，属正常现象）
 *   - 备份：停服后直接复制 data 整个目录；不停服时用 sqlite3 命令行
 *           sqlite3 data/chat.db ".backup backup.db" 做在线热备
 *   - 探活：GET /api/health 返回 {ok:true, db:"ok", uptime:秒}
 *   - 日志：所有请求一行访问日志（方法 路径 状态码 耗时），出错带堆栈
 *   - 防火墙：Windows 首次运行若弹窗，必须勾选"专用网络"允许，否则局域网访问不通
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('./db');

const PORT = Number(process.env.PORT || 8000);
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 1 * 1024 * 1024;   // 请求体上限 1MB，防超大包打爆内存

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',              // 接口一律不缓存，避免拿到旧数据
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();                        // 直接断开，不再继续收
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});  // 空 body 当空对象
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

// 从 Authorization: Bearer <token> 解析当前登录用户
function currentUser(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return store.getSessionUser(token);          // 无效/过期返回 null
}

// ---------------------------------------------------------------------------
// 静态文件：只允许读取 public 目录内的文件（防 ../ 目录穿越）
// ---------------------------------------------------------------------------
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(PUBLIC_DIR, '.' + decodeURIComponent(rel));

  // 解析后必须以 public 目录开头，否则是越权访问
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403 Forbidden');
  }

  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',            // 开发期避免前端改完不生效
    });
    res.end(buf);
  });
}

// ---------------------------------------------------------------------------
// 业务接口
// ---------------------------------------------------------------------------
async function handleApi(req, res, url) {
  const { pathname } = url;

  // ---- 探活（运维监控用，不需要登录）----
  if (pathname === '/api/health' && req.method === 'GET') {
    try {
      store.getDb().prepare('SELECT 1 AS ok').get();   // 真正打一次库，确认连接正常
      return sendJson(res, 200, { ok: true, db: 'ok', uptime: Math.round(process.uptime()) });
    } catch (err) {
      return sendJson(res, 500, { ok: false, db: 'error', message: err.message });
    }
  }

  // ---- 注册 ----
  if (pathname === '/api/register' && req.method === 'POST') {
    const body = await readBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');

    // 服务端校验：前端校验只是体验，安全必须在后端再做一次
    if (!/^[\w\u4e00-\u9fa5]{2,20}$/.test(username)) {
      return sendJson(res, 400, { message: '账号需 2-20 位，仅限中英文、数字、下划线' });
    }
    if (password.length < 6) {
      return sendJson(res, 400, { message: '密码至少 6 位' });
    }
    if (store.findUserByName(username)) {
      return sendJson(res, 409, { message: '该账号已被注册' });
    }

    const user = store.createUser(username, password);
    return sendJson(res, 201, { id: user.id, username: user.username });
  }

  // ---- 登录 ----
  if (pathname === '/api/login' && req.method === 'POST') {
    const body = await readBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');

    const user = store.verifyUser(username, password);
    if (!user) {
      // 不区分"账号不存在"和"密码错误"，避免账号枚举
      return sendJson(res, 401, { message: '账号或密码错误' });
    }
    const token = store.createSession(user.id);
    return sendJson(res, 200, { token, user: { id: user.id, username: user.username } });
  }

  // ---- 以下接口都需要登录 ----
  const me = currentUser(req);
  if (!me) return sendJson(res, 401, { message: '未登录或登录已过期' });

  // 退出登录
  if (pathname === '/api/logout' && req.method === 'POST') {
    const header = req.headers['authorization'] || '';
    store.deleteSession(header.slice(7).trim());
    return sendJson(res, 200, { ok: true });
  }

  // 我是谁
  if (pathname === '/api/me' && req.method === 'GET') {
    return sendJson(res, 200, { user: me });
  }

  // 所有账号列表
  if (pathname === '/api/users' && req.method === 'GET') {
    const users = store.listUsers(me.id).map((u) => ({
      id: u.id,
      username: u.username,
      createdAt: u.created_at,
      lastMessage: u.last_content || '',
      lastAt: u.last_at || 0,
      isMe: u.id === me.id,
    }));
    return sendJson(res, 200, { me, users });
  }

  // 拉取和某人的聊天记录（after 用于增量轮询）
  if (pathname === '/api/messages' && req.method === 'GET') {
    const peerId = Number(url.searchParams.get('peerId'));
    const after = Number(url.searchParams.get('after') || 0);
    if (!peerId || !store.userExists(peerId)) {
      return sendJson(res, 400, { message: '对方账号不存在' });
    }
    const messages = store.listMessages(me.id, peerId, after);
    return sendJson(res, 200, { messages });
  }

  // 发消息
  if (pathname === '/api/messages' && req.method === 'POST') {
    const body = await readBody(req);
    const toId = Number(body.to);
    const content = String(body.content || '').trim();

    if (!toId || !store.userExists(toId)) {
      return sendJson(res, 400, { message: '对方账号不存在' });
    }
    if (!content) return sendJson(res, 400, { message: '消息不能为空' });
    if (content.length > 2000) return sendJson(res, 400, { message: '单条消息最多 2000 字' });

    const msg = store.saveMessage(me.id, toId, content);
    return sendJson(res, 201, { message: msg });
  }

  return sendJson(res, 404, { message: '接口不存在' });
}

// ---------------------------------------------------------------------------
// 主处理入口：访问日志 + 统一错误兜底
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  res.on('finish', () => {
    console.log(`${req.method} ${url.pathname}${url.search} -> ${res.statusCode} ${Date.now() - started}ms`);
  });

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url.pathname);
    }
  } catch (err) {
    console.error('[server] 请求处理失败:', err);
    if (!res.headersSent) sendJson(res, 500, { message: '服务器内部错误' });
    else res.end();
  }
});

// ---------------------------------------------------------------------------
// 启动：打印本机 + 所有局域网地址，方便直接发给同事
// ---------------------------------------------------------------------------
function lanAddresses() {
  const list = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      // family 在旧版 Node 是 'IPv4'，新版可能是数字 4，两种都兼容
      const isIPv4 = net.family === 'IPv4' || net.family === 4;
      if (isIPv4 && !net.internal) list.push({ name, address: net.address });
    }
  }
  return list;
}

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  局域网聊天系统已启动');
  console.log('  ---------------------------------------------');
  console.log(`  本机访问    http://localhost:${PORT}`);
  for (const { name, address } of lanAddresses()) {
    console.log(`  局域网访问  http://${address}:${PORT}   (${name})`);
  }
  console.log(`  数据库文件  ${store.DB_FILE}`);
  console.log(`  健康检查    http://localhost:${PORT}/api/health`);
  console.log('  ---------------------------------------------');
  console.log('  按 Ctrl+C 停止服务');
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[端口占用] ${PORT} 已被占用。换端口：PORT=8001 node server.js`);
    process.exit(1);
  }
  console.error('[server] 启动失败:', err);
  process.exit(1);
});

// 优雅退出：关连接再退出，保证 WAL 正常合并回主库文件
function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在关闭...`);
  server.close(() => {
    store.closeDb();
    console.log('已关闭数据库连接，服务退出。');
    process.exit(0);
  });
  // 兜底：5 秒内没退干净就强退（避免卡住终端）
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// 每小时清理一次过期会话
setInterval(store.cleanExpiredSessions, 60 * 60 * 1000).unref();
