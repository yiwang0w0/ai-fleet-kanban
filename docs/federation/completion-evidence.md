# 封存完成合同的两端证据复查

完成合同一旦封存，其验证回执、Git 合并意图、产物清单和操作员决定都绑定原节点代次。备份激活后，正常 `completion`、`integration`、`verification` 接口仍拒绝复用旧代次。这一只读入口为后续完成恢复提供实际证据观察，不产生新验收决定。

```powershell
node cli/completion-evidence.mjs source --db C:\private-board\board.db --id <completion-uuid> --accepted-rev C:\private-board\accepted-rev
```

只使用本机已有文件，不连接 peer、不启动验证命令或模型、不更新 Git 引用、不迁移数据库。CLI 使用只读 SQLite 连接，错误仅输出稳定代码和概述。成功观察隐藏本机路径、原验收说明与完整验证输出，只保留合同、代次、回执和状态摘要。

## 实际核对

- 本机来源完成合同、原合并配置及启动、固定验证配置及启动/终态、接收产物和结果相互匹配。
- 若本机已换代，保留的恢复链必须从原来源代次连续连接当前身份。
- 验证程序及辅助文件的固定摘要、独立验证输入的真实文件和 Git 对象仍匹配，原 Windows Job 已有完整成功退出观察。不会重新执行该验证。
- 保留的产物分块字节和整体摘要、原批准基线、实际合并提交内容与产物树、当前目标引用、目录身份和固定 Git 均重新检查。
- 原治理目录/树必须仍匹配，相关配置未撤销；复查结束再次比较元数据、代次、治理树及目标引用。

原目录或验证副本已丢失、程序更新、治理树改变、合并引用前进、配置撤销时会拒绝确认。此入口没有授权把这些情况改成通过。恢复路径迁移和重新验证策略需独立实现。

## 回执含义与边界

`retained_evidence_matches: true` 表示此次观察与原封存证据匹配。`historical_accepted` 仅说明原来是否已有一致的验收记录；`accepted`、`execution_authorized`、`automatic_release` 始终为 `false`。已验收历史和任务原状态保留，不撤销、不重新签发。

`stopped_work_verified` 和 `peer_or_registrar_recovery_verified` 仍为 `false`：此观察没有证明两端当前进程停止，也没有取得新登记代次或另一端确认。它是未签名的本机观察文件，不能代替完整完成恢复的协调与人工决定。文件和其他节点在观察后可能变化，后续提交时必须重新读取有关状态。

完整封存完成合同的恢复/结算仍待实现，普通旧代次执行和结算入口继续拒绝。测试证据见 [记录](completion-evidence-tests.json)；本机隔离测试不代表实体双机、真实桌面或真实供应商验收。


## 执行端保留证据

执行端可独立核对同一完成合同。此路径只读取 SQLite 中已封存的记录与产物字节，无需来源端的 Git/验证配置，也不运行外部命令：

```powershell
node cli/completion-evidence.mjs target --db C:\private-board\board.db --id <completion-uuid>
```

一次只读事务核对原完成合同及 ready 回执、绑定、结果、完成/结果的相同成员范围、所有保留运行的停止记录、执行结果摘要、产物清单及实际字节。已换代时必须有连续恢复链；存在历史结案时还核对原登记证明、绑定关闭和结果决定是否一致。缺失或变化的范围、停止观察或产物会拒绝确认，不能只凭 ready 回执通过。

`retained_stop_proofs_match=true` 仅指保留的停止记录与原候选一致，`process_liveness_verified=false` 表示没有探测当前进程。`changed_task_versions` 列出封存版本与当前版本的差异；恢复隔离或原结案可以合法改变版本，因此单独标记 `task_reconciliation_required`，不把当前任务等同于旧候选，也不以观察结果自动覆盖它。

输出隐藏任务正文和路径。`historical_accepted` 只读展示旧结案；`accepted`、`execution_authorized`、`automatic_release`、`peer_or_registrar_recovery_verified` 仍为 false。目标是为后续两端恢复决定提供可核对事实；完整恢复协调、当前进程停止确认和新代次结算仍待完成。

定向验证见 [执行端证据记录](completion-target-evidence-tests.json)：四个新增场景及两个直接相邻场景通过；目标执行停止记录使用合成数据，未声明真实执行器或当前进程存活验证。
