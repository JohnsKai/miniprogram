# 灵途 · travel-agent-miniapp

> **给 Agent 的说明**：新会话请先读本文档，再按需打开具体文件。无需全量浏览项目。

微信原生小程序（**无 npm**），品牌名 **「灵途」**，对接后端 AI 服务，完成：**表单采集偏好 → 多轮聊天规划 → 结构化行程展示 → 规划后对话调整**。

- **路径**：`/Users/kai/workspace/miniprogram`
- **基础库**：3.3.4
- **AppID**：`wx2d6181733223d4fc`（见 `project.config.json`）
- **规模**：约 58 个源码文件（不含 `.idea`）
- **设计参考**：Figma Make — 旅行APP设计

---

## 页面结构

| 页面 | 路径 | 作用 |
|------|------|------|
| 规划 | `pages/index/index` | Tab 首页。旅行表单（目的地、天数、风格、预算等），提交后 `navigateTo` planning |
| 我的 | `pages/mine/mine` | Tab 页。个人区、历史方案、收藏路线、设置入口；支持微信登录与云端同步 |
| 聊天规划 | `pages/planning/planning` | **核心页**（~1700 行 JS）。聊天 UI、SSE 流式、追问轮询、侧栏历史、断线重连、规划后对话 |
| 结果 | `pages/result/result` | 结构化行程独立展示（summary + day-card），可从 globalData 或 `/plan/result` 加载 |
| sessions | `pages/sessions/sessions` | 兼容入口，仅 redirect 到 planning |

---

## 导航与 Tab

- **自定义 Tab**（非微信原生 tabBar）：`components/bottom-tab-bar`
- 仅 **规划 / 我的** 两页挂载
- `wx.redirectTo` 切换，避免栈堆积
- `planning` 为全屏聊天，**不显示 Tab**

```
[规划 Tab] ←→ [我的 Tab]
      ↓ navigateTo
 [planning 聊天页]  ← 侧栏 + 遮罩关闭
      ↓ 侧栏右上角 +
 [规划 Tab]（保存会话，不清记录）
```

---

## planning 页顶栏 / 侧栏（当前 UI）

### 顶栏（`navigationStyle: custom`）

- **左**：☰ 打开侧栏
- **中**：单行标题（如「昆明旅行规划」），**无副标题**
- **右**：无按钮（预留 `navPaddingRight` 避胶囊）

### 侧栏（`components/session-sidebar`）

- **右上圆形 +** → `onGoToPlan()`：持久化会话 → 跳转规划页
- **已移除**：「+ 新建规划」按钮、原 › 返回
- 点击遮罩 → **仅关闭侧栏**，留在聊天页
- 支持搜索、切换会话、长按删除
- 最多 **5 个** openTab（`session-store.MAX_OPEN_TABS`）

---

## 组件

| 组件 | 路径 | 说明 |
|------|------|------|
| bottom-tab-bar | `components/bottom-tab-bar/` | 底部双 Tab（规划 / 我的） |
| session-sidebar | `components/session-sidebar/` | 历史会话侧栏 |
| day-card | `components/day-card/` | 单日行程卡片 |
| new-session-sheet | `components/new-session-sheet/` | 新建会话弹层（较少用） |
| ask-panel | `components/ask-panel/` | 占位，提问已迁到 planning 底部输入栏 |

---

## 工具层 `utils/`

| 文件 | 职责 |
|------|------|
| `api.js` | REST + 登录；dev `http://{DEV_LAN_HOST}:{DEV_SERVICE_PORT}`，prod 占位 `api.example.com` |
| `stream.js` | SSE 流式（`enableChunked` + `onChunkReceived`，真机 iOS/Android 兼容） |
| `session-store.js` | 会话本地存储 + 远端同步，远端失败降级本地 |
| `plan-json.js` | **主路径**：行程 JSON 归一化、unwrap、流 buffer 解析 |
| `parser.js` | Markdown/纯文本行程解析（**当前未被引用**，保留作备用） |
| `safe-area.js` | 状态栏 / 胶囊 / 底部安全区 |
| `logger.js` | 调试日志（对齐服务端 plan 完成格式） |

**会话状态**：`created → planning → waiting_answer → done / interrupted`

---

## 后端 API 一览（`utils/api.js`）

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/auth/login` | `wx.login` code 换 token |
| POST | `/plan` | 流式规划（SSE，由 `stream.js` 调用） |
| GET | `/plan/result` | 拉取最终结构化行程 |
| GET | `/ask-query` | 轮询待回答追问 |
| POST | `/user-input` | 提交用户回答 |
| POST/GET/PATCH/DELETE | `/sessions` | 会话 CRUD |
| GET | `/sessions/:id/sync` | 轻量会话同步（失败时降级 getSession） |
| GET | `/sessions/:id/messages` | 会话消息（format=ui） |
| GET | `/users/me` | 用户资料与统计 |
| GET/POST/DELETE | `/favorites` | 收藏路线 |

认证：`Authorization: Bearer {token}`；401 自动 `refreshToken()` 重试。

---

## 核心业务流程

```
index 填表 → planning（createSession + POST /plan 流式）
         → 轮询 /ask-query + 用户回复（/user-input）
         → day-card 逐条渲染行程（showPlanInChat）
         → 用户确认或继续对话（postPlanChat）
         → 增量/全量重新规划（startPlanning refresh）
         → result 页（可选，/plan/result 或 globalData）
