'use strict';
/**
 * ============================================================================
 * db.js —— SQLite 数据访问层（数据库连接部分，本文重点）
 * ============================================================================
 *
 * 【为什么不用 better-sqlite3 / sqlite3 这些 npm 包？】
 *   Node 22.5+ 内置了 `node:sqlite` 模块（本机 Node 24.20.0 已稳定可用），
 *   它直接调用 Node 内部静态编译的 SQLite 引擎。
 *   好处：零依赖、不用 npm install、不用编译 C++、断网也能跑、运维只需一个 node 命令。
 *   注意：本机 SQLite 版本由 Node 自带，不读取系统 PATH 里的 sqlite3.exe；
 *        系统里的 sqlite3 命令行工具仍然可以用来查看同一个 .db 文件（方便排查数据）。
 *
 * 【连接的三条核心原则，先说结论再看代码】
 *   1) 用绝对路径（__dirname）拼数据库文件位置。
 *      绝对不能用相对路径 'data/chat.db'！否则从不同的工作目录启动，
 *      Node 会在不同目录各建一个空库，表现为"数据莫名其妙丢了"——运维第一大坑。
 *   2) 连接只建立一次（单例），进程内全局复用。
 *      每次请求都 new DatabaseSync() 会不断重复打开文件句柄，最终 EMFILE。
 *   3) 一次连接就要把关键 PRAGMA 设好：WAL、busy_timeout、foreign_keys。
 *      少设一个 busy_timeout，多端并发写就可能直接抛 SQLITE_BUSY。
 *
 * 【为什么用同步 API（DatabaseSync）而不是异步？】
 *   node:sqlite 只提供同步 API。本地磁盘上的单条 SQL 通常是微秒级，
 *   单进程内串行执行完全够用，而且天然避免并发写冲突。
 *   如果真的遇到写放大（大量并发写入），正确做法是加队列或换服务端数据库，
 *   而不是在聊天这种小场景里纠结异步。
 */

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');   // 内置模块：用于密码加盐哈希
const fs = require('node:fs');           // 内置模块：用于创建 data 目录
const path = require('node:path');       // 内置模块：用于拼绝对路径

// ---------------------------------------------------------------------------
// 1. 路径：一律从 __dirname（本文件所在目录）出发，得到绝对路径
//    C:\...\chatWB20261103\data\chat.db
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'chat.db');

// ---------------------------------------------------------------------------
// 2. 单例连接。第一次调用时才真正打开数据库，之后直接返回同一个对象。
// ---------------------------------------------------------------------------
let db = null;

function getDb() {
  if (db) return db;                       // 已有连接，直接复用（关键：不要重复打开）

  // mkdirSync(recursive) 等价于 mkdir -p，目录已存在也不会报错
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // ★ 建立连接：文件不存在时 SQLite 会自动创建一个 0 字节的库文件
  //   注意：只创建"库文件"，表结构要靠下面的 initSchema() 建
  db = new DatabaseSync(DB_FILE);

  // ★★★ 连接级 PRAGMA：必须在建表前设置，且每次连接都要设（不会持久化到文件）★★★
  //   journal_mode = WAL：写日志改为预写日志。读写不互相阻塞，
  //       多人同时发消息时，查询不会被写入锁住。会在 data 目录额外生成
  //       chat.db-wal 和 chat.db-shm 两个文件——这是正常的，不要删。
  db.exec('PRAGMA journal_mode = WAL');
  //   busy_timeout = 5000：遇到锁时最多等 5 秒再报错，而不是立刻抛 SQLITE_BUSY。
  //       这是并发场景下最容易被忽略、又最容易出事故的一行。
  db.exec('PRAGMA busy_timeout = 5000');
  //   foreign_keys = ON：SQLite 默认不校验外键，必须每个连接手动打开。
  //       打开后 messages.from_id 必须真实存在于 users.id，脏数据进不来。
  db.exec('PRAGMA foreign_keys = ON');
  //   synchronous = NORMAL：WAL 模式下的推荐值，在安全性和写入速度之间取平衡。
  db.exec('PRAGMA synchronous = NORMAL');

  initSchema(db);
  return db;
}

// ---------------------------------------------------------------------------
// 3. 建表。CREATE TABLE IF NOT EXISTS 可以反复执行，所以不需要额外的迁移工具，
//    服务每次启动自动跑一遍即可（幂等）。
// ---------------------------------------------------------------------------
function initSchema(d) {
  d.exec(`
    -- 账号表
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,  -- 自增主键
      username      TEXT    NOT NULL UNIQUE,            -- 账号，唯一约束防重复注册
      password_hash TEXT    NOT NULL,                   -- 密码哈希（绝不存明文）
      salt          TEXT    NOT NULL,                   -- 每个账号独立的随机盐
      created_at    INTEGER NOT NULL                    -- 注册时间（毫秒时间戳）
    );

    -- 消息表
    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,     -- 自增 ID，天然按时间有序
      from_id    INTEGER NOT NULL,                      -- 发送者
      to_id      INTEGER NOT NULL,                      -- 接收者
      content    TEXT    NOT NULL,                      -- 消息正文
      created_at INTEGER NOT NULL,                      -- 发送时间（毫秒时间戳）
      FOREIGN KEY (from_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (to_id)   REFERENCES users(id) ON DELETE CASCADE
    );

    -- 会话表：登录后发一个随机 token，前端存 localStorage，后续请求带上
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT    PRIMARY KEY,                   -- 随机令牌
      user_id    INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,                      -- 过期时间（毫秒）
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 索引：聊天记录永远按"两人对话 + id 升序"查，这个组合索引最关键
    CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages (from_id, to_id, id);
    CREATE INDEX IF NOT EXISTS idx_messages_to   ON messages (to_id, id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
  `);
}

