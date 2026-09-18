# 调试 MCP：让 AI 看得到、也操作得了正在运行的 Readest

面向本 fork 自用的一条调试通道：把运行中的 app（窗口、阅读位置、console、窗口事件）暴露成
JSON 接口和 MCP 工具，并且提供 4 个动作工具，让 AI 能自己走完「改代码 → reload → 截图 → 看结果」的
循环，不用每步都找人工确认。

**只在桌面 debug 构建里存在**：`debug_server` 模块由 `debug_assertions + desktop` 门控，release
构建里连代码都不会编译进去，也不占端口。

## 1. 开启与连接

**设置 → 杂项 → 开发者 → 「MCP Debug Server」**，开关持久化为 `settings.json` 的
`debugMcpEnabled`（本机已开）。开启后立刻监听 `127.0.0.1:9339`（`READEST_DEBUG_PORT` 可覆盖），
关闭后端口立即释放。

- 每个请求都要 `Authorization: Bearer <token>`
- token 首次生成后写入 `%APPDATA%\com.bilingify.readest\debug-mcp-token`，所以客户端配一次长期有效；
  设置面板里会直接给出可粘贴的客户端配置
- 同时写发现文件 `%LOCALAPPDATA%\com.bilingify.readest\logs\debug-mcp.json`（`{port, token, pid}`），
  供进程外工具自动发现
- 客户端配置（HTTP 型，无需任何 wrapper 进程）：

```json
{
  "type": "http",
  "url": "http://127.0.0.1:9339/mcp",
  "headers": { "Authorization": "Bearer <token>" }
}
```

## 2. 端点

| 端点 | 作用 |
| --- | --- |
| `GET /health` | pid、uptime、版本；也用来验证 token |
| `GET /state` | 窗口列表（label/title/url）、每个 reader 窗口打开的书（由 `?ids=` 解析）、每个窗口的前端快照 |
| `GET /logs?n=200` | 所有窗口的 console 尾巴（带 label） |
| `GET /events?since=0` | 窗口生命周期事件（focused/blurred/close_requested/destroyed），带自增 id，可增量拉 |
| `POST /mcp` | MCP Streamable HTTP：`initialize`、`notifications/initialized`、`tools/list`、`tools/call` |
| `GET /mcp` | `text/event-stream` 保活流 |
| `DELETE /mcp` | 结束会话 |

会话用 `Mcp-Session-Id` 头维持，和官方 SDK 客户端一致（`apps/readest-app/scripts/mcp-parity.mjs`
就是纯 `fetch` 手写的协议校验脚本，不引依赖）。

## 3. 只读工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `readest_state` | 无 | `{windows:[...]}`，见下表 |
| `readest_logs` | `{n}` 默认 200 | `{entries:[{label, level, text, ts}]}` |
| `readest_events` | `{since}` 默认 0 | `{events:[{id, event, label, ts}]}` |

`readest_state` 的每个窗口带有前端每 2 秒推一次的快照：

| 字段 | 含义 |
| --- | --- |
| `label` / `title` / `url` | 窗口身份（`main` 是库窗口，`reader-0-*` 是阅读窗口） |
| `path` | 当前路由（如 `/reader?ids=<hash>`） |
| `books[]` | 本窗口打开的书：`hash`、`title`、`fraction`、`location`(CFI)、`section`、`page` |
| `library[]` | 书库的 `{hash, title}` 列表——**`readest_open_book` 要的就是这里的 hash** |
| `boot` | `performance.timeOrigin`：本次文档加载的时刻，用来判断某个窗口是否真的 reload 过 |
| `ts` | 快照时间 |

阅读进度上报在 `pagehide` / `visibilitychange` 时也会推一次，所以窗口即使已经关掉，`/state` 里
仍能看到它最后一帧的位置。

## 4. 动作工具

