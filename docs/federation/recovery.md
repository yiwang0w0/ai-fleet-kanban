# 节点退役与恢复副本激活

本批提供源端恢复工具：检查隔离副本、生成可核对计划、停用原数据库写入身份，以及在明确的退役声明下轮换恢复副本 epoch。激活不启动服务、执行器或自动放行任务。

对端接纳新 epoch 的显式计划与项目快照切换见 source-recovery.md。普通同步仍拒绝未经接纳的 epoch 变化。真实设备唯一写者、旧进程停止和跨机恢复验收尚未完成。

## 先明确两种证据

retire 命令能证明本次数据库事务已提交：任务写入被阻止、在途 run 已结束、对端凭据已撤销。已打开的 SQLite 连接和已准备的语句也受触发器约束。

它不证明操作系统里的所有 agent 进程已终止，不阻止这些进程继续向数据库之外的文件写入，也不能仅凭 UUID 判断另一台克隆机器已停机。退役回执明确保留 process_termination=not_verified 与 physical_single_writer=not_verified。进程及文件权限隔离继续在 S04/S07 完成。

激活需要操作者对原服务、原执行器、旧身份和其他恢复副本作明确声明，并附可核对的停机证据引用。程序校验声明格式和它绑定的计划，不替操作者证明物理事实；最终回执标为 operator_attested_not_machine_verified。自动化测试使用临时夹具声明，不作为真实设备退役证明。

## 原节点退役

先停止原节点服务和 agent，保存最后结果与备份，核对当前 epoch。所有路径均需显式指定，不使用部署目录默认值。

~~~text
node cli/recovery.mjs status --db <原数据库绝对路径>
node cli/recovery.mjs retire --db <原数据库绝对路径> --expected-epoch <刚核对的epoch> --receipt-file <新回执绝对路径>
~~~

命令检查 epoch 后在一个事务内：存档原任务行、结束在途运行、清空任务 run_id、取消放行、撤销活跃对端凭据，并把本机生命周期设为 retired。未完成状态为 in_progress 的卡转 waiting/decision；其他业务状态保留。每张卡追加恢复审计事件，历史 task_runs 保留。

tasks、task_events、task_runs 的 SQL 触发器阻止退役后的 INSERT/UPDATE/DELETE，包括旧进程已打开的连接。正常 store.open、独立 peer 网关和凭据接口也拒绝 retired。只读 status 与备份仍可使用；没有自动取消退役的命令。不要手工改生命周期或删除触发器。

回执先持久保存在数据库，提交后输出 JSON，再尝试写指定新文件。若文件已存在或不可写，数据库仍已退役，CLI 会明确说明；用 status 取回数据库中的回执，不能把退出码理解为事务自动撤销。

## 核验恢复副本并生成计划

先使用 backup.md 的 restore 命令恢复到新目录，保留 board_restore_hold。旧备份缺少节点身份、运行记录或任务版本时，在 restore 时显式加 --upgrade-schema；该开关在新副本中原子迁移后才签发恢复文件回执，已有备份及旧隔离目录均不改写。新版恢复回执增加证据路径、大小和 SHA-256 清单。没有此清单的旧恢复目录需要从已验证备份重新恢复，不自动补造证据。

~~~text
node cli/recovery.mjs prepare --db <恢复目录/board.db> --plan-file <新计划文件绝对路径>
~~~

prepare 检查恢复回执、数据库文件摘要、SQLite 完整性、节点身份、隔离标记，以及每份证据文件的路径、大小与摘要。拒绝不完整目录、路径联接/符号链接、错配回执和证据变化。它不解除隔离，不改业务任务状态。

计划绑定数据库真实路径、plan_id、node_id、备份 epoch、拟停用 epoch、backup_id、恢复回执摘要、任务/运行/共享/凭据计数和 state_digest。state_digest 在同一读事务中覆盖应用表结构与行内容，也能发现仅存在 WAL 中的变更。计划本身带 plan_digest 供操作者核对。

