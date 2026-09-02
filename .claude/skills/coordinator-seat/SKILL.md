---
name: coordinator-seat
description: 部署看板的那个对话自动担任协调席(主对话):后续改线、停线、查状态、起草线路都在这里说。含继任与冲突规则。The conversation that deployed the board holds the coordinator seat; includes succession and collision rules.
---

# 协调席(coordinator-seat)

**部署完成的那个对话,就是这块板的主对话。**操作者不需要再找别的入口:
改线、停线、查上下文、查额度、起草线路,直接在这里说。

## 何时就任

- 你刚完成部署(`node core/server.mjs` 起来、`/health` 绿、面板地址已交给操作者),或
- 操作者说「你来管看板 / 接管看板」。

## 就任动作(三步)

1. 向操作者声明一句:
   「看板由本对话担任协调席——改线、停线、查状态直接在这里说。」
2. 挂两哨:`watchers/sse_watch.py` + `watchers/board_health_watch.py`
   (挂法见 `docs/OPERATE_WITH_CLAUDE.md` §二)。
3. 可选:提议一次线路起草——「要不要我根据你近期的工作起草自动拉取线?
   需要你授权我读取近期会话」(流程走 `propose-lines` skill,授权没拿到就不动)。

## 职责映射(全部走既有 skill 与入口)

| 操作者说 | 走哪条路 |
|---|---|
| 加一条线 / 调整线 | `add-line` skill |
| 上下文还剩多少 | `context-window` skill |
| 额度 / 池状态 | `pool-quota` skill |
| 根据我的工作建线 | `propose-lines` skill(先拿授权) |
| 裁定 / human_gate / handoff 执行 | **永远是操作者本人的**——你只提醒、只转述,不代行 |

## 继任规则(对话会死,席位不会)

席位没有任何状态存在对话里——卡、事件、配置、账本全在看板(SQLite + 根配置文件)。
本对话被压缩或关闭后,操作者在本仓库新开一个对话说「接管看板」即完成继任:
新对话读板即得全部状态,**不存在也不需要旧对话的交接仪式**。

## 冲突规则

- 就任前若有理由怀疑已有别的对话在任(另一个窗口、另一台机器),先问操作者一句。
- **双席同时做治理动作(停线、改配置、重启 server)是事故源**;
  worker 领卡交付不受此限(那本来就是多方并发的)。

## 护栏

- 席位 ≠ 特权:协调席也走 `cli/board.py` 与既有端点,不因在任就绕闸门。
- 闸门拒绝(exit 3)照样是功能不是 bug;席位的职责是向操作者解释它,不是修掉它。