| 工具 | 参数 | 语义 |
| --- | --- | --- |
| `readest_open_book` | `{hashes:[...]}` 必填 | 单本书且已在某个 reader 窗口打开 → 聚焦那个窗口；否则开一个新 reader 窗口。窗口是异步出现的，开完要轮询 `readest_state` |
| `readest_goto` | `{window, hash?, cfi?, page?}`，`window` 必填 | 多书窗口用 `hash` 选书；`cfi` 精确跳转；`page` 是 1-based 页码，**固定版式（PDF/CBZ）用 `section` 口径（页脚显示的那个页码），流式书用 `pageinfo` 口径** |
| `readest_reload` | `{window?}` | 重载该窗口；省略 `window` 则重载所有窗口。走 app 自己的 `beforereload` 链，先保存再重载 |
| `readest_screenshot` | `{window}` 必填 | 返回 MCP image content（PNG） |

细节：

- **`goto` 只做「能定位」的事**：`cfi` 直接交给 `view.goTo`；`page` 复用页脚翻页输入的同一套代码
  （`getBookProgress` 的 `pageinfo`/`section` + `fractionForPage`/`clampPage`），固定版式下走
  `view.goTo(page - 1)`。书还没加载出页码时明确报 `this book has no page count yet`，
  视图还没注册时报 `book ... is still loading in this window`——这两种都表示「等一下再试」，不是失败。
- **`open_book` 不会重复开书**：走 `focusExistingReaderWindow` / `showReaderWindow`，即库页点书
  的同一条路径。
- **`reload` 的验证方式**：重载前后比 `boot`。`boot` 变了就是真的换了文档，而不是「前端看起来没反应」。
- **`screenshot` 仅 Windows**：走 WebView2 的 `ICoreWebView2::CapturePreview`（`with_webview` 拿
  控制器）。WebView2 用 DirectComposition 渲染，OS 级 `PrintWindow` 只会拍到空白客户区；因此这里是
  拍 web 内容本身，窗口被遮挡也能拍，但拍不到窗口边框/标题栏。其他平台返回明确的 unsupported 错误。
- **超时**：Rust 派发动作后等前端回报，最多 10 秒（截图同理）。窗口没响应会超时报错，而不是把整个
  工具调用挂住。

## 5. 一次完整的调试循环（已实测）

```bash
# 1. 起 app（debug 构建；设置里 MCP 开关为开）
cd apps/readest-app && pnpm tauri dev
# 2. 拿到 token
TOKEN=$(cat "$APPDATA/com.bilingify.readest/debug-mcp-token")
# 3. 协议自检（initialize/tools/list/各错误路径/截图）
node scripts/mcp-parity.mjs "$TOKEN"
```

然后用任意 MCP 客户端（或 curl）：`readest_state` 拿 `library[].hash` → `readest_open_book`
→ 轮询 `readest_state` 等 `reader-0-*` 出现 → `readest_goto {window, page}` → `readest_screenshot`
→ 改一行前端样式 → `readest_reload {window}` → 再 `readest_screenshot`，两张 PNG 应当不同。

实测结论（本次实现验收时跑的）：`open_book` 恰好新增 1 个窗口；`goto` 后 `fraction` 与 `location`
都变化；`reload` 后 `boot` 变化；改样式前后截图 65,777 → 52,541 字节、还原后与基线字节完全相同。

## 6. 实现机制（改代码前先读这节）

**通道**：Rust 用 `app.emit_to(label, "debug://action", {id, action})` 把动作发给指定窗口，前端
`src/services/debugReport.ts` 的 `listenForActions` 执行后 `invoke('debug_action_result', {id, result})`
回报；Rust 侧 `pending: Mutex<HashMap<id, oneshot::Sender>>` + `tokio::time::timeout` 组装结果。
`reload` 这类「会拆掉当前文档」的动作，是**先回报、再执行**（`ActionOutcome.after`），否则 IPC 会在
页面卸载时丢掉。

**两个必须记住的坑**：

1. **Tauri 的 `emit_to(label)` 只会筛掉「声明了 label」的监听器**。JS `listen()` 默认目标是
   `Any`，而 `match_any_or_filter` 对 `Any` 恒真 —— 默认监听器会收到发给**任何**窗口的事件。
   所以 `listenForActions` 必须带 `{ target: getCurrentWindow().label }`，否则一次
   `readest_open_book` 会在每个窗口各开一次。