默认拟停用 epoch 等于备份 epoch。若使用的是更早一代备份，且原节点已经经历过其他恢复，应从实际设备/对端记录核对当前待停用 epoch，再显式指定 --retired-epoch；不能凭旧备份猜测当前写入者。

## 明确声明后激活

下面是声明模板。四项布尔值默认 false，只有实际完成对应操作后才能填写 true。evidence_ref 应指向真实停机/隔离回执；不要填模型声称、时间推测或“网络离线”。这份 JSON 是操作者声明，不是签名或自动物理设备认证。

~~~json
{
  "format": "ai-fleet-retirement-attestation/v1",
  "node_id": "<计划中的node_id>",
  "retired_epoch": "<计划中的retired_epoch>",
  "plan_digest": "<核对过的plan_digest>",
  "original_board_stopped": false,
  "original_agents_stopped": false,
  "original_identity_disabled": false,
  "other_restored_writers_stopped": false,
  "evidence_ref": "<真实停机及旧身份停用证据引用>",
  "attested_at": "<实际核对时间的ISO格式>"
}
~~~

~~~text
node cli/recovery.mjs activate --db <恢复目录/board.db> --plan-file <已核对计划> --plan-digest <已核对摘要> --attestation-file <真实声明绝对路径> --receipt-file <新回执绝对路径>
~~~

activate 再次检查证据与回执，在写事务内重新计算状态摘要；计划被编辑、WAL 中存在新写入或节点/隔离标记不匹配都拒绝。文件与 SQLite 没有跨资源原子事务，证据文件校验完成后仍需保持恢复目录隔离，不宣称已实现文件系统级锁定。

事务内保持隔离，完成以下操作后才移除 hold：

- 生成新 sync_epoch，保留 node_id、task_uid、owner_node_id、数字卡号与历史运行记录。
- 清空所有任务的旧 run_id，结束在途运行，取消所有任务放行。在途卡进入 waiting/decision，保留结果及其他业务字段。
- 撤销复制进来的活跃对端凭据并递增版本，保留凭据变更审计。
- 把原任务行及本机旧发布流、确认游标、快照缓存等存入仅本地的 board_recovery_archive，再清空这些旧发送状态。保留已有共享选择，将所有登记共享记录重新标为待发布。
- 新一代发布使用新 event_id、新 epoch 与从 1 开始的 seq；旧事件不会换内容重用身份。
- 恢复身份及 outbox 删除保护触发器，保存激活回执，最后移除 hold。

任一步异常或提交前进程退出都会回滚；恢复副本保持隔离。成功后 services_started=false、tasks_released=0。人工决定后续重新执行时仍须通过现有状态、版本、无进展及预算规则，恢复命令不会静默使用 force。

旧 peer 凭据不能继续用，旧结果即使来自同名 worker 也不能写入新 run。双向通信需重新签发各方向凭据。对端需按 source-recovery.md 完成新 epoch 的显式接纳与授权快照切换。回执的 peer_reauthorization_required 与 peer_epoch_acceptance_required 均为 true。

## 验证与运维边界

14 项测试覆盖准备不解除隔离、数据/证据/计划篡改、WAL 变化、最终步骤失败、真实子进程提交前退出及重试、跨进程旧写语句拒绝、旧凭据/旧 run 失效、新事件身份、退役节点备份恢复，以及独立 CLI 的计划和激活流程。

完整原数据和旧发送内容保存在数据库本地档案中，可能包含私密正文，应按备份同等级保护，不提交 Git，也不作为自动共享事件导出。物理磁盘回收、档案保留期、丢失任务的对端核对、现场 RPO/RTO 和整个 G05/G09 验收仍在后续阶段。


恢复 schema 升级不等于激活。prepare 对完成迁移的副本仍只读，计划绑定迁移后数据库状态与整个恢复回执；activate 仍在同一事务内轮换 epoch、结束旧运行、撤销凭据并保留任务未放行。无效或撤销后的 peer 凭据先返回 UNAUTHENTICATED，不向匿名请求泄露节点退役状态。
