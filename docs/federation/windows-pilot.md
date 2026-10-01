# 两台 Windows kanata 的隔离试点准备

当前这份记录是 G03 的准备材料，不是网络已启用或双机已验收的回执。两台设备均已取得 Windows 预检，Node/SQLite/Git 可用，Tailscale 稳定 ID 不同；同名主机不能代替身份核对。第二台预检由用户返回，其初始化 node-receipt.json 仍待取得。

## 固定来源与目录

首轮试点统一使用已通过完整 Windows CI #116 的 `fea7378bfbef422cfdbfee10688fa21e6b04e026`（0.24.0）。它是初次联调基线，不包含之后新增的面板结案和阶段进度功能。后续升级应在两个节点都核对源码、配置和回执后进行，不能让一端跟随开发分支自动前进。

A 的试点 source 已改为独立 detached Git worktree，固定上述提交；config.repo 和 node-receipt.source_path 均指向它。原配置及回执在私有目录中保留。调整前后 node_id、sync_epoch 和数据库原始文件 SHA-256 相同；没有启动网关、同步或执行器。桌面工作区工具连接关闭，检查现有工作区后使用本地 Git fallback 创建；该试点工作区仍在使用，不能随开发工作区清理。

B 已发送的 prepare-node.ps1 默认创建 `%LOCALAPPDATA%/AiFleetKanban/pilot-20261001/source` 固定副本、独立 data 及空执行线路。该脚本的返回不是桌面 MCP 安装或服务启动证明。B 回执必须核对实际源码 SHA、source_path、board_identity、配置摘要及 Tailscale 稳定 ID。缺失 B 看板 UUID/epoch 时不生成对 B 的凭据，也不把 Tailscale ID 填到看板 UUID 字段。

本机私有材料在开发工作区 `.data/physical-pilot-20261001/`：`node-A/source-repin-receipt.json`、`node-A/source-repin-before.json`、`network-observation.json`、`serve-before-A.json` 和 `G03-network-draft.json`。这些文件包含实际网络名/路径，保持忽略，不发布到仓库。

## 待确认的端点与权限

| 入口 | 拟定监听/用途 | 网络范围 |
|---|---|---|
| 操作员界面 | 127.0.0.1:47924 | 各机本地，不代理到 tailnet |
| 独立 peer API | 127.0.0.1:47925 | 只给本机 Tailscale Serve 代理 |
| 试点 HTTPS | 各机 MagicDNS 名称的 47925 端口 | tailnet 访问规则加独立应用凭据 |
| 已有 A 转发 | 47824 → 127.0.0.1:47824 | 原有配置保留，不并入本次试点 |

本机于记录时未发现 47924/47925/47926 的 TCP 监听；这只描述当时 A 的端口状态，启动前及 B 端仍需复核。A 的 Tailscale 1.102.2、Serve 帮助与当前配置已实读，MagicDNS 已开启。B 当前在线可见不代表它的端口、Serve 或 HTTPS 配置已经核实。

拟定项目为 `kanata-pilot`，不共享其他项目。第一步双向各签一份用于访问签发方的凭据，只含 `peer:handshake`、`peer:health`、`sync:pull`、`sync:ack`，先验证互信、授权投影和重连补发。后续委派、关系登记、取消、交付及结案按完整访问矩阵升级独立凭据版本；第一步同步通过不等于完整协作验收。

应用身份始终绑定看板 UUID、epoch、凭据版本和项目范围，不能依赖 Tailscale 转发的姓名/IP 作为授权。凭据不写入日志、聊天或 Markdown；传给对端后要确认其目标账户文件 ACL，再使用 credential-file。源端签发时的保护不等于复制后的权限仍然正确。

私有草案已列出两台实际 MagicDNS HTTPS 端点、IPv4、A 看板身份、分阶段 scopes 和关闭命令；B 看板身份、B 原有 Serve 配置/端口、有效 tailnet 规则、HTTPS 前提及传递凭据的方法仍有明确空缺。因此 decision 保持 pending，未请求最终启用确认。

Serve 的 HTTPS 代理需要 tailnet HTTPS 前提，现有访问规则同样生效；未启用时 CLI 可能要求网页确认。不能把 MagicDNS 可用等同于 HTTPS 已启用，也不能用新增一条窄 allow 规则声称较宽旧规则已失效。[Tailscale Serve 官方说明](https://tailscale.com/docs/features/tailscale-serve)。

## 补齐回执后的启用顺序

1. 核对两份 node-receipt、源码 SHA、各自身份/epoch、配置摘要；再次确认当前来源确实是冻结副本。保存两端现有 Serve 配置和端口观察。
2. 补齐精确项目/凭据权限、现有 tailnet 规则影响及凭据交接路径，将完整差异和关闭步骤提交首次启用决定。已有同范围明确授权沿用，不重复申请；当前材料不足以宣称 G03 已批准。
3. 在各节点的固定来源上运行既有 peer CLI，本机监听 127.0.0.1:47925。数据库路径取自该节点已核对的 pilot_root/data/board.db；不使用当前目录默认数据库。
4. 签发两份独立凭据并通过已确认方式传递，执行本地认证负向检查，再启用下述独立 Serve 入口。若新端口已经存在配置或基线发生变化，先保留现场并核对，不覆盖旧条目。
5. 经私网 HTTPS 做双方 hello/health、错误凭据和越权项目检查；双方授权身份、协议版本与项目范围必须相符，再执行已授权的同步试验。记录实际直连/中继路径；不能用 Tailscale 在线状态代替握手结果。
6. 此轮不配置全局桌面 MCP、不启动模型执行器或常驻自启动。它们按后续具体配置和剩余调用额度推进，不因 peer 互信通过自动放行。

仅在上述具体启用范围确认后使用，以下是待执行命令：

```powershell
# $sourcePath、$dbPath 来自本机已核对的冻结节点回执
& 'C:\Program Files\nodejs\node.exe' (Join-Path $sourcePath 'cli\peer.mjs') serve --db $dbPath --host 127.0.0.1 --port 47925
```

独立终端中的 Tailscale 入口：

```powershell
& 'C:\Program Files\Tailscale\tailscale.exe' serve --bg --https=47925 http://127.0.0.1:47925
```

实际启用后需保存状态并比对：只有获准的 47925 条目新增，旧 47824 和其他条目保持原状；本次没有 Funnel 请求。远端入口仅代理 peer 网关，不能误填 47924 或操作员页面端口。

## 精确回滚

先关闭本次端口，再停止已记录的试点进程：

```powershell
& 'C:\Program Files\Tailscale\tailscale.exe' serve --bg --https=47925 off
```

`off` 沿用启用时的 flags；不执行全局 `serve reset`。[Tailscale Serve 关闭说明](https://tailscale.com/docs/reference/tailscale-cli/serve)。然后核对试点进程的程序、参数与创建时间，只停止对应 peer/sync 进程，不能按 node.exe 名称批量结束。读取当前 peer 凭据版本后仅撤销试点对端，保留数据库、任务、事件和审计文件。

最后比较剩余 Serve 配置与启用前快照；如果期间另有合法变更，保留那些变更，不整体覆写旧快照。未执行本次启用时，不运行这些关闭命令冒充回滚演练。

当前证据边界：A 来源固定和文件/身份一致性已核对；Tailscale 只读状态已记录。真实双方握手、访问矩阵、断线继续与重连、撤销传播、桌面 MCP 和完整任务闭环均尚未验收。
