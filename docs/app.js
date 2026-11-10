'use strict';
/**
 * ============================================================================
 * app.js —— 前端逻辑（原生 JavaScript，无任何框架）· GitHub Pages 静态演示版
 * ============================================================================
 * 与 public/app.js 的唯一区别：没有后端。
 *   public/app.js     调 /api/* 接口  → 需要 node server.js 起来才能用
 *   本文件（docs/app.js） 调 localApi() → 数据存在 localStorage，纯浏览器里就能跑
 *
 * 为了不改动任何界面代码，这里实现了一个"假后端"：
 *   localApi('/api/login', {method:'POST', body:{...}})
 * 它的返回结构、错误文案、401 语义全部和 server.js 保持一致，
 * 所以下面的登录、轮询、发消息逻辑一个字都不用改。
 *
 * 数据都放在 localStorage 的 chat_demo_* 三个键里，清空浏览器数据即彻底重置。
 * ========================================================================== */

/* ========================= 一、本地"后端"（模拟 server.js） ================= */

const LS = {
  users: 'chat_demo_users',
  messages: 'chat_demo_messages',
  session: 'chat_demo_session',
};

function loadTable(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];   // 数据被手改坏了就当作空表，不让整个页面白屏
  }
}

function saveTable(key, rows) {
  localStorage.setItem(key, JSON.stringify(rows));
}

// 发消息时间、id 都和真实后端一样用递增整数，前端靠 id > lastId 做增量拉取
function nextId(rows) {
  return rows.reduce((max, row) => (row.id > max ? row.id : max), 0) + 1;
}

/**
 * 极简密码哈希。
 * ★ 真实后端用 scrypt + 随机盐（见 db.js），这里跑在浏览器里、demo 用途，
 *   用一个非密码学强度的散列就够了 —— 目的只是"别把明文密码直接摆在 localStorage 里"。
 */
function hashPassword(password) {
  let h = 5381;
  for (let i = 0; i < password.length; i += 1) {
    h = ((h << 5) + h + password.charCodeAt(i)) | 0;
  }
  return 'demo$' + (h >>> 0).toString(16);
}

function err(status, message) {
  return { __error: true, status, message };
}

/**
 * 本地接口分发。签名与 fetch 版 api() 完全一致，方便将来切回真后端。
 */