// ---------------------------------------------------------------------------
// 4. 密码处理：scrypt 加盐哈希（Node 内置 crypto，无需 bcrypt 依赖）
//    数据库里永远只有 hash 和 salt，没有明文密码 —— 这是账号安全底线。
// ---------------------------------------------------------------------------
function hashPassword(password, salt) {
  // scryptSync(密码, 盐, 输出长度) -> Buffer，转 hex 存 TEXT 字段
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

// 定长比较，避免通过响应时间推测密码（timingSafeEqual 要求两个 Buffer 等长）
function safeEqual(a, b) {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// 5. 账号相关操作 —— 全部使用"预编译语句 + 参数占位符"
//    ★ 安全要点：永远不要用字符串拼接 SQL（'... WHERE name=' + input），
//      那是 SQL 注入的入口。prepare(?) 让 SQLite 自己处理转义。
// ---------------------------------------------------------------------------
function createUser(username, password) {
  const d = getDb();
  const salt = crypto.randomBytes(16).toString('hex');       // 16 字节随机盐
  const passwordHash = hashPassword(password, salt);
  const createdAt = Date.now();

  const stmt = d.prepare(
    'INSERT INTO users (username, password_hash, salt, created_at) VALUES (?, ?, ?, ?)'
  );
  const info = stmt.run(username, passwordHash, salt, createdAt);
  // lastInsertRowid 就是刚插入那行的 id
  return { id: Number(info.lastInsertRowid), username, created_at: createdAt };
}

function findUserByName(username) {
  const d = getDb();
  // .get() 只取第一行，没有则返回 undefined
  return d.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function verifyUser(username, password) {
  const user = findUserByName(username);
  if (!user) return null;                                    // 账号不存在
  const hash = hashPassword(password, user.salt);            // 用同一把盐重算
  if (!safeEqual(hash, user.password_hash)) return null;      // 密码不匹配
  return user;
}

// 所有账号列表（登录后展示），附带"我和他最后一条消息"，用于显示预览
function listUsers(meId) {
  const d = getDb();
  return d.prepare(`
    SELECT
      u.id,
      u.username,
      u.created_at,
      (SELECT m.content FROM messages m
        WHERE (m.from_id = u.id AND m.to_id = ?) OR (m.from_id = ? AND m.to_id = u.id)
        ORDER BY m.id DESC LIMIT 1) AS last_content,
      (SELECT m.created_at FROM messages m
        WHERE (m.from_id = u.id AND m.to_id = ?) OR (m.from_id = ? AND m.to_id = u.id)
        ORDER BY m.id DESC LIMIT 1) AS last_at
    FROM users u
    ORDER BY last_at IS NULL, last_at DESC, u.username ASC
  `).all(meId, meId, meId, meId);
}

// ---------------------------------------------------------------------------
// 6. 会话（登录态）
// ---------------------------------------------------------------------------
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;   // 7 天

function createSession(userId) {
  const d = getDb();
  const token = crypto.randomBytes(24).toString('hex');       // 48 位十六进制随机串
  const now = Date.now();
  d.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now, now + SESSION_TTL);
  return token;
}

function getSessionUser(token) {
  if (!token) return null;
  const d = getDb();
  const row = d.prepare(`
    SELECT s.token, s.expires_at, u.id, u.username
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(token);

  if (!row) return null;
  if (row.expires_at < Date.now()) {                          // 过期就顺手删掉
    d.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { id: row.id, username: row.username };
}

function deleteSession(token) {
  getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// 定期清理过期会话，防止 sessions 表无限膨胀（运维友好）
function cleanExpiredSessions() {
  try {
    getDb().prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  } catch (err) {
    console.error('[db] 清理过期会话失败:', err.message);
  }
}

// ---------------------------------------------------------------------------
// 7. 消息
// ---------------------------------------------------------------------------
function saveMessage(fromId, toId, content) {
  const d = getDb();
  const createdAt = Date.now();
  const info = d.prepare(
    'INSERT INTO messages (from_id, to_id, content, created_at) VALUES (?, ?, ?, ?)'
  ).run(fromId, toId, content, createdAt);
  return { id: Number(info.lastInsertRowid), from_id: fromId, to_id: toId, content, created_at: createdAt };
}

/**
 * 取两人之间的聊天记录。
 * afterId > 0 时只取"更新的消息"，前端轮询用它可以大幅减少数据传输。
 */
function listMessages(meId, peerId, afterId = 0) {
  return getDb().prepare(`
    SELECT id, from_id, to_id, content, created_at
    FROM messages
    WHERE ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))
      AND id > ?
    ORDER BY id ASC
  `).all(meId, peerId, peerId, meId, afterId);
}

function userExists(id) {
  return !!getDb().prepare('SELECT id FROM users WHERE id = ?').get(id);
}

// 优雅关闭：进程退出前关掉连接，让 WAL 正常 checkpoint 回主库文件
function closeDb() {
  if (db) {
    try { db.close(); } catch (_) { /* 忽略重复关闭 */ }
    db = null;
  }
}

module.exports = {
  DB_FILE,
  getDb,
  createUser,
  findUserByName,
  verifyUser,
  listUsers,
  createSession,
  getSessionUser,
  deleteSession,
  cleanExpiredSessions,
  saveMessage,
  listMessages,
  userExists,
  closeDb,
};
