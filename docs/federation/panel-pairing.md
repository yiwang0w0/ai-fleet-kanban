# 本机面板配对与读取认证（seven-module/H2）

匿名访问现在只提供配对页面、静态配对脚本、健康检查和 worker 协议版本。HTML 不再包含 operator/worker/review 令牌；任务、节点身份、上下文、历史与 SSE 均需 X-Board-Token。

## 使用

1. 在看板所在的电脑上，进入看板目录运行 `node cli/open.mjs`（v0.24；`npm run open` 是同一个命令）。它用数据目录里的操作员令牌向本机看板要一个一次性配对码，打开 `http://127.0.0.1:<端口>/#pair=<配对码>`，页面自动连上。也可以在“连接本机看板”输入框填这个 6 位配对码，或者照旧粘贴 `board_token` 文件里的操作员令牌。
2. 服务通过 `/api/auth` 确认 operator 身份后才加载看板数据。worker/review 令牌不能配对管理面板，也不能发配对码；它们原有的 CLI 读取与写入角色权限保留。
3. 点击“退出连接”撤销这个浏览器的面板凭据，清除它保存的内容并重新加载空配对页。其他已打开的标签页需分别退出。`node cli/open.mjs --forget-browsers` 撤销所有浏览器的面板凭据。

配对码：同一时刻只有一个；6 位数字，10 分钟内有效，用一次即失效，猜错 5 次作废，需要重新运行 `node cli/open.mjs`。换码请求（`POST /api/pair`）不带令牌，只接受允许来源的页面发起；别的网站的页面连尝试的机会都没有。本机进程可以伪造 Origin，但仍需在 5 次之内猜中配对码（10^6 分之 5）。配对码只出现在命令的输出、浏览器的启动参数和历史记录里，页面打开时先把它从地址栏删掉（`history.replaceState`），再在请求正文里提交一次；用过就失效。

换到的是**面板凭据**，不是 `board_token`：每个浏览器一个，操作员权限，签发 30 天后失效（再运行一次 `node cli/open.mjs`），退出连接即撤销；看板只在数据目录的 `panel_sessions.json` 里存它们的 sha256，这份列表本身打不开任何东西，看板重启后照样有效。主令牌只留在数据目录，供 CLI 和 worker 使用；手动粘贴的主令牌仍然可用，但退出连接撤销不了它。

“在这台电脑上记住”默认勾选：面板凭据存进当前来源的 localStorage，关掉浏览器再打开不用重新配对；取消勾选则只存在当前标签页的 sessionStorage，且不会清掉别的标签页记住的凭据。凭据不进 URL 或 Cookie；每次打开页面都会重新向服务核验，看板正在重启或暂时连不上时会重试，只有看板明确拒绝（401/403）才丢弃。存储不可用时仅保留在当前页面内存，刷新需重新配对。

剩余风险：浏览器记住的东西属于 `http://127.0.0.1:<端口>` 这个来源，而不是看板进程。和其他系统用户共用的电脑上，有人能在看板停止时占用这个端口、在同一地址提供页面，读走浏览器记住的面板凭据。这种电脑上请取消勾选“记住”，用完点“退出连接”；怀疑泄露时运行 `node cli/open.mjs --forget-browsers`。该机制仍依赖同源脚本与本机凭据文件的信任边界，不能代替 XSS 审阅或操作系统隔离。

所有面板 API 请求及 SSE fetch 流由同一个认证客户端附加请求头，拒绝跨来源目标和 HTTP 重定向。401 清除本标签页凭据并回到配对页，写请求不自动重放。SSE 按原 change/log 事件推送刷新；断流后重连，保留未知事件名及分段 Unicode/多行数据。

## 接口与兼容

| 请求 | 匿名行为 | 已认证行为 |
|---|---|---|
| GET /、/panel.html、/panel-auth.js | 提供无凭据的静态配对页面/脚本 | 同一静态内容 |
| GET /health | 仅健康状态与端口 | 相同 |
| GET /api/meta | 仅 worker_protocol_version | 保留原节点、标签、计数等字段；错误令牌返回 401 |
| GET /api/auth | 401 | 仅 operator 返回身份确认；worker/review 为 403 |
| POST /api/pair/code | 401 | 仅 operator 发一次性配对码；worker/review 为 403 |
| POST /api/pair | 允许来源的页面用配对码换一个面板凭据；无 Origin 或其他来源为 403，码无效、过期或已用为 401 | 同匿名 |
| POST /api/pair/revoke | 401 | operator：撤销自己这个面板凭据，`{"all":true}` 撤销全部；worker/review 为 403 |
| 任务、历史、上下文、SSE 及其他操作接口 | 401 | 原角色写权限与 fleet 的 operator 限制继续生效 |

worker/reviewer/board CLI 已在读请求中携带各自令牌。`watchers/sse_watch.py` 现在也从 BOARD_DATA_DIR 下读取 board_token；缺失时明确失败，重新连接会重新读取凭据。现有外部只读脚本若依赖匿名任务接口，需要改为显式认证。

配置 BOARD_EXTRA_ORIGINS 会出现明确警告；允许来源不能替代认证。页面带有按实际内联脚本内容生成的 CSP 哈希、禁止框架嵌入、nosniff 与 no-referrer。管理面板仍只监听回环，联邦访问应使用独立 peer 网关。

## 验证与交付边界

[证据清单](panel-auth-evidence.json)绑定产品/测试源码摘要及私有原始日志摘要。最终 5 项 HTTP 断言在 f10f268 上得到预期的 4 失败/1 正常 SSE 对照；修改后 5 项及 3 项客户端行为测试全部通过。

受影响原有回归去重 61 个外层测试（server、fleet view、版本、run fence、timeline、sentry）及新增 8 项均通过，合计 69。server 的 195、timeline 的 23、sentry 的 5 个内部断言已分别包含于一个外层文件测试，不能再叠加。初轮 fleet 的匿名未知路由期望404与新认证边界冲突，补凭据后仍断言404；VM夹具最初缺 AbortController，补齐浏览器环境后通过。原失败日志保留。

真实 Chrome 无头浏览器通过：匿名页面不拉取操作数据、worker 配对拒绝、operator 配对、刷新重新认证、实际 SSE 触发任务更新、全局视图、退出后凭据与旧视图清除；无页面脚本或 CSP 错误。首轮全局任务标题定位器遗漏嵌套元数据，改为标题节点定位后完整流程通过，产品行为未因此放宽。

复跑前将 PYTHON 和 BOARD_PYTHON 指向本机已核验的 Python 可执行文件。一次补跑遗漏该环境而出现 ENOENT，使用已核验入口后通过，未安装或更改环境。

复跑：

```powershell
node --test tests/panelauth.test.mjs tests/panelclient.test.mjs
node --test tests/servertest.mjs tests/fleetviewtest.mjs tests/versiontest.mjs tests/runfencetest.mjs tests/tltest.mjs tests/sentrytest.mjs
```

Windows CI 与 npm test 已纳入认证测试。旧基线对照可在独立 shell 设置 BOARD_AUTH_TEST_ROOT 为干净 f10f268 checkout 后，只运行 panelauth.test.mjs；该对照预期失败，不属于交付绿灯。

本批只修改开发分支，没有重启生产看板、恢复已撤销的转发或启用 peer，没有真实模型调用。H2 的代码与本机行为已修复；其他七模块问题继续保留。G01/G02/G05 仍是固定旧基线的 pending 草稿，正式验收仍 0/72、0/12。本批新增独立文档与证据，不覆盖并行进行的主机名/订阅信息文档清理。
