# 局域网聊天系统

纯 HTML5 + CSS3 + JavaScript 实现的局域网聊天室，**零 npm 依赖**：前端原生 JS，后端 Node.js 内置 `http` 模块，数据库用 Node 22.5+ 内置的 `node:sqlite`（WAL 模式）。

## 在线演示（GitHub Pages）

> 🎬 **[在线演示版](https://yuheng-prog.github.io/chatWB20261103/)**（本仓库 `docs/` 目录）

GitHub Pages 只能托管静态文件，所以演示版把后端"搬"进了浏览器：

- 注册 / 登录 / 发消息全部用 `localStorage` 模拟，交互、样式与真实版完全一致
- 数据只保存在**当前浏览器**，换设备不同步；页面顶部有黄色提示栏，可一键清空演示数据
- 演示版代码在 `docs/`，真实版代码在 `public/` + 根目录，两者界面代码保持同步

想体验"真的能互聊"的版本，请在本地按下节步骤启动。

## 本地运行（真实版，局域网可互聊）

```bash
node server.js
# 或 Windows 双击 start.bat
```

- 本机访问：<http://localhost:8000>
- 局域网访问：启动后控制台会列出所有本机局域网地址（如 `http://192.168.x.x:8000`），发给同一 WiFi 下的手机/电脑即可
- 数据：全部存在 `data/chat.db`（SQLite，含 WAL 伴随文件，属正常现象）
- 健康检查：<http://localhost:8000/api/health>

要求 Node.js ≥ 22.5（用到内置 `node:sqlite`），无需 `npm install`。

## 功能

- 注册 / 登录（scrypt 加盐哈希，数据库不存明文密码）
- 账号列表 + 最后一条消息预览
- 一对一私聊，2 秒轮询增量拉取新消息（`after` 参数）
- 会话 token 保存在 `localStorage`，刷新不掉登录态
- 基础安全：参数化 SQL 防注入、textContent 防 XSS、路径穿越防护、请求体限流

## 目录结构

```
├── public/        # 前端静态文件（真实版，由 server.js 托管）
├── docs/          # GitHub Pages 静态演示版（无后端，localStorage 模拟）
├── server.js      # 后端：静态托管 + REST API
├── db.js          # SQLite 数据访问层（node:sqlite，单例连接 + WAL）
├── start.bat      # Windows 一键启动
└── data/          # 数据库文件（gitignore，不入库）
```

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/register` | 注册 |
| POST | `/api/login` | 登录，返回 token |
| POST | `/api/logout` | 退出登录 |
| GET | `/api/me` | 当前用户 |
| GET | `/api/users` | 全部账号 + 最后消息预览 |
| GET/POST | `/api/messages` | 拉取 / 发送消息（`?peerId=&after=`） |
| GET | `/api/health` | 健康检查 |
