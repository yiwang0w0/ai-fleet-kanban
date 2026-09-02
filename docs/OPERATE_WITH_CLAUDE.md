# 让你的 Claude 接管看板

前提:**你已经在用 Claude Code。**那么这块板不需要你手动安装或配置——你的 Claude
就是安装员、操作员和值哨员。你只管说话;它通过 `cli/board.py` 和 HTTP API 驱动看板。

## 一、把板交给它

> 「clone ai-fleet-kanban,把看板服务起起来,给我面板地址。」

你的 Claude 会跑 `node core/server.mjs`、确认 `/health`,然后给你
`http://127.0.0.1:47824`。面板给你的眼睛看;你的 Claude 走 API。

**部署它的这个对话,从此就是你的主对话(协调席)**:改线、停线、查状态,
直接在这里说,不用找别的入口。对话被压缩或关闭也不要紧——席位状态全在
看板里,新开一个对话说「接管看板」即完成继任(`coordinator-seat` skill)。

## 二、挂上两哨

> 「把两个哨兵挂到 persistent Monitor 下,持续盯着。」

- `watchers/sse_watch.py` —— 看板上每个事件一行(认领、交付、判决、池警报)。
  自己重连;未知事件类型也照样出行(哨兵绝不许"聋而不哑")。
- `watchers/board_health_watch.py` —— 按钟表探**状态**,因为**沉默≠健康**:
  瘫痪的板零事件,和安静健康长一个样。异常立即出声;平安约每小时报一行,
  让"安静的哨"和"死掉的哨"分得开。

你的 Claude 把两哨挂在自己的 persistent Monitor 下并对哨声做出反应——
重启一条被门拒的线是**人**的决定;把它**报给你**不是。

## 三、用说话定义你的线

你不用手写 `fleet.config.json`。把你实际的活告诉你的 Claude:

> 「我的工作分后端代码、文档、运维杂务三块。按这个建线,
> 然后把我的待办清单放上板。」

它会写好配置(线 → 路由 → 你点名要收文件的目录=handoff 目标)、重启看板、
把你的任务清单建成目标、让板拆解成可认领的卡。此后它还能**自行认领并执行**——
你的 Claude 不只是书记员,也是一名 worker。

顺手给**工作仓**装上执行约束:`examples/AGENTS.template.md` 是生产实害换来的
worker 家规(范围闸门四问=防过度工程化、pathspec 提交、密钥禁区、范围外立卡)。
让你的 Claude 把它安到工作仓根(Codex 读 `AGENTS.md`,Claude Code 读
`CLAUDE.md`)并填好方括号——约束放在 worker 眼皮底下才生效,看板仓里的 skill
管不到它。

## 三点五、随仓 skills:常用操作已经预置好了

在本仓打开 Claude Code,`.claude/skills/` 下的 skill 会被自动发现:

| skill | 覆盖的操作 | 要点 |
|---|---|---|
| `coordinator-seat` | 部署对话就任主对话(协调席) | 声明就任+挂两哨;继任=新对话说「接管看板」;双席治理=事故源 |
| `add-line` | 添加/调整自动拉取线 | 唯一入口是 `fleet.config.json` 的 `lines[]`;改完必须重启 server |
| `propose-lines` | 从你近期的会话起草线路 | **当轮明示授权才动**,只读检索+访谈确认,读了什么报账 |
| `context-window` | 查各线上下文窗口占用 | `GET /api/context`;整理(compact)有缓存变冷的代价,默认不做 |
| `pool-quota` | 查池状态与各卡 token 消耗 | `GET /api/pools` + `GET /api/usage`;池耗尽=状态不是故障,等恢复 |

它们的共同立场:**只走既有入口,不新增代码**。你的 Claude 想做的事这三条路给不了时,
skill 会让它停下来向你说明,而不是替你开发——误操作和过度开发都比少个功能贵。

## 四、哪些事永远归你

这块板是验收优先(acceptance-first)。机器自己认领、重试、交付、复审、
派生后续;**裁定、human gate、handoff 的实际执行留在你手里**。
有卡等你时,面板会把它排在「等待中」栏最上——而且你的哨兵早就告诉你的 Claude 了。
