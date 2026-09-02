---
name: pool-quota
description: 查订阅池状态与各卡 token 消耗;额度紧张时的正确动作序列。Check pool exhaustion state and per-card token usage; what to do (and not do) when quota runs low.
---

# 额度与池状态(pool-quota)

操作者问「额度还剩多少 / 池是不是耗尽了 / 哪张卡烧得多」时用本 skill。
两个只读端点,面板底栏与卡面 tok 徽章同源同数。

## 读取

池状态(耗尽标记、恢复时间、全局停派):

```bash
python -c "import json,os,urllib.request; base=os.environ.get('BOARD_URL') or ('http://127.0.0.1:'+os.environ.get('BOARD_PORT','47824')); print(json.dumps(json.load(urllib.request.urlopen(base+'/api/pools')), ensure_ascii=False, indent=1))"
```

- `pools.<runtime>.exhausted_at` 非空 = 该池已被标记耗尽;`until` = 预计恢复时刻。
- `global_stop: true` = 所有池全下,全线停派(会落 `pool_global_stop.json` 标记)。

各卡 token 消耗(输入/输出/缓存读/缓存写/调用次数,按卡累计):

```bash
python -c "import json,os,urllib.request; base=os.environ.get('BOARD_URL') or ('http://127.0.0.1:'+os.environ.get('BOARD_PORT','47824')); print(json.dumps(json.load(urllib.request.urlopen(base+'/api/usage')), ensure_ascii=False, indent=1))"
```

向操作者回报时报数字与时刻,不要只说「够 / 不够」。

## 额度紧张时的正确动作序列

1. 先停新认领:面板「自动拉取」行按停止——**不要 kill 在途进程**
   (强杀 = 卡悬空 → 打回,attempts 白烧)。
2. 在途的让它交付完,板上状态自然收敛。
3. 池耗尽是**状态,不是故障**:worker 回报限流时 server 自动标记,到期自动探活恢复。
   等它。

## 护栏

- **不要**删改 `core/.data/pool_state.json` / `pool_global_stop.json` 来「解锁」——
  标记消失不等于额度回来,只会让下一发立刻撞墙。
- **不要**写重试外挂、调小间隔硬闯限流(误操作+封号风险的双输)。
- 订阅侧的真实余量(5h 窗 / 周上限百分比)在服务商的用量页面,**看板测不到它**:
  需要时请操作者亲自查看,不要替他猜,也不要为此加爬虫或端点。
- 任何「自动续命 / 自动切池」类改造 = 开发决策,先向操作者说明再动。
