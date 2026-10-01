# 一致性备份与隔离恢复

本工具保存看板数据库和证据文件，支持运行中备份；恢复只写入新目录。副本保留原节点身份，因此备份本体和恢复副本均禁止作为可执行看板启动，节点重新入网与激活属于后续恢复流程。

## 命令

使用与目标看板相同的 `BOARD_DB`、`BOARD_DATA_DIR`：

~~~powershell
npm run backup -- create "D:/BoardBackups/backup-20260929"
npm run backup -- verify "D:/BoardBackups/backup-20260929"
npm run backup -- restore "D:/BoardBackups/backup-20260929" "D:/BoardRestore/drill-20260929"
~~~

目标必须是尚不存在的新目录，父目录应已存在。备份不能放进源数据库或证据目录内；恢复不能覆盖已有目录或放入备份目录内。备份含任务正文和交付内容，应保存在工作仓之外，不提交到 GitHub。

## 一致性与校验范围

1. 证据文件先复制，再创建 SQLite 快照，之后重新核验文件集合与内容。文件变化、引用缺失或引用越界时，备份拒绝完成。
2. 数据库使用 [SQLite VACUUM INTO](https://www.sqlite.org/lang_vacuum.html) 读取包括已提交 WAL 在内的一致性快照；不直接复制运行中的主数据库文件。
3. 快照校验 SQLite 完整性、任务/事件数量、节点身份与证据引用。文件清单保存 SHA-256 与大小，证据索引绑定数据库中的原引用。
4. 校验/恢复拒绝摘要不匹配、越界路径、Windows ADS、保留文件名、大小写冲突、符号链接和目录联接。恢复从同一文件句柄复制并计算摘要，避免先校验后复制的替换窗口。
5. 每个文件写入后刷新。只有完整清单写完才移除 `.incomplete`；中断目录保留用于诊断，不可被校验为成功或用于执行任务。

SQLite 快照具有事务一致性；数据库与外部文件没有共同事务，文件采取前后比对，未检测到变化不代表已实现跨资源原子快照。后续不可变证据存储会进一步收紧这一边界。清单摘要用于发现损坏，不是来源认证或数字签名。

## 恢复隔离

快照内的 `board_restore_hold` 以及未完成目录标记会让存储层拒绝写打开，服务在创建操作员令牌或执行器之前停止。恢复流程调整证据文件引用到新目录，任务业务内容、状态与事件保留；只读查看仍可使用。

恢复不复制令牌、worker 自动启动设置、模型凭据、运行日志、验收登记簿或本地部署配置。它是任务数据与证据恢复工具，不是完整机器镜像。迁移前后不同版本的配置及凭据恢复须另行登记。

后续第八批提供已核对计划和退役声明下的源端激活，见 [recovery.md](recovery.md)。它轮换 epoch/凭据、结束在途 run 并保持任务未放行；对端新 epoch 需按 [source-recovery.md](source-recovery.md) 显式接纳，不能手工删表后直接入网。对完成的恢复副本做再次备份仍会保持隔离。

## 验证记录

- `npm run test:backup`：活动 WAL、并发写入、CLI 往返、隔离启动防护、摘要篡改、文件变化、文件索引、路径和联接边界等 14 项测试。
- 2026-09-29 的部署数据库只读演练：11 张任务、14 条事件、1 份证据；恢复后任务与事件摘要一致，恢复隔离存在。私有备份和原始回执保存在独立工作区的忽略目录中，未提交。
- 真实多机恢复后重新入网、激活与灾难 RPO/RTO 验收仍待后续阶段完成。

## 旧数据库的显式恢复迁移

缺少 board_node、task_runs 或 aggregate_version 的历史备份，使用新增开关恢复到另一个全新目录：

```powershell
node cli/backup.mjs verify <已校验备份目录>
node cli/backup.mjs restore <已校验备份目录> <全新恢复目录> --upgrade-schema
node cli/recovery.mjs prepare --db <全新恢复目录/board.db> --plan-file <新的计划文件>
```

默认 restore 保持原 schema；prepare 如遇旧 schema，返回 SCHEMA_UPGRADE_REQUIRED 并指向上述流程。已有的隔离目录保留，不在原处修改或手工删除隔离表。

--upgrade-schema 仅修改新复制出的数据库，在恢复事务内完成证据路径调整与 store schema 迁移。已有 node_id、sync_epoch 和任务 UID 保留；尚无身份的旧库在隔离副本中初始化身份。旧 in_progress 任务转换出 imported 运行记录，供后续激活终止旧运行。任务编号、依赖和原事件记录保留。

最终 restore-receipt.json 的 database 记录迁移后的身份与计数，source_database 保留备份原摘要，schema_upgrade 记录原数据库文件摘要及身份是 initialized 或 preserved。恢复回执在迁移成功后才生成并绑定新数据库字节。原备份仍可独立 verify。

迁移失败会回滚数据库修改并保留 .incomplete；不会生成成功回执。成功迁移也保留 board_restore_hold，不启动服务、不生成操作员令牌、不放行任务。之后仍须核对恢复计划、提供真实停机声明并显式 activate；没有旧联邦身份的备份也必须确认原服务和其他副本已经停止，不能据新建 UUID 推定唯一写者。

## 已知限制：封存候选的证据路径恢复

2026-10-01 在 f10f268（0.24.0）实际复现：任务设置了 evidence_path，且其委派候选结果仍被 result_task_freeze 封存时，备份可以完成，但恢复重定位 evidence_path 的 UPDATE 会触发 RESULT_PENDING。恢复事务回滚、目录保留 .incomplete，不生成成功回执；原备份和原证据仍保留。此前普通任务的恢复演练不能覆盖此场景。见[七模块复核](seven-module-review.md)。

修复及独立验收前，该组合不能作为可用的灾难恢复路径。不要删除触发器、隔离标记或手改库绕过；保留原库、备份和失败目录供恢复实现核对。恢复激活后的目录也不可随意搬动，现有证据引用及回执绑定需要保持。
