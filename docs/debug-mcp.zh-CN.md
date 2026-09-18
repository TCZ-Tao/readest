# 调试 MCP：让 AI 看得到、也操作得了正在运行的 Readest

面向本 fork 自用的一条调试通道：把运行中的 app（窗口、阅读位置、console、窗口事件）暴露成
JSON 接口和 MCP 工具，并且提供一组动作与定位工具（开书、跳转、重载、截图、点击、按键、关窗、等就绪、
读目录、搜正文、读设置），让 AI 能自己走完「改代码 → reload → 截图 → 看结果」的
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
| `GET /logs?n=200` | 所有窗口的 console 尾巴（带 label）；可加 `since=&window=&level=&grep=` 过滤（同 `readest_logs`，但查询串不做 URL 解码） |
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
| `readest_logs` | `{n}` 默认 200，另可选 `since` / `window` / `level` / `grep` | `{entries:[{label, level, text, ts}], matched, total}` |
| `readest_events` | `{since}` 默认 0 | `{events:[{id, event, label, ts}]}` |
| `readest_settings` | `{window}` 必填 | `{global, books:[{hash, settings}]}`：该窗口**当前生效**的阅读设置 |
| `readest_toc` | `{window, hash?}`，`window` 必填 | `{book, entries:[{label, href, cfi, page?, subitems?}], truncated}` |
| `readest_search` | `{window, hash?, query, limit?, scope?, mode?, matchCase?}`，`window`/`query` 必填 | `{book, query, matches:[{cfi, chapter, excerpt}], total, truncated}`；`total` 是搜索范围内命中总数，`truncated` 表示返回数 < 总数 |

后三个也是**只读**的，但答案在窗口里（解析好的目录、活的 DOM、合并后的设置），所以和动作工具走同一条
通道（§6）：Rust 派发到指定窗口，窗口回报。

- **`readest_settings` 是「为什么长这样」的答案**：`global` 是 `settings.globalViewSettings`，
  `books[].settings` 是每本已开书 `getViewSettings(key)` 的结果——全局默认 + 本书覆盖，也就是渲染时
  真正用的那一份（主题、e-ink、字号、行高、边距、滚动/分栏、翻页动画…）。它**只给视图设置**：
  `SystemSettings` 不在其中，因为那里面有 KOSync/Readwise/S3 的凭据和 PIN 哈希。
- **`readest_toc` 的 `cfi` 是目录项自己烘好的**（`hydrateBookNav` → `bakeLocationsAndCfis`），`href` 是
  侧栏点击用的那个，两者都能直接喂给 `readest_goto`。固定版式（PDF）多一个 `page`，就是页脚那个页码。
  超过 300 项会截断并置 `truncated`。
- **`readest_search` 走 app 自己的索引搜索**（`librarySearchService` + `searchWorker`，UI 搜索的同一条
  路）：locator 是文本偏移，返回前用 `resolveSearchResultCfis` 逐节换成 CFI。代价是**首次**对一本书搜索
  会先建索引（整本逐节提取文本，之后缓存在每本书的 `search.db` 里，书没变就不再重建）——所以第一次
  慢、后面快；Rust 给这条派发的 30 秒 deadline 主要是给建索引的。`limit` 只限制返回条数，总数照算，
  `total` 因此是精确值。`scope:'section'` 只搜当前显示的节；`mode` 支持 `contains`/`whole-words`/
  `regex`/`nearby-words`（整词、正则、邻近词；邻近词至少要两个词，正则非法直接报错）；`matchCase`
  大小写敏感。整个过程不往书里画高亮，UI 里已有的搜索高亮也不动。

`readest_logs` 的四个过滤项都可选、**与关系**，用来切掉跨窗口噪音（HMR 的 `[Fast Refresh] done in 148ms`、
别人窗口的日志）：

