#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""verify_lib —— 卡指名验证的**唯一**执行器(worker_loop 与将来的 reviewer_loop 共用)。
写在两处必有一处腐烂。登记簿 = verify_registry.json(与 core/store.js 读**同一个文件**)。
审阅在烧模型之前也先打这里的确定性验证 —— 红了就机器打回,不烧模型。"""
import json, os, re, subprocess, sys, io, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
# ⭐两个「仓」要分开(与 worker_loop.py / reviewer_loop.py 同一约定):
#   CODE_ROOT = 看板自己的代码在哪(本文件的上一级)。登记簿是运营者的档,住这里 ——
#               core/store.js 也从这里读(path.join(__dirname, "verify_registry.json"))。
#   REPO      = 舰队作业的目标仓,在本文件里只做验证命令的 cwd。
CODE_ROOT = os.path.dirname(HERE)
REPO = os.environ.get("BOARD_REPO", CODE_ROOT)

def log(m): print(f"[{datetime.datetime.now():%H:%M:%S}] {m}", flush=True)

VERIFY_TIMEOUT = int(os.environ.get("WORKER_VERIFY_SEC", "900"))
# ⭐与 core/store.js 的约定一致:BOARD_VERIFY_REGISTRY || <看板代码根>/core/verify_registry.json。
#   路径约定分叉的后果:store 按 A 校验键、loop 按 B 找命令,卡面绿而执行 404。
#   ⚠ 这一行曾锚在 REPO 上。默认部署里 REPO == CODE_ROOT,所以没人发现;BOARD_REPO 指向
#     工作仓的 split 部署下,store 读看板仓的登记簿、loop 读工作仓的 —— 正是上一行警告的
#     那个分叉。警告写在这里,踩也踩在这里(外部审阅 2026-09-07 指出)。
REGISTRY = os.environ.get("BOARD_VERIFY_REGISTRY") or os.path.join(CODE_ROOT, "core", "verify_registry.json")

# ── Claude 座席的路径级 deny 规则:钉哪些文件 ────────────────────────────────────
# <data>/ 下由 loop / server / 操作者写、座席一律不得读不得改的东西(平铺文件 + 子目录)。
# ⚠ 代价:新落在 <data>/ 平铺层的敏感文件**要加进这张表**。v0.17.0 用 <data>/** 一网打尽,
#   2026-09-28 实测(Linux,Claude Code 2.1.283)那张网连座席在 <data>/evidence/ **新建**证据
#   文件的 Write 也拒(Read(//<data>/**) 单独一条就拒;deny 永远压过 allow,挖不了洞;
#   `<data>/*` 单星实测同样穿进子目录;`{a,b}` 花括号不展开)。证据与判决**必须**能写 ⇒ 只能逐文件列。
#   词法守卫在 worker_loop --prompt-selftest:代码里 join(DATA, 名) 出现的每个名字,要么匹配
#   这张表,要么在 DATA_OPEN 里显式放行 —— 新文件没分类,自检就红,不靠人记得
#   (第一次跑就抓出了 decompose/ 与 restart_from 两个没人想起来的)。
DATA_DENY = (
    "board_token", "worker_token", "review_token",     # 三令牌(operator 全权 / 执行面 / 裁定面)
    "board.db*",                                       # 库本体 + -wal/-shm/-journal
    "accepted_rev",                                    # 源码闸接受的修订 —— 改它 = 绕过闸
    "worker_settings.json", "lineage.json",            # 座席声明 / 派生谱系
    "pool_state.json", "pool_global_stop.json",        # 池状态 / 全局停机标记(伪造一个 = 停整块板)
    "spend_ledger.jsonl", "usage_ledger.jsonl",        # 两本账(预算闸的依据)
    "probe_conn", "probe_selfcheck_ok", "probes/**",   # 探针凭据 / 探针解锁标记 / 含生产行的归档
    "decompose/**",                                    # 目标拆解的产出(会变成卡 —— 伪造 = 注入卡)
    "restart_from",                                    # server 重启交接标记
    "board.log", "codex-*.txt",                        # 板日志 / codex 座席的末消息文件
)
# 座席**要写**的两条通道:worker 的证据(<data>/evidence/)、reviewer 的判决(<data>/review/)。
# 任何规则都不得覆盖它们 —— 三处 harness(looptest ⑭ / reviewtest §2b / prompt-selftest)钉着。
DATA_OPEN = ("evidence", "review")


def rule_path(p):
    """路径在 Claude Code 权限规则里的写法。

    2026-09-28 实测(Linux,Claude Code 2.1.283,六组对照 + 阳性对照):规则里 `/x` 是**项目根相对**,
    `//x` 才是绝对路径 —— v0.17.0 产出的 `Read(/home/u/board/core/.data/**)` 在 POSIX 上什么都不匹配
    (单斜杠:Read/Grep/Edit/Write 全放行;同一路径换成双斜杠:全拒绝)。
    Windows 的 `C:/…` 形没有这个歧义;v0.17.0 那九组实测在 Windows 上做、成立,本次未复测。"""
    p = os.path.abspath(p).replace("\\", "/")
    return "//" + p.lstrip("/") if p.startswith("/") else p


def cli_deny_rules(data_dir, registry=None, db=None):
    """Claude 座席的路径级 deny 规则(v0.17.0;v0.21.2 改写法与范围)。两条 loop 共用 —— 写在两处必有一处腐烂。

    为什么需要:worker 的 cwd / --add-dir 是工作仓;默认部署里看板就是工作仓,于是令牌目录
    (core/.data,含 operator 全权的 board_token)与验证登记簿都在模型伸手可及之处 ——
    改登记簿一个键就能借 loop 之手执行任意命令;读到 board_token 就拿到裁定权(外部审计 2026-09-07)。

    为什么是这个形:
      · 2026-09-07 用真 CLI(-p 模式,**Windows**)做了 9 组对照 —— `Read(<dir>/**)` 拦住了相对路径读、
        绝对路径读、Grep 读内容;Edit/Write 对登记簿的 deny 同样生效(阳性对照:无 deny 时文件确实被
        改写、秘密确实泄露)。**把 .data 搬出仓库挡不住**:cwd 之外的绝对路径 Read 成功。
        ∴ 结构防线是这组规则;搬家只是纵深。
      · 2026-09-28 用真 CLI(**Linux**,Claude Code 2.1.283)复测 —— v0.17.0 的写法在 POSIX 上是**空的**:
        `/abs` 被读成项目根相对,只有 `//abs` 是绝对(见 rule_path);`Write(...)`/`Glob(...)`/`Grep(...)`
        写法**一条都不拦**(各自单独带上,新建文件 / 列目录 / 搜到秘密全部照常)—— CLI 自己在 stderr 说
        「is not matched by file permission checks — only Edit(path) rules are … Edit rules cover all
        file-editing tools」,但只在文本输出模式说(worker 那样);--output-format json(reviewer 那样)一声不吭
        ⇒ 只产 Read(...) 与 Edit(...)(实测 Read 规则还拦 Grep 的命中文件与 Glob)。整目录 `<data>/**`
        会连证据/判决的 Write 一起拒 ⇒ 逐文件钉(DATA_DENY),放过 evidence/ 与 review/。
    ⚠ 这只管 Claude 座席。codex 没有等价机制,那边只有提示词纪律 —— 写进 SECURITY,不假装。
    ⚠ 写法 doctor 能核;**语义**只能用真 CLI 量:python loops/deny_probe.py(手动,不进 CI)。"""
    data = rule_path(data_dir)
    targets = [f"{data}/{name}" for name in DATA_DENY]
    targets.append(rule_path(registry or REGISTRY))
    # BOARD_DB 可以把库指到 <data> 之外(core/store.js:DB_PATH);那时上表的 board.db* 钉不到它。
    db = os.environ.get("BOARD_DB", "") if db is None else db
    if db and rule_path(db) + "*" not in targets:
        targets.append(rule_path(db) + "*")          # -wal/-shm/-journal 同前缀
    rules = []
    for t in targets:
        rules += [f"Read({t})", f"Edit({t})"]
    return rules

def verify_registry():
    """卡可以指名的验证集合。"""
    try:
        raw = json.load(io.open(REGISTRY, encoding="utf-8"))
        return {k: v for k, v in raw.items() if not k.startswith("_") and isinstance(v, list)}
    except Exception as e:
        log(f"  ⚠验证登记簿读不了({e})")
        return {}

def run_verify(t):
    """卡指名的验证由 **loop** 执行,不采信 worker 的"通过了"申告。
    卡持有的是登记簿的**键**而非命令字符串 —— 持字符串则能写文件的 worker
    就能指名自造脚本让 loop 代跑(执行权的迂回)。
    argv 数组以 shell=False 传递,不经过 shell 解释与参数切分。"""
    key = str(t.get("verify_cmd") or "").strip()
    if not key: return None
    reg = verify_registry()
    argv = reg.get(key)
    if not argv:
        # 读不了/未登记不得化装成"没有验证"。默默放行是最危险的形。
        return {"ok": False, "key": key, "rc": None,
                "out": f"验证 '{key}' 不在登记簿里(可用: {' / '.join(reg) or '(空)'})。"
                       f"修改卡上的 verify_cmd,或往 verify_registry.json 加键。"}
    venv = dict(os.environ)
    venv.setdefault("BOARD_PYTHON", sys.executable)
    venv["PYTHON"] = venv.get("BOARD_PYTHON", sys.executable)
    # ⭐argv[0] 是解释器**名字**时,映射到本进程的实体。
    #   ⚠上面的 env(BOARD_PYTHON/PYTHON)对 node 侧消费者有效,但对
    #     `argv[0] == "python"` 的键**完全无效** —— CreateProcess/execvp 按 PATH
    #     解析,不看这两个变量。放了 env 就像"解释器已经照顾到了",而
    #     `["python", ...]` 的键依然赌 PATH(Windows 还可能撞上商店占位 exe)。
    #     **半接线状态最危险** —— 读的人以为接上了。
    #   ⭐sys.executable = 正在跑本 loop 的实体,是唯一不靠环境约定的权威源。
    #   ⛔映射不了就显式失败,不赌 PATH。
    real = list(argv)
    if real and real[0] in ("python", "python3", "py"):
        if not sys.executable:
            return {"ok": False, "key": key, "cmd": " ".join(argv), "rc": -3,
                    "out": "解释器映射不了(sys.executable 为空)。"
                           "不赌 PATH —— 占位状态的键不放行。"}
        real[0] = sys.executable
    shown = " ".join(real)      # ★证据里写**实际跑的东西**(照抄 argv 就成了谎)
    try:
        w = subprocess.run(real, shell=False, cwd=REPO, capture_output=True, env=venv,
                           text=True, encoding="utf-8", errors="replace", timeout=VERIFY_TIMEOUT)
        return {"ok": w.returncode == 0, "key": key, "cmd": shown, "rc": w.returncode,
                "out": ((w.stdout or "") + (w.stderr or ""))[-4000:]}
    except subprocess.TimeoutExpired:
        return {"ok": False, "key": key, "cmd": shown, "rc": -1,
                "out": f"({VERIFY_TIMEOUT}s 超时中止)"}
    except Exception as e:
        return {"ok": False, "key": key, "cmd": shown, "rc": -2, "out": f"(无法启动: {e})"}

def fmt_verify(vr):
    return chr(10).join([
        "—— 验证(由循环执行;worker 无执行权)——",
        f"键: {vr['key']}" + (f"   命令: {vr['cmd']}" if vr.get("cmd") else ""),
        f"结果: {'通过' if vr['ok'] else '失败'}   rc={vr.get('rc')}",
        "```",
        (vr.get("out") or "").rstrip(),
        "```",
    ])
