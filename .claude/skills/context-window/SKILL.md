---
name: context-window
description: 查看各线会话的上下文窗口占用,判断是否需要整理(compact)。Check per-line session context usage; when (not) to compact.
---

# 上下文窗口查看(context-window)

操作者问「上下文还剩多少 / 哪条线快满了 / 要不要整理」时用本 skill。
数据源只有一个:`GET /api/context`(面板「上下文」区同源同数)。

## 读取

```bash
python -c "import json,os,urllib.request; base=os.environ.get('BOARD_URL') or ('http://127.0.0.1:'+os.environ.get('BOARD_PORT','47824')); print(json.dumps(json.load(urllib.request.urlopen(base+'/api/context')), ensure_ascii=False, indent=1))"
```

返回 `lines[]`:每条被监管线的会话 token 累计与消息数。没有持续会话的线不在其中。
向操作者回报时报数字(X tok / 上限,N 条消息),不要只说「还够」。

## 整理(compact)——默认不做

- **整理会改写提示词前缀 → 提示缓存变冷 → 下一次调用显著变贵。**
  实测结论(见 `loops/worker_loop.py` 内的记账注释):缓存热时长上下文便宜,
  贵的是冷掉的前缀。所以整理不是保养,是有代价的手术。
- 只在两个条件同时成立时整理:①窗口临近上限 ②这条线接下来还要继续长跑。
- 正道是面板「上下文」区的整理按钮(它带鉴权、发事件、落记录)。
- 对没有持续会话的线整理会得到 400「没有持续会话可整理」——这是正常回答,不是故障。

## 护栏

- 本 skill 是只读为主;**不要把 compact 做成定时任务或自动触发**(典型的过度开发,
  且会持续把缓存弄冷)。
- 不要直接读写 `core/.data/` 里的会话文件。
- 想要更细的上下文指标(逐消息、逐工具)= 开发需求,先向操作者说明,不要加端点。
