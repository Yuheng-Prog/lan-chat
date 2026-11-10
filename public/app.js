'use strict';
/**
 * ============================================================================
 * app.js —— 前端逻辑（原生 JavaScript，无任何框架）
 * ============================================================================
 * 思路：
 *   1. 登录成功后把 token 存进 localStorage，刷新页面仍是登录态
 *   2. 每 2 秒轮询一次：账号列表 + 当前会话的新消息（带 after 参数只取增量）
 *      轮询比 WebSocket 简单得多，局域网延迟要求不高时完全够用
 * ========================================================================== */

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
 * 返回解析后的 JSON；出错时抛 Error，由调用处 try/catch 处理
 */
async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = 'Bearer ' + state.token;

  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));

  if (res.status === 401 && path !== '/api/login') {
    logout(true);                                  // 登录态失效，静默退回登录页
    throw new Error(data.message || '请重新登录');
  }
  if (!res.ok) throw new Error(data.message || '请求失败');
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
  } catch (err) {
    showMsg(err.message);
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
  } catch (err) {
    console.warn('加载账号列表失败:', err.message);
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
  } catch (err) {
    console.warn('拉取消息失败:', err.message);
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
  } catch (err) {
    alert(err.message);
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

/* ------------------------------- 启动恢复 ------------------------------- */
// 带着 token 刷新页面：先验证 token 还有效，有效就直接进聊天界面
(async function boot() {
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