function localApi(path, { method = 'GET', body } = {}) {
  const users = loadTable(LS.users);
  const messages = loadTable(LS.messages);
  const session = loadTable(LS.session)[0] || null;
  const payload = body || {};

  const [route, query = ''] = path.split('?');
  const params = new URLSearchParams(query);

  // ---- 离线/慢速网络体验：统一包一层 Promise，和真实 fetch 一样是异步的 ----
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const done = (data) => (data && data.__error ? reject(data) : resolve(data));

      switch (route) {
        // ------------------------------ 注册 ------------------------------
        case '/api/register': {
          if (method !== 'POST') return done(err(404, '接口不存在'));
          const username = String(payload.username || '').trim();
          const password = String(payload.password || '');

          if (!/^[\w\u4e00-\u9fa5]{2,20}$/.test(username)) {
            return done(err(400, '账号需 2-20 位，仅限中英文、数字、下划线'));
          }
          if (password.length < 6) return done(err(400, '密码至少 6 位'));
          if (users.some((u) => u.username === username)) {
            return done(err(409, '该账号已被注册'));
          }

          const user = {
            id: nextId(users),
            username,
            password_hash: hashPassword(password),
            created_at: Date.now(),
          };
          users.push(user);
          saveTable(LS.users, users);
          return done({ id: user.id, username: user.username });
        }

        // ------------------------------ 登录 ------------------------------
        case '/api/login': {
          if (method !== 'POST') return done(err(404, '接口不存在'));
          const username = String(payload.username || '').trim();
          const password = String(payload.password || '');

          const user = users.find((u) => u.username === username);
          // 不区分"账号不存在"和"密码错误"，和后端保持一致
          if (!user || user.password_hash !== hashPassword(password)) {
            return done(err(401, '账号或密码错误'));
          }

          const token = 'demo-' + Math.random().toString(16).slice(2) + Date.now().toString(16);
          saveTable(LS.session, [{ token, user_id: user.id, created_at: Date.now() }]);
          return done({ token, user: { id: user.id, username: user.username } });
        }

        // --------------------------- 以下需登录 ---------------------------
        default:
          break;
      }

      const me = session ? users.find((u) => u.id === session.user_id) : null;
      if (!me) return done(err(401, '未登录或登录已过期'));

      switch (route) {
        case '/api/logout':
          saveTable(LS.session, []);
          return done({ ok: true });

        case '/api/me':
          return done({ user: { id: me.id, username: me.username } });

        case '/api/users': {
          const list = users.map((u) => {
            // 每个账号的"最后一条消息"，用于左侧列表预览
            const mine = messages.filter(
              (m) => (m.from_id === u.id && m.to_id === me.id) || (m.from_id === me.id && m.to_id === u.id)
            );
            const last = mine[mine.length - 1];
            return {
              id: u.id,
              username: u.username,
              createdAt: u.created_at,
              lastMessage: last ? last.content : '',
              lastAt: last ? last.created_at : 0,
              isMe: u.id === me.id,
            };
          });
          // 和后端 ORDER BY 一致：有消息的按时间倒序在前，没消息的按名字排在后面
          list.sort((a, b) => {
            if (!a.lastAt && b.lastAt) return 1;
            if (a.lastAt && !b.lastAt) return -1;
            if (b.lastAt !== a.lastAt) return b.lastAt - a.lastAt;
            return a.username.localeCompare(b.username, 'zh-CN');
          });
          return done({ me: { id: me.id, username: me.username }, users: list });
        }

        case '/api/messages': {
          const peerId = Number(params.get('peerId') || payload.to);
          const peer = users.find((u) => u.id === peerId);
          if (!peerId || !peer) return done(err(400, '对方账号不存在'));

          // 拉取
          if (method === 'GET') {
            const after = Number(params.get('after') || 0);
            const list = messages
              .filter(
                (m) =>
                  ((m.from_id === me.id && m.to_id === peerId) ||
                    (m.from_id === peerId && m.to_id === me.id)) &&
                  m.id > after
              )
              .map((m) => ({
                id: m.id,
                from_id: m.from_id,
                to_id: m.to_id,
                content: m.content,
                created_at: m.created_at,
              }));
            return done({ messages: list });
          }

          // 发送
          if (method === 'POST') {
            const content = String(payload.content || '').trim();
            if (!content) return done(err(400, '消息不能为空'));
            if (content.length > 2000) return done(err(400, '单条消息最多 2000 字'));

            const msg = {
              id: nextId(messages),
              from_id: me.id,
              to_id: peerId,
              content,
              created_at: Date.now(),
            };
            messages.push(msg);
            saveTable(LS.messages, messages);
            return done({ message: msg });
          }
          return done(err(404, '接口不存在'));
        }

        default:
          return done(err(404, '接口不存在'));
      }
    }, 120);   // 模拟一点网络延迟，让加载态、防重复点击等逻辑和真机一致
  });
}

/* ------------------------------- 全局状态 ------------------------------- */
const state = {
  token: localStorage.getItem('chat_token') || '',
  me: null,
  users: [],
  peerId: 0,      // 当前聊天对象
  lastId: 0,      // 当前会话已收到的最大消息 id，用于增量拉取
};

/* ------------------------------- DOM 缓存 ------------------------------- */
const $ = (id) => document.getElementById(id);

const authView = $('authView');
const chatView = $('chatView');
const authForm = $('authForm');
const usernameEl = $('username');
const passwordEl = $('password');
const authSubmit = $('authSubmit');
const authMsg = $('authMsg');

const meNameEl = $('meName');
const userListEl = $('userList');
const userCountEl = $('userCount');
const logoutBtn = $('logoutBtn');

const chatTitleEl = $('chatTitle');
const chatSubEl = $('chatSub');
const messageListEl = $('messageList');
const sendForm = $('sendForm');
const messageInput = $('messageInput');
const sendBtn = $('sendBtn');

let authMode = 'login';   // 'login' | 'register'

/* ------------------------------- 网络封装 ------------------------------- */
/**
 * 统一请求入口：自动带 token、自动处理 401（登录过期就退回登录页）
 * ★ 与 public/app.js 相比只改了中间那一行：
 *   真后端  → const res = await fetch(path, {...}); const data = await res.json();
 *   静态演示 → const data = await localApi(path, {...});
 */
