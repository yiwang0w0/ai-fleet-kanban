# 0.24.0 协议兼容矩阵

此表为 T02.05 的支持范围材料，绑定独立审阅候选 `864feec033f4be38c929ae2d29cf683fb266516d`。协议与存储版本彼此独立；不能根据 package 版本相同就推定能力、凭据或数据库兼容。本表不发布版本，也不批准混合写入。

| 对象/输入 | 支持行为 | 拒绝或限制 | 原有验证入口 |
|---|---|---|---|
| Peer 协议 min/max 与本机 `[1,1]` 有交集 | 选择共同协议 1；再核对身份、epoch、授权 scope 与必需能力 | 对端仅支持 2 或更高时 `PROTOCOL_INCOMPATIBLE` | peertest 的协商与不兼容输入断言 |
| 必需能力与必需扩展 | 每个声明的必需项必须受支持 | 未知项 `REQUIRED_FEATURE_UNSUPPORTED`；不能降级为可选 | peertest 的 required_capabilities / required_extensions 负向断言 |
| 可选 extensions 对象 | 未知可选数据可忽略，不增加权限 | 已知层级的未知顶级/必需字段仍拒绝；超限也拒绝 | peertest 的 optional extension 与未知字段断言 |
| 节点身份与 epoch | 与已登记凭据一致才参与握手 | 伪造 node_id/epoch 拒绝；协议版本不能替代身份校验 | peertest 的 IDENTITY_MISMATCH 断言 |
| 本机 worker 领取与回报 | 按当前 worker 协议及原 run_id 处理 | 旧协议领取拒绝；旧 run/其他任务 run 不可回报；不自动更新旧意图 | runfencetest；[迁移说明](migration-0.24.md) |
| 本地存储升级 | 仅执行对应组件支持的显式迁移，保留身份、历史与回滚/隔离证据 | 未知 federation schema 拒绝；混合旧/新写入者不受支持 | identitytest / peertest / recoverytest；[迁移说明](migration-0.24.md) |
| 新增业务能力 | 节点必须具备该业务声明的能力，例如取消闭环 | 不能仅因握手协议仍是 1 就让旧节点执行新业务 | [取消闭环迁移](migration-0.24.md) |

来源：`core/federation/protocol.mjs` 的 `PROTOCOL`、`keys`、`negotiateHello` 和 `tests/peertest.mjs` 的实际断言；对应 CI #149 通过。查看 [逐项待审材料](gates/acceptance-readiness.json) 中固定 Git blob 的摘要及行号。真实跨版本双机升级/回退属于 T09.05，仍待其独立验收，不能由此矩阵替代。