| 过滤项 | 语义 |
| --- | --- |
| `since` | 只要 `ts` 大于它的条目（毫秒时间戳）——填上一条的 `ts` 就是「只看新的」 |
| `window` | 只要该 label 的条目 |
| `level` | **最低级别**：`log` < `info` < `warn` < `error`，`level:'warn'` 给 warn + error |
| `grep` | 条目文本包含该子串（忽略大小写） |

`entries` 是**过滤后**的尾巴（最多 `n` 条），`matched` 是过滤后总数（大于 `n` 说明被截断），
`total` 是缓冲区总量。

`readest_state` 的每个窗口带有前端每 2 秒推一次的快照：

| 字段 | 含义 |
| --- | --- |
| `label` / `title` / `url` | 窗口身份（`main` 是库窗口，`reader-0-*` 是阅读窗口） |
| `path` | 当前路由（如 `/reader?ids=<hash>`） |
| `books[]` | 本窗口打开的书：`hash`、`title`、`fraction`、`location`(CFI)、`section`（章节标题）、`page`（**页脚显示的那个页码**：固定版式按书的页数算、流式按分节页码算，与 `readest_goto` 的 `page` 完全同一口径） |
| `library[]` | 书库的 `{hash, title}` 列表——**`readest_open_book` 要的就是这里的 hash** |
| `boot` | `performance.timeOrigin`：本次文档加载的时刻，用来判断某个窗口是否真的 reload 过 |
| `ts` | 快照时间 |

阅读进度上报在 `pagehide` / `visibilitychange` 时也会推一次，所以窗口即使已经关掉，`/state` 里
仍能看到它最后一帧的位置。

## 4. 动作工具

| 工具 | 参数 | 语义 |
| --- | --- | --- |
| `readest_open_book` | `{hashes:[...]}` 必填 | 单本书且已在某个 reader 窗口打开 → 聚焦那个窗口；否则开一个新 reader 窗口。**等到窗口真的出现才返回**，并在 `window` 里给出它的 label（`focused` 时窗口本来就在 `/state` 里） |
| `readest_goto` | `{window, hash?, cfi?, page?}`，`window` 必填 | 多书窗口用 `hash` 选书；`cfi` 精确跳转（`readest_toc` / `readest_search` 给的 `cfi`/`href` 直接可用）；`page` 是 1-based 页码，**与 `readest_state` 里 `page` 同一口径**（流式书的页码是分节内的，要精确位置仍用 `cfi`） |
| `readest_reload` | `{window?}` | 重载该窗口；省略 `window` 则重载所有窗口。走 app 自己的 `beforereload` 链，先保存再重载 |
| `readest_wait` | `{window, until, hash?, timeout_ms?}`，`window`/`until` 必填 | `until:'ready'`：等这个窗口的 JS 能应答（重载后即「新文档已起来」，返回值带 `boot` 方便比对）；`until:'library-ready'`：再等书库列表加载完（reload 后截图 `main` 用这档）；`until:'book-loaded'`：等书加载完（判据与 `goto` 完全相同）；`until:'book-rendered'`：再等第一次 relocate，即第一页确实排出来了，阅读窗截图前最稳的一档 |
| `readest_close_window` | `{window}` 必填 | 走该窗口自己的关闭路径（标题栏 ✕ 那条）：先保存阅读位置、通知 `main`，再销毁窗口 |
| `readest_click` | `{window, selector?}` 或 `{window, x, y?}` | 聚焦后点击：`selector` 在窗口自己的 document 里找第一个匹配（找不到再找书内 iframe 的文档，能点到书里的脚注链接/段落），`x`/`y` 是该窗口**最近一次截图的像素坐标**（自动换算回 CSS 像素，书内 iframe 含缩放时会还原变换）。返回点了什么、在哪层文档找到的；选择器没匹配到会连同窗口里可见的可交互元素一起返回 |
| `readest_press` | `{window, key, modifiers?}` 必填 | 在窗口里按一个键，走 app 自己的快捷键层；`handled` 说明是否有快捷键接管 |
| `readest_screenshot` | `{window}` 必填；`wait_for_stable?` | 返回 MCP image content（PNG），另带一个 text part：`{sha256, bytes, width, height, cssWidth, cssHeight[, stable]}`。`wait_for_stable: true` 先等窗口 JS 应答、再连续拍到两帧完全相同才返回（约 8 秒封顶），适合 reload 后避免拍到半帧；reply 的 `stable` 说明是否真的稳定了下来 |