async function api(path, { method = 'GET', body } = {}) {
  const data = await localApi(path, { method, body });

  if (!data) throw new Error('请求失败');

  // 登录态失效，静默退回登录页（和后端 401 的处理一致）
  if (path !== '/api/login' && data.__error && data.status === 401) {
    logout(true);
    throw new Error(data.message || '请重新登录');
  }
  return data;
}

/* ------------------------------- 视图切换 ------------------------------- */
function showAuth() {
  chatView.classList.add('hidden');
  authView.classList.remove('hidden');
}

function showChat() {
  authView.classList.add('hidden');
  chatView.classList.remove('hidden');
  meNameEl.textContent = state.me ? state.me.username : '';
}

/* ------------------------------- 登录 / 注册 ----------------------------- */
// 顶部 tab 切换
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    authMode = tab.dataset.mode;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    authSubmit.textContent = authMode === 'login' ? '登录' : '注册';
    authMsg.textContent = '';
    authMsg.className = 'form-msg';
    passwordEl.value = '';
  });
});

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = usernameEl.value.trim();
  const password = passwordEl.value;

  if (!username || !password) {
    return showMsg('请填写账号和密码');
  }

  authSubmit.disabled = true;
  try {
    if (authMode === 'register') {
      await api('/api/register', { method: 'POST', body: { username, password } });
      // 注册成功后直接登录，少一步操作
      showMsg('注册成功，正在登录…', true);
    }

    const data = await api('/api/login', { method: 'POST', body: { username, password } });
    state.token = data.token;
    state.me = data.user;
    localStorage.setItem('chat_token', data.token);

    authMsg.textContent = '';
    showChat();
    startChat();
  } catch (err2) {
    showMsg(err2.message);
  } finally {
    authSubmit.disabled = false;
  }
});

function showMsg(text, ok = false) {
  authMsg.textContent = text;
  authMsg.className = 'form-msg' + (ok ? ' ok' : '');
}

/* ------------------------------- 聊天主流程 ----------------------------- */
function startChat() {
  loadUsers();
  startPolling();
}

async function loadUsers() {
  try {
    const data = await api('/api/users');
    state.users = data.users;
    renderUsers();
  } catch (err2) {
    console.warn('加载账号列表失败:', err2.message);
  }
}

function renderUsers() {
  userListEl.innerHTML = '';
  userCountEl.textContent = state.users.length;

  state.users.forEach((user) => {
    const li = document.createElement('li');
    li.className = 'user-item' + (user.id === state.peerId ? ' active' : '');

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = user.username.slice(0, 1);

    const info = document.createElement('div');
    info.className = 'user-info';

    const name = document.createElement('div');
    name.className = 'user-name';
    // ★ 用 textContent 而不是 innerHTML —— 账号名里即使有 <script> 也不会被执行
    name.textContent = user.username;
    if (user.isMe) {
      const tag = document.createElement('span');
      tag.className = 'badge-me';
      tag.textContent = '我';
      name.appendChild(tag);
    }

    const preview = document.createElement('div');
    preview.className = 'user-preview';
    preview.textContent = user.lastMessage || (user.isMe ? '这是我自己' : '暂无消息');

    info.append(name, preview);
    li.append(avatar, info);

    // 不能和自己聊天，其余账号点击即进入会话
    if (!user.isMe) li.addEventListener('click', () => openPeer(user));
    else li.style.cursor = 'default';

    userListEl.appendChild(li);
  });
}

async function openPeer(user) {
  state.peerId = user.id;
  state.lastId = 0;
  messageListEl.innerHTML = '';
  chatTitleEl.textContent = user.username;
  chatSubEl.textContent = '对方 ID: ' + user.id;

  messageInput.disabled = false;
  sendBtn.disabled = false;
  messageInput.focus();

  renderUsers();          // 刷新左侧选中态
  await loadMessages(true);
}

/**
 * 拉消息：initial=true 表示切换会话后的首次全量拉取，否则只拉增量
 */
