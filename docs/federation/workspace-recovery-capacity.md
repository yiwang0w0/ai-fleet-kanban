# 工作区中断恢复与产物容量

seven-module/H10 已实现工作区超时封存和产物容量查询；归档回收仍待实现，不能把容量可见当作容量已回收。

节点常驻启动、开放监听前扫描当前节点与当前代次的 provisioning 记录。预留超过十分钟时改为 failed，记 WORKSPACE_PROVISION_EXPIRED 和 failed_preserved 事件，原目录全部保留。十分钟是准备权限到期策略，不是已确认进程死亡；没有停止证明的运行仍不能 retain。扫描与审计处于同一事务，重复扫描不产生重复事件。

已到期的复制进程即使随后完成，也不能发布 ready 回执或事件。新记录与旧代次历史不自动改动。运行期间可由本机操作员执行：

```powershell
node cli/workspace.mjs recover-stale --db "C:\FleetPrivate\board.db"
```

旧报告认为换代历史占满新池，当前代码未复现该路径：配额已经按 pool_id 统计，池登记绑定代次且新池需要新 ID，旧池不可直接续用。本次没有为未经证实的问题更改计数规则，也没有删除历史池或目录。

```powershell
node cli/artifact.mjs capacity --db "C:\FleetPrivate\board.db"
```

capacity 以只读数据库连接返回 limit_bytes、used_bytes、remaining_bytes、reserved_payload_bytes、metadata_bytes 和 reserved_transfers。artifactState 也返回同一 storage 对象。计算包含所有代次的预留与清单，未完成上传也预留完整声明容量；256 MiB 边界不放宽。容量字段只在本地返回，peer 分块进度协议不增加字段。

这是逻辑预留，不是 SQLite 文件或物理磁盘大小。当前尚无归档释放，超限继续拒收。证据见 [本批记录](workspace-source-evidence.json)。