细节：

- **动作会自己等就绪，不用轮询重试**：`open_book` 等新窗口出现（约 2 秒）并把 label 返回；
  `goto` 在窗口内等书加载到可跳转（视图 `inited`），按页跳转还等页码出现（`pageinfo` / `section`）。
  两个等待都封顶 8 秒、小于 Rust 侧的 10 秒超时，所以「还没好」只会得到一条准确的错误，
  而不是让工具调用挂住；需要更长预算、或要等 `goto` 不管的东西，用 `readest_wait`（见下条）。
- **`readest_wait` 是内部等待的逃生口**：`timeout_ms` 由调用方给（2000–60000，默认 10000），
  Rust 侧为此给这条派发单独的 deadline（`Plan::Frontend.timeout`），不会被默认的 10 秒传输超时掐断；
  前端拿到的是「预算 − 1000ms」，所以卡住时先由前端报出具体原因（传输层的兜底比预算多 5 秒：窗口刚重载时
  动作可能几秒后才送达，这段投递延迟不该算进调用方的预算里）。三个典型用法：
  ```text
  慢书：      readest_wait {window, until:'book-loaded', timeout_ms: 60000} → readest_goto（此时不再等）
  重载后截图： readest_reload {window} → readest_wait {window, until:'library-ready' 或 'book-rendered'} → readest_screenshot
  只想等：     readest_wait {window, until:'book-loaded'}   # 拿回 book/loaded，不改变任何状态
  ```
  `until:'ready'` 之所以能代表「新文档起来了」：Rust 会每秒重发动作直到有监听器应答，所以这条命令
  能在窗口内跑起来，本身就说明新文档已经挂上监听器。
- **`click` 点得到什么、点不到什么**：选择器先搜窗口自己的 document（`document.querySelector`），再搜
  书内容所在的 iframe 文档（`view.renderer.getContents()`，滚动模式下可能有多份）；坐标点击走
  `elementFromPoint`，落在书内 iframe 里的点会减去 iframe 的位置、并按其 computed transform 还原缩放后
  在书内文档里再解析一次。命中后先 `focus` 再 `click`，和真实点击一致；这是合成事件
  （`isTrusted:false`），但 app 里没有任何地方检查 `isTrusted`（`grep isTrusted apps/readest-app/src`
  为空），所以 React 的 onClick、`<summary>` 原生展开、书内链接的内部跳转都照常响应；需要真实按下/抬起
  序列的交互（拖拽选择、画线）不覆盖。坐标换算用的是「最近一次截图」时的缩放对，截图之后窗口改了尺寸
  就先重截一张。
- **`press` 落在「真实按键会落到的地方」**：在 `document.activeElement ?? body` 上派发 keydown，所以事件路径、以及「输入框里不触发快捷键」的行为都和真人按键一致；`handled` 来自快捷键层（`useShortcuts`）调用 preventDefault。键名用 `KeyboardEvent.key`（`ArrowRight`、`Escape`、`b`…），修饰键只认 `ctrl`/`alt`/`shift`/`meta`——拼错会直接报错，而不是静默按成裸键。
- **`close_window` 就是窗口的 ✕**：前端调用 `tauriHandleClose`，走 `onCloseRequested` 那条链（`handleCloseBooks` 保存进度 → 通知 `main` → 300ms 后 destroy），所以不丢阅读位置；正因为它真的关窗口，关掉最后一个窗口可能连带结束进程和这个服务。
- **`goto` 只做「能定位」的事**：`cfi` 直接交给 `view.goTo`；`page` 复用页脚翻页输入的同一套代码
  （`getBookProgress` 的 `pageinfo`/`section` + `fractionForPage`/`clampPage`），固定版式下走
  `view.goTo(page - 1)`。目标窗口不是阅读路由、窗口里没有这本书、或这本书**加载失败**
  （`viewState.error`，与 app 自己的 `goToCfiWhenReady` 同一判据）都立刻报错，只有「确实还在加载」才等。