async function loadMessages(initial = false) {
  if (!state.peerId) return;

  const peerId = state.peerId;
  const after = initial ? 0 : state.lastId;

  try {
    const data = await api(`/api/messages?peerId=${peerId}&after=${after}`);
    // 用户可能在请求返回前切了人，丢弃过期响应
    if (peerId !== state.peerId) return;

    if (initial) messageListEl.innerHTML = '';

    if (data.messages.length) {
      data.messages.forEach(appendMessage);
      scrollToBottom();
    } else if (initial) {
      const tip = document.createElement('div');
      tip.className = 'empty';
      tip.textContent = '还没有聊天记录，发送第一条消息吧';
      messageListEl.appendChild(tip);
    }
  } catch (err2) {
    console.warn('拉取消息失败:', err2.message);
  }
}

function appendMessage(msg) {
  if (msg.id <= state.lastId) return;      // 去重，防止重复渲染
  state.lastId = msg.id;

  // 第一条消息出现时，移除"还没有聊天记录"之类的空态提示
  const empty = messageListEl.querySelector('.empty');
  if (empty) empty.remove();

  const mine = msg.from_id === state.me.id;

  const row = document.createElement('div');
  row.className = 'msg-row' + (mine ? ' mine' : '');

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = msg.content;        // 纯文本渲染，天然防 XSS

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.textContent = formatTime(msg.created_at);

  row.append(bubble, meta);
  messageListEl.appendChild(row);
}

function scrollToBottom() {
  messageListEl.scrollTop = messageListEl.scrollHeight;
}

function formatTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? hm : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

/* ------------------------------- 发送消息 ------------------------------- */
sendForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const content = messageInput.value.trim();
  if (!content || !state.peerId) return;

  sendBtn.disabled = true;
  try {
    const data = await api('/api/messages', {
      method: 'POST',
      body: { to: state.peerId, content },
    });
    messageInput.value = '';
    appendMessage(data.message);   // 立即上屏，不用等下一次轮询
    scrollToBottom();
    loadUsers();                   // 顺便刷新左侧"最后一条消息"预览
  } catch (err2) {
    alert(err2.message);
  } finally {
    sendBtn.disabled = false;
    messageInput.focus();
  }
});

/* ------------------------------- 轮询 ------------------------------- */
let pollTimer = null;
let polling = false;

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    if (polling || !state.token) return;   // 上一次还没回来就跳过，避免请求堆积
    polling = true;
    try {
      await loadUsers();
      if (state.peerId) {
        const before = state.lastId;
        await loadMessages(false);
        // 有新消息才滚动，避免一直把用户顶到底部
        if (state.lastId !== before) scrollToBottom();
      }
    } finally {
      polling = false;
    }
  }, 2000);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/* ------------------------------- 退出 ------------------------------- */
logoutBtn.addEventListener('click', () => logout(false));

async function logout(silent) {
  stopPolling();
  if (!silent && state.token) {
    try { await api('/api/logout', { method: 'POST' }); } catch (_) { /* 忽略 */ }
  }
  state.token = '';
  state.me = null;
  state.peerId = 0;
  state.lastId = 0;
  localStorage.removeItem('chat_token');
  messageListEl.innerHTML = '';
  messageInput.value = '';
  messageInput.disabled = true;
  sendBtn.disabled = true;
  chatTitleEl.textContent = '请选择左侧账号开始聊天';
  passwordEl.value = '';
  showAuth();
}

/* --------------------------- 演示数据重置 --------------------------- */$('resetBtn').addEventListener('click', (e) => {
  e.preventDefault();
  if (!confirm('清空当前浏览器里的所有演示账号和聊天记录？此操作不可撤销。')) return;
  Object.keys(localStorage)
    .filter((k) => k.startsWith('chat_demo_') || k === 'chat_token')
    .forEach((k) => localStorage.removeItem(k));
  location.reload();
});

/* ------------------------------- 启动 ------------------------------- */
// 演示版首屏给两句提示，降低"为什么注册完看不到别人"的困惑
$('demoHint').textContent = '提示：换一个账号名再注册一次，就能在左侧列表里看到两个账号并互相发消息。';

// 带着 token 刷新页面：先验证 token 还有效，有效就直接进聊天界面
(async function boot() {
  // 换台电脑打开时，localStorage 里的旧 token 找不到对应会话，很自然就退回登录页
  if (!state.token) return showAuth();
  try {
    const data = await api('/api/me');
    state.me = data.user;
    showChat();
    startChat();
  } catch (_) {
    showAuth();
  }
})();