```

### 入口参数

- `?data=...` — 新规划（JSON：query + preferences）
- `?sessionId=...` — 恢复历史会话
- **无参数时** redirect 到 index

### 会话恢复（`applySessionRecovery`）

根据 `session.status` 与 `recovery.suggestedAction` 自动：

| 动作 | 行为 |
|------|------|
| `start_plan` | 新建会话自动发起规划 |
| `answer_question` | 恢复待回答追问 |
| `resume_plan` | 展示中断 banner，支持自动/手动重连 |
| `view_result` | 渲染已有 planResult |

### 断线重连

- 指数退避：2s → 4s → … → 最大 60s，最多 8 次
- `awaitingReply` 时不展示中断条（SSE 断开但后端仍等 user-input）
- 网络恢复（`wx.onNetworkStatusChange`）自动触发 `onRetry`

### 规划后对话（`postPlanChat`）

- 确认类回复（「好的」「满意」等）→ 结束轮询，友好收尾
- 调整类回复 → `startPlanning(..., { incremental: true, refresh: true })`
- 重新规划关键词 → `incremental: false, redesign: true`

### 持久化

- `onHide` / `persistActiveSession()` → `session-store`
- 运行时状态缓存在 `_runtime[sessionId]`（msgSeq、stream 标志等）

---

## 设计 Token（`app.wxss`）

```css
--primary: #030213;
--primary-fg: #ffffff;
--bg: #ffffff;
--muted: #ececf0;
--text: #030213;
--text-secondary: #717182;
--border: rgba(0,0,0,0.1);
--input-bg: #f3f3f5;
```

- `index` / `mine` 背景：蓝紫粉渐变
- `mine` 顶区：indigo → purple → pink 渐变

---

## 「我的」页要点（`pages/mine`）

- 顶部：头像 + 昵称 + 三列统计（规划次数 / 累计天数 / 收藏数）
- **已移除**右上角 ⚙（设置在下方面板，点击 toast「开发中」）
- 历史方案 / 收藏路线：左图右文 stretch 等高
- 点击历史 → `navigateTo planning?sessionId=...`
- 本地数据来自 `session-store`；登录后拉取 `/users/me` + `/favorites`
- 未登录时 `onShow` 弹窗引导微信登录；打开历史会话也可选「仅看本地」

---

## 配置与环境

```javascript
// app.js globalData
{
  ENV: 'dev',
  DEV_LAN_HOST: 'localhost',   // 真机调试改局域网 IP
  DEV_SERVICE_PORT: 8081,
  token, openId, userId,
  planResult, preferences, query,
  activeSessionId, streamingText, currentTraceId
}
```

- `api.js` 默认 fallback host：`192.168.1.100:8081`（当 globalData 不可用时）
- `project.config.json`：`urlCheck: false`
- 无 `package.json`
- 图片资源：
  - 已有：`tab-plan.svg`、`tab-plan-active.svg`、`tab-mine.svg`、`tab-mine-active.svg`、`icon-send.svg`
  - **缺失**：`/images/banner-travel.jpg`（index 引用，需自行补充）

---

## 目录结构

```
app.json / app.js / app.wxss
pages/
  index/          # 规划表单 + Tab
  mine/           # 我的 + Tab
  planning/       # 聊天核心（planning.js 最重）
  result/         # 独立结果页
  sessions/       # redirect 兼容
components/
  bottom-tab-bar/
  session-sidebar/
  day-card/
  new-session-sheet/
  ask-panel/
utils/
  api.js
  stream.js
  session-store.js
  plan-json.js
  parser.js
  safe-area.js
  logger.js
images/           # Tab SVG + send 图标
```

---

## 近期改动（勿走回头路）

| 已确定 | 已废弃 / 已移除 |
|--------|----------------|
| 底部 Tab：规划 + 我的（自定义组件） | 微信原生 tabBar |
| planning 顶栏仅单行标题 | planning 顶栏 ← 和 + |
| + 仅在侧栏 header，回规划页 | 侧栏「+ 新建规划」、› 返回 |
| mine 布局多次打磨 | mine 右上角设置图标 |
| 侧栏 + 回 index | `fromTab` 参数 |
| JSON 行程走 `plan-json.js` | 流式 Markdown 走 `parser.js`（已不引用） |
| 断线重连 + 会话 recovery | 仅 toast 报错 |
| mine 收藏走 `/favorites` API | 纯本地收藏 |
| 规划后增量/全量 refresh | 仅首次规划 |

---

## 任务 → 文件对照

| 任务 | 先看 |
|------|------|
| 改 UI | Figma Make + 对应 `pages/*` / `components/*` |
| 改聊天逻辑 | `pages/planning/planning.js` |
| 改会话/历史 | `utils/session-store.js` |
| 改 API | `utils/api.js` + `app.js` 环境变量 |
| 改流式/SSE | `utils/stream.js` |
| 改行程解析 | `utils/plan-json.js` |
| 适配真机 | `utils/safe-area.js`、`initNavLayout()`、`env(safe-area-inset-bottom)` |

---

## Agent 行为约束

1. **最小改动**：只改与任务相关的文件
2. **无 npm**：不引入 npm 依赖
3. **遵循现有约定**：自定义 Tab、侧栏行为、设计 Token
4. **不要恢复已废弃项**（见上表）
5. **真机注意**：`DEV_LAN_HOST` 改局域网 IP；流式用 `stream.js` 的 chunked 方案
6. **会话持久化**：改 planning 逻辑时留意 `onHide` / `persistActiveSession()` / `applySessionRecovery`
7. **Mock 开关**：`planning.js` 顶部 `USE_MOCK = false`，调试时可临时开启
