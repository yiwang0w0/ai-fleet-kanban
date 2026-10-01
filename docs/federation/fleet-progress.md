# 阶段进度与外部确认记录

全局面板的「阶段进度与确认记录」读取管理者明确登记的计划文件和外部确认记录，计算当前有效的任务/阶段验收比例。它不把看板卡片的 done 状态、实现证据数量或测试通过直接当成阶段验收，也不向任务数据库导入规划清单。

本机进度来源通过 `BOARD_PROGRESS_CONFIG` 显式启用；未配置时保持关闭。`GET /api/fleet/progress` 使用现有操作员凭据和来源检查，支持 `?project=项目`。worker/review 令牌不能读取；普通 MCP、页面和此 CLI 均没有写入阶段确认的入口。返回内容不包含配置路径、验证输入路径或凭据。

## 登记与信任边界

管理者先核对实际独立审阅及必要的操作者确认，再把回执文件的**精确字节 SHA-256** 登记在配置中。`registered_by`、`confirmations.instance_id` 和引用是管理者录入的外部确认记录，不是密码学签名或自动认证的真人身份。管理者必须核对原始审阅来源，不能只把实现者生成的建议改为 accepted。登记配置和原始回执应位于执行代理不可写的管理目录；本功能不新建或改变 Windows ACL，OS 隔离仍需部署验收。

配置按项目列出计划及每个阶段的确认策略。`required_roles` 是该阶段冻结的确认角色，不能用实现身份代替。`implementer_ids` 应包含该阶段的全部实现身份；通过回执的登记者和各确认身份都不能在此清单内。计划要求操作者确认时，额外需要 OP 记录。身份真实性由管理者登记流程保障；如果管理者错误登记或其配置被篡改，本功能不能替代独立审阅。

最小配置示例（路径需替换为实际管理目录；不是自动部署指令）：

```json
{
  "format": "ai-fleet-progress/v1",
  "plans": [{
    "project_id": "demo",
    "manifest_file": "C:/BoardAdmin/demo/plan.json",
    "phases": [{
      "phase_id": "S00",
      "required_roles": ["ARCH", "REVIEW"],
      "implementer_ids": ["implementation-agent"],
      "inputs": [
        {"id": "protocol-source", "path": "C:/BoardCode/core/protocol.mjs"},
        {"id": "test-evidence", "path": "C:/BoardAdmin/demo/evidence.json"},
        {"id": "role-policy", "path": "C:/BoardAdmin/demo/role-policy.json"}
      ],
      "receipts": []
    }]
  }]
}
```

每个计划阶段必须恰有一个策略；示例只展示单阶段计划。现有 72 项清单需要 S00–S11 的完整策略。验证输入应覆盖该阶段会使验收失效的源码、协议、角色权限、关键配置和证据。遗漏输入会导致无法检测该项变化，因此输入范围本身必须在阶段确认时审阅。输入使用原始字节摘要；可登记单独的确定性范围清单，避免把无关文档变化扩大为全项目失效。

## 待签回执与读取

```powershell
node cli/progress.mjs --config C:/BoardAdmin/progress.json
node cli/progress.mjs --config C:/BoardAdmin/progress.json --plan AFK-FED-001 --phase S01
```

第一条只读输出当前进度；第二条只输出绑定当前合同摘要的 pending 草稿。可用 PowerShell 重定向保存草稿，但命令不会自动登记、签收或修改文件。草稿格式如下：

```json
{
  "format": "ai-fleet-phase-receipt/v1",
  "plan_id": "AFK-FED-001",
  "phase_id": "S01",
  "gate_id": "G01",
  "contract_sha256": "以 CLI 当前输出为准",
  "decision": "pending",
  "accepted_task_ids": [],
  "confirmations": [],
  "evidence_refs": [],
  "note": "待独立审阅与必要的操作者确认",
  "verified_at": null
}
```

通过回执使用 `decision: accepted`，列明实际验收的本阶段任务、非空证据引用、说明和 ISO 时间。每条确认须包含 `role`、`instance_id`、`decision: approve`、`at`、`reference`；所需角色必须齐全。`reference` 是供核对的原始审阅/操作者决定引用，作为文字展示，不自动打开链接或读取路径。没有批准的任务不得填入 accepted_task_ids。

外部流程完成后，管理者对已核对的文件计算摘要，在相应阶段的 receipts 末尾登记：

```json
{
  "path": "C:/BoardAdmin/demo/receipts/G01-001.json",
  "sha256": "文件原始字节的 64 位小写 SHA-256",
  "registered_by": "local-operator",
  "registered_at": "2026-10-01T06:00:00.000Z"
}
```

数组顺序就是管理者登记顺序；最后一条决定当前状态，所有已登记项仍显示在历史中。后续 pending/rejected、损坏或摘要不匹配的记录不会退回采用先前的通过记录。撤回确认应追加新的 pending/rejected 回执，不覆盖旧文件。旧 G01/G02/G05 草稿可作为历史登记，但始终只显示 pending，不能计入通过。

## 计算与失效

- 任务只有在最新回执当前有效、明确列入 accepted_task_ids、独立角色和必要 OP 确认齐全、前置门禁通过、所依赖任务已验收且当前未标记阻塞时，才计入任务验收比例。
- 阶段只有本阶段全部任务验收且最新回执有效，才计入阶段验收比例。部分任务通过不会把阶段显示为通过。
- 当前合同摘要覆盖本阶段任务标准/依赖/证据要求、阶段门禁/操作者要求、相关需求、全局决策、平台范围、确认角色和实现身份、登记输入字节摘要，以及前置阶段的合同摘要。相关变化使原记录显示「旧确认已失效」，并影响依赖阶段；无关阶段保留有效确认。
- 显示状态、实现证据条数、普通验证进展及计划版本标签本身不改变合同摘要；计划版本仅作识别，真正的合同内容决定有效性。管理员必须及时登记实际合同与受影响输入，不能只更新一个版本号来表达未记录的合同变更。
- `blocked` 任务显示 `blocker.reason`、`release_condition`、`responsible_role`、`next_review_at`；缺项明确显示待填写，不能因此计入完成。`implemented_pending_acceptance`、verifying 和没有有效回执的 accepted 声明都显示待验收。
- 页面分列实现证据、验证记录、阻塞与待验收，按阶段展开外部确认及失效原因。默认折叠，支持原生键盘展开；不依赖公网资源。

每次读取使用有界文件读取与请求内缓存，不写数据库、不消费模型额度。配置上限 128 KiB、单计划 2 MiB、单输入 4 MiB、单回执 256 KiB，整次读取合计不超过 16 MiB；每计划最多 100 阶段/10,000 任务，每阶段最多 64 输入/128 历史记录。缺文件、超限、重复归属、循环依赖或坏格式会报告不可用/无效，不展示伪造的 100%。

这是本机管理者登记的阶段投影。它不声称外部确认由本机代码认证，也不自动同步阶段配置到其他电脑。实体桌面客户端、跨电脑确认文件分发与 Windows 管理目录权限仍需单独验收；正式 AFK-FED-001 回执本批仍未签收。
