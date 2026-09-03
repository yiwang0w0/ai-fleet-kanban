---
name: propose-lines
description: 经操作者当轮明示授权后,只读检索其近期会话学习工作形态,访谈式起草自动拉取线,确认后写入 fleet.config.json。With explicit per-invocation authorization, mine recent session transcripts (read-only) to draft worker lines, interview the user, then write the config.
---

# 线路起草(propose-lines)

操作者说「根据我平时的工作建线 / 帮我起草线路 / 你看看我最近都在干什么」时用本 skill。
另一个天然时机:**首次把真实工作批量搬上板**(会话考古建卡、导入待办清单)——
建卡前先提议定线,否则真实卡会默默堆进演示线 `alpha`/`coord`(实测发生过)。
产出 = 一份经操作者逐条确认的 `lines[]`,落盘走 `add-line` 的流程。

## 铁则:授权先行

读取其他会话 = 读取操作者的隐私。**本 skill 绝不自动触发**;
即使操作者叫到了它,动手前也要复述范围拿一次明确同意:

> 「我将只读检索你最近 X 天会话的标题与相关片段,用于起草线路,内容不外发。可以吗?」

拿不到明确的「可以」,跳到第 3 步(纯访谈),不碰任何会话数据。

**面板快捷指令例外**:请求来自面板按钮(`request.created` kind=`propose-lines`,
`params.authorized=true`,`params.days`=范围)时,按钮标题本身写明了「点击=授权只读
检索」——那一下点击就是操作者当轮的明示授权,不必再问;范围以 `params.days` 为准,
结束时照常报账读了什么。

## 步骤

1. **探测工具**:会话管理工具(Claude Code 桌面版的
   `mcp__ccd_session_mgmt__list_sessions` / `search_session_transcripts`,或所在环境的同类工具)。
   环境里没有 → 直接第 3 步。**工具不可用不是失败,别为此安装东西或写代码。**
2. **只读挖掘**:先 `list_sessions` 看标题/分组/工作目录做粗聚类;
   需要细节再按工作词检索转录。
   **只读**——不向其他会话发消息提问:那会打扰在飞的工作、消耗对方上下文,
   且二手转述不如下一步直接问操作者本人。
3. **访谈**:把聚出的候选线摆给操作者(≤5 条,每条 `id`+`hint`+一句依据),逐条问:
   留 / 合并 / 删 / 改名?哪些线需要 handoff 目录(人工落盘交付物)?
4. **落盘**:确认稿按 `add-line` skill 的流程写入 `fleet.config.json`
   (一次写全 `lines[]`,重启 server,`python cli/board.py lines` 验证)。

## 护栏

- **挖掘结论 = 假设**;访谈确认前一个字节都不写盘。
- `hint` 写工作类型,**不得把会话里的敏感内容(客户名、密钥、内部代号)抄进配置**——
  配置文件长期存在,还可能被截图或分享。
- **读了什么要报账**:结束时告诉操作者实际读取了哪些会话的标题/片段。
- 候选线宁少勿多:线是承接工作的槽位,不是工作日志的分类学;
  两条线能覆盖就不要五条。
