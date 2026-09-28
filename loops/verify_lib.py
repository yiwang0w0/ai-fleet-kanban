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

# ── 数据目录里的文件分两类(v0.21.2)。deny 规则按**文件名**逐条钉,不再整目录一网打尽:
#   2026-09-28 在 Linux 上用真 CLI(Claude Code 2.1.283)量出 `Read(//<data>/**)` 会连带拒掉
#   模型往 <data>/evidence 写证据文件(Write 工具先按 Read 规则查路径),`Read(//<data>/*)` 单星
#   同样拒掉子目录里的新建;只有逐文件 / 文件名通配 / 子目录通配三种写法能在钉住敏感文件的
#   同时把证据目录留给模型(对照 R·S·T·U·V·W,见 docs/方案-身份分配.md §6)。
#   ⚠ 新增一个写进 <data> 的文件名时,必须归入下面两表之一 —— `--prompt-selftest` 会扫源码里
#     所有 `join(DATA_DIR, "…")` 形的字面量,归不进去的直接红:这是防「忘了列」的结构,不是提醒。
PROTECTED = (
    "board_token", "worker_token", "review_token",   # 三令牌(INCIDENT-12:读到令牌 = 拿到裁定权)
    "board.db*",                                     # 状态本体(含 -wal / -shm)
    "accepted_rev", "restart_from",                  # 源码闸的记录 / 重启标记
    "worker_settings.json", "lineage.json",          # 座席设置;个人会话 id
    "pool_state.json", "pool_global_stop.json",      # 池状态(pool-quota skill:改标记≠额度回来)
    "spend_ledger.jsonl", "usage_ledger.jsonl",      # 账本
    "board.log",
    "probe_conn", "probe_selfcheck_ok", "probes/**", # 探针的连接串与生产行(SECURITY:数据室不在这)
    "codex-*.txt",                                   # codex 座席的末消息转存
    "*.tmp",                                         # 原子写的临时文件
)
# 模型的「出件箱」:worker 的证据与派生卡、审阅的判决、拆解的结果。不进 deny 表。
MODEL_OUTPUT = ("evidence", "review", "decompose")


def deny_path(abs_path):
    """把绝对路径拼成 Claude Code 权限规则认的绝对形。
    ⭐ 2026-09-28 实测(Linux,Claude Code 2.1.283):规则里 `/path` 是**项目根相对**,`//path` 才是
      绝对路径 —— v0.17.0 用 `os.path.abspath` 直接拼,POSIX 上得到单斜杠,于是**一条都不匹配**
      (Read/Edit/Write/Grep 全部穿透;阳性对照:改成 `//` 后全部拒绝)。v0.17.0 的九组实测在
      Windows 上做,`C:/…` 形成立,那一形保留不动。"""
    p = str(abs_path).replace("\\", "/")
    if re.match(r"^[A-Za-z]:/", p):
        return p                      # already the Windows absolute form; abspath on POSIX would mangle it
    p = os.path.abspath(p).replace("\\", "/")
    return p if re.match(r"^[A-Za-z]:/", p) else "//" + p.lstrip("/")


def cli_deny_rules(data_dir, registry=None):
    """Claude 座席的路径级 deny 规则(v0.17.0;写法与范围于 v0.21.2 按实测改)。两条 loop 共用
    —— 写在两处必有一处腐烂。

    为什么需要:worker 的 cwd / --add-dir 是工作仓;默认部署里看板就是工作仓,于是令牌目录
    (core/.data,含 operator 全权的 board_token)与验证登记簿都在模型伸手可及之处 ——
    改登记簿一个键就能借 loop 之手执行任意命令;读到 board_token 就拿到裁定权(外部审计 2026-09-07)。
    **把 .data 搬出仓库挡不住**:cwd 之外的绝对路径 Read 成功(2026-09-07 实测)。同一 OS 用户下
    没有文件系统屏障 ∴ 结构防线是这组规则;搬家只是纵深。

    为什么是这个形(2026-09-28 实测,Linux,Claude Code 2.1.283):
      · 只产 `Read(...)` 与 `Edit(...)`:CLI 明说 `Write(path)` / `Glob(path)` 两种写法「不被文件权限
        检查匹配」,Edit 规则覆盖所有写文件工具、Read 规则覆盖所有读文件工具(Grep 实测被 Read 拦住)。
      · 绝对路径经 deny_path 拼成 `//…`(POSIX)—— 单斜杠是项目根相对,v0.17.0 就栽在这里。
      · 按文件名逐条钉而不是 `<data>/**`:整目录的 Read deny 会把模型往 <data>/evidence 写证据也拒掉。
    ⚠ 这只管 Claude 座席。codex 没有等价机制,那边只有提示词纪律 —— 写进 SECURITY,不假装。"""
    rules = []
    data = deny_path(data_dir)
    for name in PROTECTED:
        rules += [f"Read({data}/{name})", f"Edit({data}/{name})"]
    reg = deny_path(registry or REGISTRY)
    rules += [f"Read({reg})", f"Edit({reg})"]
    return rules


if __name__ == "__main__":
    # doctor 用:把本部署实际会发给 CLI 的 deny 规则打出来,一行一条(它只核写法,语义靠真 CLI 量)。
    if "--print-deny-rules" in sys.argv:
        data = os.environ.get("BOARD_DATA_DIR") or os.path.join(CODE_ROOT, "core", ".data")
        for r in cli_deny_rules(data):
            print(r)
        sys.exit(0)
    sys.exit("verify_lib: 可用 --print-deny-rules")

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