2. **监听器只能注册一次，而守卫不能只放在模块作用域**。`initDebugReporting` 的 `initialized`
   必须在 `await` 之前同步抢占（StrictMode 双执行、Fast Refresh 重跑都会再进来一次），动作监听器
   另外用 `window.__readestDebugActionListener` 标记，因为 Fast Refresh 会重新求值整个模块。

**截图的实现要点**：`CreateStreamOnHGlobal(HGLOBAL::default(), true)` 建内存流 →
`CapturePreview(PNG, stream, handler)`，完成回调在 UI 线程消息循环里触发，回调内直接读流
（同线程创建，无 COM 封送问题），再用 `tokio::sync::mpsc` 把字节送回异步侧。
`webview2-com` / `windows` crate 版本必须与 wry 对齐（当前 `webview2-com 0.38`、`windows 0.61`，
lockfile 里已有，不额外引入新依赖）。

## 7. 加一个动作工具要动哪里

1. `src-tauri/src/debug_server.rs` → `tool_catalog()` 加 schema（含 `inputSchema`）
2. 同文件 → `tool_outcome()` 分派；同步校验用 `Plan::Error`，需要前端执行用 `Plan::Action`/`Deferred`
3. `src/services/debugReport.ts` → `DebugAction` 联合类型加分支，在 `runDebugAction` 里实现
4. 若新增 IPC 命令（例如「窗口自己上报结果」之外的交互）：`src-tauri/src/lib.rs` 的
   `invoke_handler`、`src-tauri/build.rs` 的 commands 列表、`src-tauri/capabilities/default.json`
   的 `allow-*` 权限，三处都要加
5. 文档：本文档的表格 + `apps/readest-app/docs/testing.md` 的英文小节

## 8. 自查

```bash
cd apps/readest-app
cargo test -p Readest --lib debug_server          # 协议层单测（tools/list、错误路径、Deferred 派发）
pnpm fmt:check && pnpm clippy:check                # Rust 格式与 lint
npx tsc --noEmit                                   # 前端类型
node scripts/mcp-parity.mjs <token>                # 起 app 后跑，18 项协议检查
```

注意两个本机特性，别误判成自己的改动：

- 本 checkout 是 `core.autocrlf=true`，工作区文件全为 CRLF，而 `biome.json` 要求 LF ——
  `biome check` 会对**所有**文件报格式错（拿未改动的文件同样能复现），与本次改动无关。
- Windows 上 `pnpm tauri dev` 正常关闭退出码是 `4294967295`，属良性噪音。

## 9. 边界（明确不做的事）

- 不做**破坏性操作**：文件导入/删除、书库修改、设置写入
- 不做**多步编排**：一次调用只做一件事，串起来由 AI 自己决定
- **Android 不支持**：该 fork 的另一目标平台没有桌面窗口模型，本期不覆盖
- iOS / macOS / Linux 不在本 fork 范围（截图在非 Windows 上直接返回不支持）
- 安全边界：只绑 `127.0.0.1`，必须带 token，且只存在于 debug 构建。token 文件等同本机凭据，
  不要提交或外传；这个通道能操作 UI，换机器或换项目时先确认开关状态

## 10. 排错

| 现象 | 原因 |
| --- | --- |
| 连不上 9339 | 设置开关没开；release 构建没有该模块；`READEST_DEBUG_PORT` 改过端口 |
| 401 | token 不对（以 token 文件里的为准；设置面板显示的是一样的值） |
| 某动作 10 秒超时 | 目标窗口没响应：窗口已销毁、前端抛错、或页面正在加载/卸载 |
| `book ... is still loading` / `no page count yet` | 书还没加载完，等一下重试（不是 bug） |
| `no book is open in this window` | 目标窗口确实没开这本书（多书窗口请带 `hash`） |
| 一个动作在多个窗口各执行一次 | 监听器被重复注册或没做窗口限定，见 §6 |
| 截图报 unsupported | 非 Windows 平台 |
| 开了开关但 `/state` 里没有某个窗口的快照 | 该窗口的前端还没跑 `initDebugReporting`，或窗口刚创建还没推送 |
