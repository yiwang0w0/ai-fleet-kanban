# T01.05 / T08.05 独立签收材料

本包绑定 `864feec033f4be38c929ae2d29cf683fb266516d`（0.24.0），对应 [CI #149](https://github.com/yiwang0w0/ai-fleet-kanban/actions/runs/37258132393)。回执草稿均为 `pending`。实现者整理材料，不填写独立审阅者身份、不注册通过回执。

## T01.05：备份与隔离恢复

| 验收条件 | 当前证据和定位 | 独立审阅时应确认 |
|---|---|---|
| 运行中数据库使用一致性备份 | CI 的 backuptest；`live WAL snapshot...` 与 `snapshot during another process writing...` | 并发写入时，已提交任务与事件不被拆散 |
| 恢复后任务、事件及证据索引可校验 | backuptest / recoverytest / resulttest / completiontest；[封存恢复证据](../sealed-restore-evidence.json) | 普通任务、候选封存与完成封存的证据路径重定位均保留内容、版本、审计和封存约束 |
| 恢复副本不连接生产 peers | `restore is isolated...`、`backup snapshots and incomplete copies...`；recoverytest 的显式激活/失效凭据用例 | 恢复副本在明确审阅激活前保持隔离；失败不留下可执行的半成品 |

此前 f10f268 的 H5a 失败保留在历史草稿中；修复后的当前 CI 与当时的失败是不同证据。[T01.05 草稿](T01.05.review-draft.json) 留出实际独立审阅结论。

## T08.05：只统计有效验收

| 验收条件 | 当前证据和定位 | 独立审阅时应确认 |
|---|---|---|
| 仅 accepted 任务计入完成度 | CI fleetprogresstest：`plan status or test claims cannot accept tasks`、`partial external acceptance...` | 清单里的“已实现”或“测试通过”不能冒充签收，先决门禁未过不能提前计数 |
| 阻塞、待验收单列 | `blocked tasks show actionable fields...`；[进度证据](../fleet-progress-evidence.json) | 阻塞原因和解除条件可见；本项目仍显示 0/72、0/12 |
| 修改合同后旧门禁失效可见 | `changed acceptance contract...`、`registered code or authority inputs...` | 只使受影响门禁及依赖失效，保留历史，不影响无关门禁 |

该 suite 同时覆盖自签、缺少角色、修改回执文件及跨项目读取的拒绝路径。历史浏览器截图保留原测量 SHA，不能表示在当前候选重新做过桌面验收。[T08.05 草稿](T08.05.review-draft.json) 不导入生产验收登记簿。

## 签收方式

1. 核对候选 SHA、CI 结果和 [证据索引](../acceptance-candidate-evidence.json)。先复用已有结果，只对尚有疑问的条件做定向复现，不要求再跑全仓。
2. 由非实现者写实际审阅身份、时间、证据引用及发现；不预填通过。若拒绝，明确失败条件与重验范围。
3. 通过后按 [进度回执规程](../fleet-progress.md) 生成当前配置绑定的回执并由授权角色登记。这里的 review-draft 是审阅输入，不是可直接导入的正式回执。

实体双机、实际桌面与供应商、活动合同恢复协调及 72 小时观察仍分别验收。这里不要求重复已经收到的 B 机预检；B 的初始化 node-receipt 仍待取得。