- **`open_book` 不会重复开书**：走 `focusExistingReaderWindow` / `showReaderWindow`，即库页点书
  的同一条路径。
- **`reload` 的验证方式**：重载前后比 `boot`。`boot` 变了就是真的换了文档，而不是「前端看起来没反应」。
- **`screenshot` 仅 Windows**：走 WebView2 的 `ICoreWebView2::CapturePreview`（`with_webview` 拿
  控制器）。WebView2 用 DirectComposition 渲染，OS 级 `PrintWindow` 只会拍到空白客户区；因此这里是
  拍 web 内容本身，窗口被遮挡也能拍，但拍不到窗口边框/标题栏。其他平台返回明确的 unsupported 错误。
  同一帧重复拍字节相同（同一渲染内容编码确定），所以 `sha256` 相等就是「界面没变」；
  `width`/`height` 是 PNG 的像素尺寸，`cssWidth`/`cssHeight` 来自该窗口前端快照的 viewport，
  两者之比就是坐标点击（`readest_click` 的 `x`/`y`）要的缩放，Rust 按窗口记住最近一次截图的这对值。
- **超时**：Rust 派发动作后等前端回报，默认最多 10 秒（截图同理）；`readest_wait` 例外，用它自己的
  `timeout_ms`。窗口没响应会超时报错，而不是把整个工具调用挂住。

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
（它返回新窗口的 label）→ `readest_goto {window, page}` → `readest_screenshot`
→ 改一行前端样式 → `readest_reload {window}` → 再 `readest_screenshot`，两张 PNG 应当不同。

实测结论（本次实现验收时跑的）：`open_book` 恰好新增 1 个窗口；`goto` 后 `fraction` 与 `location`
都变化；`reload` 后 `boot` 变化；改样式前后截图 65,777 → 52,541 字节、还原后与基线字节完全相同。

## 6. 实现机制（改代码前先读这节）

**通道**：Rust 用 `app.emit_to(label, "debug://action", {id, action})` 把动作发给指定窗口，前端
`src/services/debugReport.ts` 的 `listenForActions` 执行后 `invoke('debug_action_result', {id, result})`
回报；Rust 侧 `pending: Mutex<HashMap<id, oneshot::Sender>>` + `tokio::time::timeout` 组装结果。
`reload` 这类「会拆掉当前文档」的动作，是**先回报、再执行**（`ActionOutcome.after`），否则 IPC 会在
页面卸载时丢掉。

**三个必须记住的坑**：

1. **Tauri 的 `emit_to(label)` 只会筛掉「声明了 label」的监听器**。JS `listen()` 默认目标是
   `Any`，而 `match_any_or_filter` 对 `Any` 恒真 —— 默认监听器会收到发给**任何**窗口的事件。
   所以 `listenForActions` 必须带 `{ target: getCurrentWindow().label }`，否则一次
   `readest_open_book` 会在每个窗口各开一次。
2. **监听器只能注册一次，而守卫不能只放在模块作用域**。`initDebugReporting` 的 `initialized`
   必须在 `await` 之前同步抢占（StrictMode 双执行、Fast Refresh 重跑都会再进来一次），动作监听器
   另外用 `window.__readestDebugActionListener` 标记，因为 Fast Refresh 会重新求值整个模块。
3. **Tauri 事件是 fire-and-forget，没有监听器就被丢掉**。窗口刚创建（JS 还没挂载）或刚开始重载时
   都处于这个状态。所以 `dispatch_action` 会**每秒重发同一个 id**，直到收到回报或超时；前端
   在第一个 `await` 之前就把 id 记进 `window.__readestDebugHandledActions`，重发因此不会让
   `open_book` 开第二个窗口。

