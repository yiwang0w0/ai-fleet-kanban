# 本机面板配对与读取认证（seven-module/H2）

匿名访问现在只提供配对页面、静态配对脚本、健康检查和 worker 协议版本。HTML 不再包含 operator/worker/review 令牌；任务、节点身份、上下文、历史与 SSE 均需 X-Board-Token。

## 使用

1. 在本机打开看板原有回环地址。从已配置看板数据目录的 `board_token` 文件复制操作员令牌，在“连接本机看板”输入框粘贴并连接。
2. 服务通过 `/api/auth` 确认 operator 身份后才加载看板数据。worker/review 令牌不能配对管理面板；它们原有的 CLI 读取与写入角色权限保留。
3. 点击“退出连接”清除当前标签页的凭据并重新加载空配对页。其他独立标签页需分别退出。

令牌保存在当前来源的 sessionStorage 中，页面刷新会重新向服务核验；不会放进 URL、localStorage 或 Cookie。浏览器的会话恢复行为由浏览器决定，因此需要清除时请使用退出按钮。存储不可用时仅保留在当前页面内存，刷新需重新配对。该机制仍依赖同源脚本与本机凭据文件的信任边界，不能代替 XSS 审阅或操作系统隔离。

所有面板 API 请求及 SSE fetch 流由同一个认证客户端附加请求头，拒绝跨来源目标和 HTTP 重定向。401 清除本标签页凭据并回到配对页，写请求不自动重放。SSE 按原 change/log 事件推送刷新；断流后重连，保留未知事件名及分段 Unicode/多行数据。

## 接口与兼容

| 请求 | 匿名行为 | 已认证行为 |
|---|---|---|
| GET /、/panel.html、/panel-auth.js | 提供无凭据的静态配对页面/脚本 | 同一静态内容 |
| GET /health | 仅健康状态与端口 | 相同 |
| GET /api/meta | 仅 worker_protocol_version | 保留原节点、标签、计数等字段；错误令牌返回 401 |
| GET /api/auth | 401 | 仅 operator 返回身份确认；worker/review 为 403 |
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
