---
name: add-line
description: 给看板添加或调整一条自动拉取线(worker line)。Add or adjust a supervised worker line via fleet.config.json — the only sanctioned entry.
---

# 添加自动拉取线(add-line)

操作者说「加一条线 / 新开一条 xx 线 / 调整线」时用本 skill。
唯一入口是根目录 `fleet.config.json` 的 `lines[]`——**不需要也不允许改任何代码**。

## 步骤

1. 根目录没有 `fleet.config.json` → 先 `node cli/init.mjs`(把示例复制到根;根配置已被
   gitignore,属于本机,不会进仓)。
2. 在 `lines[]` 追加一项:

   ```json
   { "id": "docs", "hint": "文档/README/注释" }
   ```

   - `id`:机器契约。英文小写字母/数字/`-`/`_`,短。卡上的 `line` 字段将引用它。
   - `hint`:给拆解器和人看的一句用途说明,中文即可。
3. 配置只在 server 启动时读取一次——**必须重启 server 才生效**。状态在 SQLite,
   卡不会丢;但重启前确认没有 in_progress 在途(有则等交付,或先停自动拉取)。
4. 验证(两条都做):
   - `python cli/board.py lines` → 新线出现在列表;
   - 面板「自动拉取」行 → 新线出现,带启动按钮。

## 护栏(先读再动手)

- **一次只加一条**;加完验证再加下一条。
- **不改既有线的 `id`**:已有卡的 `line` 字段引用它,改名 = 孤儿卡。改 `hint` 随意。
- `max_parallel` 管全板同时在跑的 worker 数;**加线 ≠ 加并发**,超了自动排队,别为此改代码。
- `handoff_targets` 只在需要「人工落盘交付物」时才配;`dir` 必须是本机已存在的目录,
  不要指向仓库内部。
- 新线用途与既有线明显重叠时,先问操作者,不要自作主张拆分。
- 想要的效果 `lines[]` 给不了(新状态、新字段、新端点)= 那是开发,不在本 skill 范围:
  停下来向操作者说明,不要顺势往 `core/` 里加东西。