**截图的实现要点**：`CreateStreamOnHGlobal(HGLOBAL::default(), true)` 建内存流 →
`CapturePreview(PNG, stream, handler)`，完成回调在 UI 线程消息循环里触发，回调内直接读流
（同线程创建，无 COM 封送问题），再用 `tokio::sync::mpsc` 把字节送回异步侧。
`webview2-com` / `windows` crate 版本必须与 wry 对齐（当前 `webview2-com 0.38`、`windows 0.61`，
lockfile 里已有，不额外引入新依赖）。

## 7. 加一个动作工具要动哪里

1. `src-tauri/src/debug_server.rs` → `tool_catalog()` 加 schema（含 `inputSchema`）
2. 同文件 → `tool_outcome()` 分派：同步就能答的校验直接
   `ToolOutcome::Ready(error_result(..))`；要窗口执行或窗口才知道答案的用
   `ToolOutcome::Deferred(Plan::Frontend { labels, action, timeout })`（`readest_wait` /
   `readest_search` 这类自带预算的要把 `timeout` 一起给）；截图是唯一的 `Plan::Screenshot`
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
node scripts/mcp-parity.mjs <token>                # 起 app 后跑，38 项协议检查（没开书时跳过 3 项 = 35）
```

注意两个本机特性，别误判成自己的改动：

- 本 checkout 是 `core.autocrlf=true`，工作区文件全为 CRLF，而 `biome.json` 要求 LF ——
  `biome check` 会对**所有**文件报格式错（拿未改动的文件同样能复现），与本次改动无关。
- Windows 上 `pnpm tauri dev` 正常关闭退出码是 `4294967295`，属良性噪音。

## 9. 边界（明确不做的事）

- 不做**破坏性操作**：文件导入/删除、书库修改、设置写入
- `readest_settings` 只返回**视图设置**（主题/字号/布局…），不含 `SystemSettings`：那里面有同步凭据与
  PIN 哈希，调试通道不把这些吐给客户端
- `readest_search` 走 UI 的索引搜索路径但**不画任何高亮**；UI 里已经打开的搜索结果和高亮不受影响
- `readest_click` / `readest_press` 是通用的 UI 驱动：delete、remove 这类入口（包括二次确认）也在可达范围内，工具不判断点的是什么，调用方自己负责。上一条限制约束的是工具自己主动做的事（比如没有「删书」工具），不是这条通道能碰到什么
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
| 某动作 10 秒超时 | 目标窗口没响应：窗口已销毁、前端抛错、或页面加载失败。事件每秒重发一次，所以刚创建/刚重载的窗口不会因此丢动作 |
| `timed out after 8000ms waiting for ...` | 前端等 `goto`/`open_book` 的封顶时间还不就绪：书一直没加载完（可能加载失败），或窗口始终没出现。等更久请先 `readest_wait {timeout_ms}` |
| `timed out after <你的 timeout_ms>ms waiting for ...` | `readest_wait` 自己到点了；`timeout_ms` 越大等得越久（上限 60000） |
| `readest_search` 30 秒超时 | 多半是首次对这本书搜索：要先逐节提取整本建索引，书越大越慢（之后走缓存，明显快）。仍超时就换更可能出现在正文里的词，或先用 `readest_toc` 把范围缩到某一章再按 `cfi` 跳过去 |
| `book <hash> is not open in this window` / `... is not a reader route` | 目标窗口确实不是阅读窗口（比如 `main`），或没开这本书（多书窗口请带 `hash`）——立刻返回，不是「还没好」。`readest_toc` / `readest_search` / `readest_settings` 有同样的报错 |
| `book ... failed to load` | 这本书加载失败（`viewState.error`），与 app 自己的就绪判据一致，不会白等 8 秒 |
| 一个动作在多个窗口各执行一次 | 监听器被重复注册或没做窗口限定，见 §6 |
| 截图报 unsupported | 非 Windows 平台 |
| 开了开关但 `/state` 里没有某个窗口的快照 | 该窗口的前端还没跑 `initDebugReporting`，或窗口刚创建还没推送 |
