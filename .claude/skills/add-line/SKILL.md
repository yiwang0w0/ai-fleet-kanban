---
name: add-line
description: 给看板添加或调整一条自动拉取线(worker line)。Add or adjust a supervised worker line via fleet.config.json — the only sanctioned entry.
---

# 添加自动拉取线(add-line)

操作者说「加一条线 / 新开一条 xx 线 / 调整线」时用本 skill。
入口只有两个,都**不需要也不允许改任何代码**,也**不需要重启**(v0.4):

## 加线(免重启)

任选其一——两者都由 server 校验、写入 `fleet.config.json`、当场重建线表:

- 面板:「自动拉取」行下方的「加线」输入框,填线名(+一句用途)→ 加入。
- CLI:`python cli/board.py lines add <线名> --file hint.txt`(用途写在文件里;
  中文走 argv 在 Windows 会变 U+FFFD,本仓所有文本字段同此规则;不给 --file = 无用途)。

线名是机器契约:小写字母/数字/`-`/`_`,1-32 位,以字母或数字开头。卡上的 `line`
字段将引用它。用途(hint)给拆解器和人看,中文即可,≤80 字。

## 验证(两条都做)

- `python cli/board.py lines status` → 新线出现(带 running/desired 两列);
- 面板「自动拉取」行 → 新线出现,带启动按钮。

## 改用途 / 手写配置

只改 `hint` 或一次性手写多条:直接编辑 `fleet.config.json` 的 `lines[]`
(没有的话 `node cli/init.mjs` 先复制示例)。**手写的改动要重启 server 才生效**
——配置只在启动时整体读取,免重启的只有上面的加线入口。

## 护栏(先读再动手)

- **一次只加一条**;加完验证再加下一条。
- **不改既有线的 `id`,也不删线**:已有卡的 `line` 字段引用它,改名 = 孤儿卡;
  server 故意不提供改名/删线入口,闲置的线零成本。改 `hint` 随意。
- `max_parallel` 管全板同时在跑的 worker 数;**加线 ≠ 加并发**,超了自动排队,别为此改代码。
- `handoff_targets` 只在需要「人工落盘交付物」时才配;`dir` 必须是本机已存在的目录,
  不要指向仓库内部。
- 新线用途与既有线明显重叠时,先问操作者,不要自作主张拆分。
- 想要的效果 `lines[]` 给不了(新状态、新字段、新端点)= 那是开发,不在本 skill 范围:
  停下来向操作者说明,不要顺势往 `core/` 里加东西。
