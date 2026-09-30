# Zcode Windows 接入记录

当前安装版本为 0.16.9，代码包 zcode.cjs 的 SHA256 为 fad4c35c4c36ec210d8a06d3fa0e77de23c8545e2eb6ff90aea1eb38d1e6275f。以下区分安装源码、实际无账号探测和合成流测试；尚未形成 Zcode 可执行调度适配，也没有调用真实模型。

## 两种接口的差别

app-server --stdio 使用 `{id,method,params}` / `{id,result}` 或 `{id,error}` 的自身 NDJSON 协议。实际 runtime/capabilities 返回 independentPlanState=true；session/create 返回 ZCode Protocol v1 的空会话。第一轮错误地带上 jsonrpc 字段，请求被拒绝并超时；修正后进程正常退出，Windows Job 已清空。两个探测均没有提交 session/send。

安装源码显示 app-server 的账号由桌面宿主的 provider/updateAccountConfig 提供；仅改变用户目录不能自动复用桌面登录。普通 --prompt 路径则通过 standalone provider registry 使用常规共享登录仓，并支持 --output-format stream-json。此参数在该版本帮助中未列出，使用前必须固定安装摘要，不能套用于任意升级版本。

单次命令输出先给出映射后的 session events，最后附一个独立的 type=result 摘要；它没有 resultType，单独收到摘要不能判定成功。已增加独立 headless-stream 解码合同；原有 session-events 合同与 RPC inputId 绑定保持。

## 结果合同

调用方必须给出 zcodeTransport=headless-stream、expectedPromptSha256、expectedProvider 和 expectedModel；不能同时提供 RPC 的预期 session/input ID。首次 turn.started 的输入必须与提示摘要完全匹配，随后固定 session、turn、trace。连续事件序列不能重放、跳号或复用 ID。

模型请求元数据须属于同一 turn，并匹配指定 providerId/modelId；至少观察到包含 messageCount、toolCount、iteration 的主任务请求。成功需要明确 resultType=success、非空 response，以及匹配身份和正文的最终摘要。摘要 eventCount 不是整个 observer 的回调计数，因此不假设二者相等。usage 未完成真实映射，保留 null。

控制任务、后台任务、续接/steer、第二轮任务、多 turnResponses、错模型、未知终态、缺少摘要、非零退出和中断均不能成功。成功回执仍 real_model_call_confirmed=false；这是解析结果，不是账单或真实调用证明。解析器也不是请求前的模型权限屏障，供应商内部模型回退仍须由启动配置限制。

目前不支持通过 headless-stream 证明完整实际工具清单；传入 expectedTools 或 expectedMcpServer 会明确拒绝。prepareAdapter 仍不开放 Zcode，避免把事件解码完成误报成完整执行器已就绪。

## 实际无账号探测

探测把 HOME、USERPROFILE、CLI 配置、存储、会话 DB 和 ZCODE_DATA_BASE_DIR 全部放在新的私有目录，使用安装包的公开 provider 配置，个人 provider 配置为空。未读取、复制或解密现有 credentials.json。插件、skills、subagent、memory、hooks 和 MCP 在探测配置中关闭。

--prompt /model --mode plan --output-format stream-json 在模型创建阶段产生 turn.failed，然后退出 1；错误码为 CONFIGURATION_ERROR，阶段为 model_creation。该探测没有可用模型或账号，没有到达模型请求。/model 因而不能作为带真实账号的零调用预检。外层探测宿主退出 0 只表示收集完成，不能把子进程退出 1 改写为成功。

app-server 空会话曾请求 mode=plan，但 snapshot 的 mode.current 与 permission.mode 均显示 build。因此没有据此证明 plan 已生效。全部探测最后由 Windows Job 确认 job_empty；它证明进程清理，不证明文件系统沙箱。

## 启动适配的剩余条件

- 复用中国版 Coding Plan 的常规登录路径，隔离运行配置、日志和会话数据；不提取或传播账号令牌。
- 固定当前 provider 与具体模型。安装源码的默认模型选择在不可用时可能回退首个可用模型，不能仅设置 defaultModelSelection 就声称模型已固定。
- GLM 的 reasoningLevel 为 disabled/enabled；与看板角色档位的映射需要明确合同。
- 核验实际 MCP 初始化、原生工具禁用、插件及项目配置合并、Windows 权限边界。CLI 的 disallowed-tools 是整个工具名过滤，不是 shell 命令模式过滤。
- 固定 Node、安装 bundle、公共配置及生成文件摘要，经一次性许可启动，保持失败占额度、不可自动重试。完成这些条件后再执行已授权的一个最小真实任务。

目前三种供应商调用均为 0/1，完整阶段验收 0/12。此后只安排 Windows 实现、CI、部署和两台 kanata 的 Tailscale 联调。

官方产品登录说明见 [账号与模型配置](https://zcode.z.ai/cn/docs/configuration)，MCP 产品说明见 [MCP 服务](https://zcode.z.ai/cn/docs/mcp-services)。具体 CLI transport 和字段依据上述固定安装包及本机探测；产品页面不能替代 CLI 合同验收。
