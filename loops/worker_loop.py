#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""看板自治 worker 循环。

轮询零 token(纯 HTTP),有活才起本机 CLI 的无头会话。

用法(一线一窗,建议同时 <= 3 窗):
  python loops/worker_loop.py --as <线名> [--interval 120] [--once] [--dry-run]
停止:Ctrl+C。

三处结构设计,全部来自实测教训:

1) **交付由 loop 代劳**,worker 只负责"把证据写进文件"。
   worker 用 Write 工具写文件即可,不需要任何命令权限——实测中 worker 干成了活却因为
   `board.py done` 属 Bash 类权限被挡下,形成"能认领、交不了活"。

2) **产不出东西不叫卡住,叫自行尝试**(四值状态机没有 blocked)。
   attempts 没用尽就把上次的 stdout/stderr 尾注入 prompt 换条路重跑;
   用尽了才落 waiting/decision,并在证据里写明在等什么。
   ⭐每次重试都打 /attempt 让库里的 attempts 真实累加——否则面板永远显示"尝试 1/3"。

3) **心跳走独立线程**。CLI 是阻塞子进程,主线程在它跑完之前一行都执行不到,
   不开线程的话 heartbeat_at 会停在 claim 那一刻,面板上的心跳会全线变红=假警报。

⭐无论哪种结局,loop 都继续去领下一张:waiting 停的只是那一条任务链,不是这个 worker。
"""
import json, os, re, glob, shutil, subprocess, sys, threading, time, datetime
import urllib.request, urllib.error, io, uuid, hashlib

HERE = os.path.dirname(os.path.abspath(__file__))
# ⭐两个"仓"要分开,它们在通用部署里**不是同一个**:
#   CODE_ROOT = 看板自己的代码在哪(本文件的上一级)。import 与 revision 闸都量它
#              —— 量的是"正在跑的治理代码",而不是舰队今天在改的项目。
#   REPO      = 舰队作业的目标仓(cwd / git status / 提示词里的路径)。
#   ⚠ 按 BOARD_REPO 去 import 会在 BOARD_REPO 指向别处(试验的临时仓)时直接崩。
CODE_ROOT = os.path.dirname(HERE)
REPO = os.environ.get("BOARD_REPO", CODE_ROOT)
sys.path.insert(0, os.path.join(CODE_ROOT, "gates"))
sys.path.insert(0, HERE)

import gates_lib          # revision 绑定门 + 全局预算(诸 loop 共用,勿各自复写)
import codex_runtime
import context_lib
from pool_state import RATE_LIMIT_PAT, report_exhausted
# 验证的执行器统一在 verify_lib(审阅将来与之共用)。
from verify_lib import run_verify, fmt_verify, VERIFY_TIMEOUT   # noqa: F401

# BOARD_PORT is honoured as a fallback — the preflight recommends it on a port
# clash, and ignoring it here would aim this client at the DEFAULT port's board.
BASE = os.environ.get("BOARD_URL") or (
    "http://127.0.0.1:" + os.environ["BOARD_PORT"] if os.environ.get("BOARD_PORT")
    else "http://127.0.0.1:47824")
# 这是**进程实际加载代码时**看到的子树身份,不是之后从磁盘补读的当前值。
# 每轮领卡前都拿它与 HEAD 比;新 commit/accepted_rev 不会让旧进程凭空换代码。
LOADED_TREE, LOADED_TREE_ERROR = gates_lib.gated_tree(CODE_ROOT, gates_lib.DEFAULT_SUBTREE)
# ⭐data 面与 server 用**同一个 env 名**(BOARD_DATA_DIR)。概念不劈成两个。
#   未设定则与 core/store.js 的默认落点一致 ⇒ 现成部署一毫米不动。
#   ⚠这为什么是必需的(否则结构上无法隔离测试):
#     · EVID 若被钉死,临时板上跑的 loop 会**去删**真板的 `task-<id>-attempt-<n>.md`
#       (handle 开头会清上一轮残骸)。临时板的 id 从 1 开始 ⇒ 与真证据撞名即毁。
#     · 令牌文件若被钉死,读到的是**现役板的令牌**而不是临时板的 ⇒ 401。
DATA = os.environ.get("BOARD_DATA_DIR", os.path.join(CODE_ROOT, "core", ".data"))
EVID = os.path.join(DATA, "evidence")

# ── 本机 CLI 的入口门 ─────────────────────────────────────────────────────────
# ⚠⚠ CLI 若是 .bat/.cmd,**提示词就成了 cmd.exe 的命令行**。
#   ・Windows 的 CreateProcess 经 %COMSPEC% /c 启动 .bat/.cmd(2024 年 CVE-2024-24576
#     『BatBadBut』)。Python 的 list2cmdline 守的是 MSVCRT 的引用规则,cmd.exe 的规则
#     **是另一套** —— cmd 把 `\"` 读成「字面 \ + 引用开关」,参数里的 `"` 能破掉引用,
#     其后的 `&` `|` `>` `<` 就**作为运算符被执行**。
#   ・提示词的内容是**看板卡片的正文**(subject / description / acceptance / 同链一览 /
#     git status 输出)⇒「能写卡的人 → cmd.exe 的命令行」这条路,在指向 .cmd 的瞬间打开。
#     提示词里本来就含固定文案 `{"tasks":[{"line":"..."}]}`(引号与竖线的组合)——
#     不必等恶意卡片,**素的提示词就已经能破**。
#   ⛔修法不是"把提示词洗干净"(正文由人自由书写,清洗必然有漏)。在入口拒绝。
#     原生可执行文件由 CreateProcess 直接启动 ⇒ 素通(无改动)。
#   ⭐这不是假想:npm 会**实际生成** `%APPDATA%\npm\claude.cmd`,而各种交接文档都在写
#     `& "$env:APPDATA\npm\claude.cmd" ...` ⇒「说到 CLI 就是 claude.cmd」的路就在眼前。
#     没有门,一行 env 就能打开它。
#   逃生口:WORKER_ALLOW_BATCH_CLI=1 —— 仅供 looptest 的桩(.cmd)。用了就 loud 记录。
BATCH_EXT   = (".bat", ".cmd")
ALLOW_BATCH = os.environ.get("WORKER_ALLOW_BATCH_CLI", "") == "1"


def cli_is_batch(path):
    """是不是 .bat/.cmd(=经由 cmd.exe 启动的东西)。**纯函数**:不看实体也不看内容。
    ⚠只凭扩展名就能判的事不要按 platform 分叉 ——「那边跑通了」是事故温床,
      在 POSIX 上把 .cmd 当 CLI 也没有正当理由。判据到哪儿都一样。"""
    return os.path.splitext(str(path or ""))[1].lower() in BATCH_EXT


def _npm_native_sibling(shim):
    """npm 的 .cmd shim 旁边通常躺着原生可执行文件。找到了才返回(找不到返 None)。
    ⚠这不是"默默升级到未知值":返回前一定 os.path.isfile 实测过。"""
    root = os.path.dirname(os.path.abspath(str(shim or "")))
    stem = os.path.splitext(os.path.basename(str(shim or "")))[0]
    cands = [
        os.path.join(root, "node_modules", "@anthropic-ai", "claude-code", "bin",
                     stem + (".exe" if os.name == "nt" else "")),
        os.path.join(root, stem + (".exe" if os.name == "nt" else "")),
    ]
    for c in cands:
        if os.path.isfile(c) and not cli_is_batch(c):
            return c
    return None


def resolve_cli():
    """决定要启动哪个 CLI。**宿主配置优先**,其次 PATH 自动解析。

    ⭐这里不写死任何个人环境的路径 —— 写死的瞬间,「某个人机器上的路径」就成了正典,
      在别人机器上会静默坏掉。默认走 PATH,让零配置安装在多数机器上直接可用。
    ⭐Windows 的 PATH 常常只解析到 npm 的 .cmd shim(会被上面的门拒绝)。此时**实测**
      旁边是否躺着原生可执行文件:躺着就用它并 loud 记录(此路不经 cmd.exe);
      没躺着就让门去拒,并在拒绝文里写清怎么修。
    """
    env = os.environ.get("WORKER_CLAUDE_CLI")
    if env:
        return env, None
    found = shutil.which("claude")
    if not found:
        return "claude", None            # 交给门与 spawn 失败去 loud 报告
    if cli_is_batch(found) and not ALLOW_BATCH:
        native = _npm_native_sibling(found)
        if native:
            return native, f"PATH 上的 claude 是 .cmd 包装器 —— 已自动改用旁边的原生可执行文件:{native}"
    return found, None


CLI, CLI_NOTE = resolve_cli()
# 试验与 mock 运行时用:整条基础 argv 由 JSON 给出(例:["python","/path/stub.py"])。
# ⭐这是让 Linux CI 与 mock 适配器成立的关键 —— 桩不必是可直接执行的文件。
#   门仍然看 argv[0](门要防的是 cmd.exe 那条路)。
try:
    CLAUDE = json.loads(os.environ["WORKER_CLI_ARGV"]) if os.environ.get("WORKER_CLI_ARGV") else [CLI]
    if not isinstance(CLAUDE, list) or not CLAUDE:
        raise ValueError("WORKER_CLI_ARGV 必须是非空 JSON 数组")
except Exception as _e:
    print(f"[worker] ⛔ WORKER_CLI_ARGV 读不了({_e})—— 拒绝启动", flush=True)
    sys.exit(gates_lib.EXIT_REFUSED)


def cli_gate(path=None, allow=None):
    """启动前的门。通过返 None,拒绝则返**理由文**(人读了能修的那种)。
    ⭐判定只在此处、且只负责返回 —— exit 由调用方(main)做。纯函数,可单独测。"""
    path  = CLAUDE[0] if path is None else path
    allow = ALLOW_BATCH if allow is None else allow
    if not cli_is_batch(path) or allow:
        return None
    return (
        "[worker] ⛔ CLI 指向了 .bat/.cmd —— 不启动。" + chr(10) +
        f"  当前: {path}" + chr(10) +
        "  Windows 经 cmd.exe 启动 .bat/.cmd(CVE-2024-24576 BatBadBut)。" + chr(10) +
        "  提示词=**卡片正文**会原样成为 cmd.exe 的命令行,正文里的引号一旦破掉引用," + chr(10) +
        "  其后的 & | > < 就作为命令执行 ⇒「能写卡的人」变成「能开枪的人」。" + chr(10) +
        "  修法:把 WORKER_CLAUDE_CLI 指向原生可执行文件(不是 npm 的 .cmd 包装器)。" + chr(10) +
        "  测试的桩可以用 WORKER_ALLOW_BATCH_CLI=1 显式打开(不要常用)。"
    )


# 槽配置(面板 agents[])经 env 降下来。⭐默认值必须**落在阶梯的某一段上**
#   —— 默认落在阶梯外的话,素起的 loop 整个提权阶梯都不会挂上(默认值静默杀功能)。
MODEL  = os.environ.get("WORKER_MODEL", "claude-opus-5")
# 持续会话:每条线复用固定 session id,上下文跨卡累积,代价是要定期整理(/compact)
# ——面板的「上下文」栏就是那个窗口。
SESSION = os.environ.get("WORKER_SESSION") or None
# 初次可从桌面对话 fork 继承记忆,以后 resume 自己的 session。
FORK_FROM = os.environ.get("WORKER_FORK_FROM") or None
ANCHOR    = os.environ.get("WORKER_ANCHOR") or None
EFFORT = os.environ.get("WORKER_EFFORT", "high")
# 运行时座席(allowlist=未知值落在拒绝侧)。
RUNTIME = os.environ.get("WORKER_RUNTIME", "claude")
RUNTIME_SEATS = ("claude", "codex")
# ⭐第二座席默认**关闭**,由宿主明示解禁。关着的时候能做的只有 probe(只读)——领卡落拒绝侧。
CODEX_RELEASED = os.environ.get("BOARD_CODEX_RELEASED") == "1"
# ⭐路径由**宿主发放**。仓库里不放默认值 —— 放了的瞬间「某个人环境的路径」就成了正典。
CODEX_CLI = os.environ.get("BOARD_CODEX_CMD") or ""

# ── 强度的自动阶梯(预判起点 + 重试提权)────────────────────────────────────
# 强度不该全线静态钉死:要提前判断强度、重试时提高模型或工作强度。
# 若把 MODEL/EFFORT 当**进程级常量**,第 1 次和第 3 次就用同一个脑子走同一条路。
#
# ⭐段与 (model, effort) 的对应表**只在这一处**。卡片持有的是 weight(从第几段起跑),
#   不持有模型名 —— 让卡片持有模型名,就等于「能写卡的人」=「能决定额度分配的人」,
#   而且对应表会长在两处(卡片与此处),必然只有一处被改。
# ⭐可配置:fleet.config.json 的 `ladder`(或 env WORKER_LADDER)= [{model, effort}, ...]。
#   舰队的模型阵容因人而异,把某个订阅档位写死在代码里就是又一条"个人环境成正典"。
BUILTIN_LADDER = [
    ("claude-opus-5", "medium"),   # L1
    ("claude-opus-5", "high"),     # L2
    ("claude-opus-5", "max"),      # L3
]


def _load_ladder():
    """阶梯的取值顺序:env WORKER_LADDER > fleet.config.ladder > 内置默认。
    ⚠读不了/格式不对时**不静默降级** —— loud 一行然后用内置默认(阶梯是机构,
      不是判决:错误的配置不该让整条线停,但必须能被看见)。"""
    raw = os.environ.get("WORKER_LADDER")
    src = "env WORKER_LADDER"
    if not raw:
        cfg_path = os.environ.get("BOARD_CONFIG") or os.path.join(REPO, "fleet.config.json")
        try:
            cfg = json.loads(io.open(cfg_path, encoding="utf-8").read())
            if isinstance(cfg.get("ladder"), list) and cfg["ladder"]:
                raw, src = json.dumps(cfg["ladder"]), os.path.basename(cfg_path) + " 的 ladder"
        except FileNotFoundError:
            pass
        except Exception as e:
            print(f"[worker] ⚠ 配置读不了({e})—— 阶梯用内置默认", flush=True)
    if not raw:
        return list(BUILTIN_LADDER)
    try:
        rows = json.loads(raw)
        out = [(str(r["model"]), str(r["effort"])) if isinstance(r, dict) else (str(r[0]), str(r[1]))
               for r in rows]
        if not out:
            raise ValueError("阶梯为空")
        return out
    except Exception as e:
        print(f"[worker] ⚠ {src} 解析失败({e})—— 阶梯用内置默认", flush=True)
        return list(BUILTIN_LADDER)


LADDER = _load_ladder()
# ⭐封顶:阶梯是**机构**,用到哪一档是**政策**。
#   ⛔不要从 LADDER 里删行来"关掉顶档" —— 删行会把点名了该档的试验一起打碎,
#     等政策放开时就得反过来改试验。⇒ 封顶走 env 一根。
#   ⚠这是**上限而不是起点**:heavy 卡的起点(WEIGHT_START)也会被 min 压住。
#   ★背景(政策的实测依据):顶档的两发曾 = 当日消费的八成。被打回的卡会自动爬到更高档,
#     所以**最难治的卡每次都抽最贵的脑子** —— 调整政策时先看这条不对称。
LADDER_CAP = int(os.environ.get("WORKER_LADDER_CAP", str(len(LADDER) - 1)))
TOP_RUNG = max(0, min(LADDER_CAP, len(LADDER) - 1))
# 起点预判。值域门在 server(与 route/line 同型)—— 此处**不抄写、不再比一遍**。
WEIGHT_START = {"light": 0, "standard": 1, "heavy": 2}


def tier_label(model, effort):
    """日志・账本里的短名。`claude-opus-5/max` 太长,叠成 `opus-5/max`。"""
    return "%s/%s" % (re.sub(r"^claude-", "", str(model or "")), str(effort or ""))


def slot_rung(model=None, effort=None):
    """槽配置(面板 agents[] → WORKER_MODEL/WORKER_EFFORT)落在阶梯第几段。
    不在阶梯上的组合返回 **None** ——「人明确选了阶梯之外」的状态。"""
    pair = (str(MODEL if model is None else model), str(EFFORT if effort is None else effort))
    return LADDER.index(pair) if pair in LADDER else None


def tier_of(weight, attempt, model=None, effort=None):
    """第 attempt 次尝试使用的 (model, effort, 段号)。⭐**纯函数** —— 不需要板也不需要 CLI,
    可以单独测(不制造"必须跑真实输出才能验收"的形)。

    ・**起点**:卡片明示的 weight(light/heavy)**卡片赢**(L1 / L3)。
      standard(默认 = 「本卡没有特别意见」)以**槽配置所在段**为起点。
    ・**重试提权**:起点 + (attempt-1),到顶档封顶。同一张卡的最后一搏自然够到顶。
    ・**槽配置在阶梯外**则不挂阶梯,逐字沿用该组合(段号 None)。
      理由:面板上的选择变成「按了也不会怎样的摆设」是最坏的情形。
      代替地,「没挂阶梯」这件事会出现在日志和账本里(段=None 可观测)。

    ⚠ attempt 是 claim//attempt 累加的**卡片生涯次数**。park → 裁定 → 回投的卡
      从上次的续接处数 ⇒ 上一轮烧过 3 次的卡一开始就在高档上跑。这是规格
      (「同一张卡的最后一搏自然到顶」),不是漏算。
    """
    rung = slot_rung(model, effort)
    if rung is None:
        return (str(MODEL if model is None else model),
                str(EFFORT if effort is None else effort), None)
    w = str(weight or "standard")
    # 未知值落**正中间**(既不加强也不削弱)。值域门通过的话不该出现,
    # 但为了旧库遗物用 KeyError 打死整条线并不划算。
    start = WEIGHT_START[w] if w in ("light", "heavy") else rung
    i = min(min(start, TOP_RUNG) + max(1, int(attempt)) - 1, TOP_RUNG)
    return LADDER[i][0], LADDER[i][1], i


HB_SEC = int(os.environ.get("WORKER_HEARTBEAT_SEC", "30"))
LEASE  = int(os.environ.get("WORKER_LEASE_MIN", "30"))
TIMEOUT = int(os.environ.get("WORKER_TIMEOUT_SEC", "3600"))
# 上下文超过这个数就在**领卡前**折叠。定得太高的话,压缩发生之前每张卡都在
# 持续支付几十万 token 的上下文费。
CTX_COMPACT_AT = int(os.environ.get("WORKER_CTX_COMPACT", "200000"))

# 限流文字的唯一来源是 pool_state.RATE_LIMIT_PAT。诸 loop 共用。
RATE_WAIT_SEC = int(os.environ.get("WORKER_RATE_WAIT_SEC", "900"))   # 15 分
RATE_MAX_WAITS = int(os.environ.get("WORKER_RATE_MAX_WAITS", "24"))  # 上限 6 小时
WORKER_LINE = None


def arg_of(flag, default=None):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else default


def log(m): print(f"[{datetime.datetime.now():%H:%M:%S}] {m}", flush=True)


def _board_token():
    """v0.2 起 worker 持 **worker_token**(只覆盖执行面:claim/report/heartbeat/派生建卡…;
    裁定/编辑对它 403)。由 server 首次启动时生成在 <DATA>/worker_token。
    ⚠ 不回退到 board_token —— 那是 operator 全权令牌,worker 拿到它就等于拿到裁定权
      (实测事故:一个被授予看板目录的交互 agent 用 board_token 自批了自己的卡)。
      文件读不到 = server 是 v0.2 之前的旧版,发空令牌让 401 响亮落地。
    ⚠ DATA 跟随 BOARD_DATA_DIR —— 要读的是**server 写令牌的那个地方**。
      钉死的话,面对临时板时会读到现役板的令牌而 401。"""
    try:
        return io.open(os.path.join(DATA, "worker_token"), encoding="utf-8").read().strip()
    except Exception:
        return ""


def call(method, path, body=None, timeout=20):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json; charset=utf-8",
                                          "X-Board-Token": _board_token()})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8")
            return r.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        return e.code, (json.loads(raw) if raw.strip() else {})
    except urllib.error.URLError as e:
        raise RuntimeError(f"看板不可达({BASE}):{e.reason}\n"
                           f" → 先起看板:node core/server.mjs") from None
    except (TimeoutError, OSError) as e:
        # ⚠socket 读超时不是 URLError,而是裸的 TimeoutError。
        #   漏掉它会让整个进程死掉(实测:等 compact 应答时两条线一起落,静默停了 5.5 小时)。
        #   调用方已经把 RuntimeError 当作"没能和板说上话"处理,所以折叠到那边。
        raise RuntimeError(f"看板无应答({type(e).__name__}: {e})—— {method} {path}") from None


class Heartbeat(threading.Thread):
    """CLI 跑着的时候由这条线程续命。主线程被 subprocess 堵住,自己打不了心跳。"""
    def __init__(self, task_id, worker):
        super().__init__(daemon=True)
        self.task_id, self.worker, self.stop = task_id, worker, threading.Event()
        self.beats = 0

    def run(self):
        while not self.stop.wait(HB_SEC):
            try:
                s, _ = call("POST", f"/api/tasks/{self.task_id}/heartbeat",
                            {"worker": self.worker, "lease_minutes": LEASE})
                if s == 200: self.beats += 1
                else: log(f"  心跳被拒 {s}(卡可能已被回收),停止续命"); return
            except Exception as e:
                log(f"  心跳失败:{e}")


def spawn_path_for(tid):
    return os.path.join(EVID, f"spawn-{tid}.json")


def _norm_subject(x):
    """规范化标题:去掉空白与约物再小写 —— 让重试提出的同一个建议被视作同一件事。"""
    return re.sub(r"[\s\u3000,。、·・:;:;()()\[\]【】\-—_]+", "", str(x or "")).lower()


def harvested_flag(tid):
    return os.path.join(EVID, f"harvested-{tid}.flag")


def stash_spawn(tid, why):
    """父卡没成功时:建议**不立卡**但也不丢 —— 折进证据、删掉文件
    (放着不管的话,下次成功时会把"失败路线上的建议"立成卡)。"""
    p2 = spawn_path_for(tid)
    if not os.path.isfile(p2): return None
    try: raw = io.open(p2, encoding="utf-8", errors="replace").read()
    except Exception: raw = "(读不出来)"
    try: os.remove(p2)
    except Exception: pass
    return ("—— 候选发现(" + why + ",按派生闸不立卡;内容留档,要立项由人/协调裁定)——"
            + chr(10) + "```json" + chr(10) + raw[:2000] + chr(10) + "```")


def harvest_spawned(t, worker):
    """把 worker 放下的 spawn 文件变成卡。**建卡的是 loop**。
    ⭐派生闸:「子任务」是「候选发现」。
      1) 只在**父卡成功+验证通过之后**调用(由调用方 handle 保证)
      2) 同一父卡**生涯只收割一次**(flag 文件。重试・重开都不再收割)
      3) 每父最多 2 案・自动放行只有 1 案(第 2 案进候选池=released 0)・溢出进证据
      4) (父+规范化标题)的重复不建(DB 唯一索引是最终防波堤,这里是先手门)
      5) 链深:目标(0)→执行卡(1)→必要后续(2)**两层为止**。会成为第 3 层的发现
         上浮到链根目标直下并保持未放行(发现不丢,队列不被劫持)
         ⭐判定在 store.js 的 `placeInChain()`。这里老实地按 `parentId = 本卡` 建,
           深了服务端会上浮再返回。
           ⚠不要自己重算一遍:闸只长在 worker 侧正是当初的问题本身,
             写在两处必然只改一处,CLI/面板/重编排又会绕过去。
    返回:(made, memo) —— memo 是要追加进证据的说明(候选池/溢出/已收割)。"""
    p = spawn_path_for(t["id"])
    if not os.path.isfile(p): return [], None
    if os.path.isfile(harvested_flag(t["id"])):
        memo = stash_spawn(t["id"], "本卡生命周期内已收割过一次")
        log("  派生文件在,但本卡已收割过 —— 建议仅留档进证据")
        return [], memo
    try:
        raw = io.open(p, encoding="utf-8", errors="replace").read()
        m = re.search(r"\{.*\}", raw, re.S)
        d = json.loads(m.group(0) if m else raw)
        items = d.get("tasks") or []
    except Exception as e:
        log(f"  派生文件读不了({e})—— 不忽略,留在卡上")
        return [{"error": str(e)}], None

    # 现有子卡(未归档)的规范化标题 —— 重试吐出同一建议时不建第二张
    existing = set()
    try:
        s1, r1 = call("GET", f"/api/tasks/{t['id']}/related")
        for x in (r1 or {}).get("tasks") or []:
            if x.get("parent_id") == t["id"]:
                existing.add(_norm_subject(x.get("subject")))
    except Exception as e:
        log(f"  取现有子卡失败({e})—— 去重交给 DB 索引兜底")

    made, extra = [], []
    for it in items:
        if len(made) >= 2:                     # 每父最多 2 案
            extra.append(it); continue
        ns = _norm_subject(it.get("subject"))
        if ns and ns in existing:
            log(f"  重复建议不建卡: {str(it.get('subject') or '')[:34]}")
            continue
        if it.get("needs_bash") or it.get("verify_cmd"):
            log(f"  已忽略派生卡自带的权限/验证指定(worker 不能自定): "
                f"{str(it.get('subject') or '')[:34]}")
        s2, r2 = call("POST", "/api/tasks", {
            "subject": str(it.get("subject") or "(无题)"),
            "description": str(it.get("description") or ""),
            "acceptance": str(it.get("acceptance") or ""),
            "line": it.get("line") if it.get("line") not in (None, "null") else t.get("line"),
            "needsBash": False,
            "parentId": t["id"],          # 深度判定归服务端(store.placeInChain)
            # 自动放行**只有第一案**。第 2 案进候选池(released 0)。
            # ⚠上浮的卡也会是未放行,但那由**服务端**决定(此处判断不了)。
            "released": 0 if made else 1,
            "kind": "task",
        })
        if s2 < 400:
            made.append(r2["task"]["id"])
            if ns: existing.add(ns)
            # 有没有上浮**看返回的卡**(不自己重算)。为了不让它静默,打印出来。
            nt = r2.get("task") or {}
            if nt.get("parent_id") != t["id"]:
                log(f"  ⚠#{nt.get('id')} 被链深闸上浮了(父 #{t['id']} → "
                    f"{('#' + str(nt.get('parent_id'))) if nt.get('parent_id') else '无(链根)'}"
                    f"・released={nt.get('released')})")
        else:
            log(f"  派生建卡失败 {s2} {r2.get('error','')}")
    memo = None
    if extra:
        memo = ("—— 候选发现·超出每卡 2 案上限的部分(不立卡留档)——" + chr(10) +
                "```json" + chr(10) + json.dumps({"tasks": extra}, ensure_ascii=False)[:1500] + chr(10) + "```")
    try: os.remove(p)
    except Exception: pass
    try: io.open(harvested_flag(t["id"]), "w", encoding="utf-8").write(datetime.datetime.now().isoformat())
    except Exception as e: log(f"  收割 flag 写不了({e})—— 生涯一次的保证被削弱")
    if made: log(f"  派生 {len(made)} 件: {made}(放行 {made[:1]},其余候选池)")
    return made, memo


def worktree_state():
    """未提交的改动由 **loop** 读出来交给 worker(worker 没有 Bash)。
    只调只读的 git。共享 worktree,所以别的线正在做的行也会混进来
    —— 因此要明写「不一定是你写的」。"""
    def git(*a):
        try:
            w = subprocess.run(["git", *a], cwd=REPO, capture_output=True, text=True,
                               encoding="utf-8", errors="replace", timeout=20)
            return w.stdout.strip() if w.returncode == 0 else ""
        except Exception:
            return ""
    st = git("status", "--porcelain")
    if not st: return None
    return st, git("diff", "--stat")


ST_MARK = {"done": ("✔", "已完成"), "in_progress": ("▶", "进行中"),
           "waiting": ("⏸", "等待中"), "not_started": ("○", "未开始")}
WF_MARK = {"review": "待验收", "confirm": "待确认", "decision": "待裁定", "dep": "待依赖"}


def chain_of(tid):
    """同一条流(父目标 + 兄弟 + 子孙)的卡,带状态返回。自己除外。"""
    try:
        s, r = call("GET", f"/api/tasks/{tid}/related")
        rows = r.get("tasks") or []
    except Exception as e:
        log(f"  同链取得失败({e})—— 不写进提示词")
        return []
    return [x for x in rows if int(x["id"]) != int(tid)]


# ── 把人的裁定运到 worker ────────────────────────────────────────────────────
# 洞:审阅 escalate → 卡进「待确认」→ 人在面板写点什么再 resolve → store.resolve 把卡
#   退回 **not_started + 原线**,人的话**追记进 verdict_note**。而 build_prompt 只画
#   description ⇒ 一个字都到不了 worker。
#   ⇒ 人已经裁过了,worker 却还在猜、还在问。「escalate → 人回答 → 回投」的环每转一圈,
#     就**空烧一次 attempt**。
#   worker 侧没有补救手段:没有 Bash、没有查板的工具、board.db 是 SQLite 二进制,
#   Read 读不了、Grep 也不可信 ⇒ 能运的地方只有这里。
#
# ⚠字面上是「status=not_started 且 verdict 非空」,但**不看 status**。
#   build_prompt 跑的时候卡已经是 in_progress —— claim() 返回前就写了 status
#   ⇒ 拿 not_started 当条件会变成**一次都不会为真的死条件**(不出红,只是静默失效)。
#   verdict 只有 resolve() 会写,claim 和 report 都不清 ⇒「verdict 非空的卡此刻又被领了」
#   就等同于「经裁定回投」。面板的同款判定能看 status,是因为面板映的是 **claim 前**的卡。
#
# ⭐自动审阅的打回也走同一条路进 verdict_note。这个也运 —— 条件既然是 verdict 非空,
#   就没有理由排除它;排除了,「机器说哪儿不行」又会对 worker 不可见(同一个洞的另一个口)。

# resolve() 写的裁定抬头:`—— 你的决定(2026-08-21T04:05:06.789Z · 通过 · 回原线继续)——`
# ⚠必须带时刻是要点。审阅的定型文里也有 `—— 自动审阅(...)· 这不是最终裁定 ——` 这种
#   **同形的行**,不看时刻就会把它错认成裁定抬头,切口整段偏移
#   (偏移的结果是:运到 worker 的只剩「下面的输入框里…」这种面板操作说明)。
VERDICT_HEAD = re.compile(
    r"^——\s*(?:你的决定|自动审阅)[^\n]*?\d{4}-\d{2}-\d{2}[^\n]*——[ \t]*$", re.M)

OPT_BUDGET = 2600   # 选项块允许的字数(提示词经 argv 传递,Windows 的 32767 是天花板)
DEC_BUDGET = 4000   # 人写的裁定正文允许的字数


def _trim_options(s):
    """把选项块削到 worker 需要的部分。**### 方案(A/B/C)留到最后**
    —— 人的那一个「A」字,读不到 A 是什么就不成其为指令。
    削的顺序从后往前:给人的操作说明 → 判断依据 → 核对一览 → 最后才是硬截字数。"""
    # 「下面的输入框里**写点什么再点通过/打回**…」是给操作面板的人看的说明。
    # 对 worker 无意义,而且会被读成**还没裁定**。
    i = s.find("\n—— 自动审阅(")
    if i > 0: s = s[:i].rstrip()
    for mark in ("\n### 判断依据(原文)", "\n### 我核对过什么"):
        if len(s) <= OPT_BUDGET: break
        j = s.find(mark)
        if j > 0: s = s[:j].rstrip() + "\n(…「" + mark.strip() + "」以下省略)"
    if len(s) > OPT_BUDGET:
        s = s[:OPT_BUDGET].rstrip() + ("\n(…此处截断 %d 字,全文在看板卡片的「裁定记录」栏)"
                                       % (len(s) - OPT_BUDGET))
    return s


def verdict_tail(note):
    """从 verdict_note 里只抽**尾段**(没有可抽的返 None)。

    不贴全文 —— verdict_note 是追记式的,每转一轮提示词就膨胀一圈。返回的是:
      · options  = 第一个裁定抬头之前(= 审阅摆出的「## 需要你确认 / ### 方案」)。
                   markAutoReviewed 会**覆盖** verdict_note,所以这里躺着的永远是
                   **本轮**的选项,不是过去某一轮的。
      · decision = 从最后一个裁定抬头到结尾。人写的话和时刻戳整段进来。
      · skipped  = 夹在中间的**更早**裁定块的个数。
    旧的不贴,但不静默丢弃,而是留一行省略 —— 用"看起来全都在"的方式截断最危险。"""
    s = str(note or "").replace("\r\n", "\n").strip()
    if not s: return None
    heads = list(VERDICT_HEAD.finditer(s))
    if not heads:
        # 没有裁定追记 = 人的话不在这里。每次都把审阅全文搬运并不是本机制的目的
        # (那只会让提示词膨胀),所以什么都不载。
        return None
    dec = s[heads[-1].start():].strip()
    if len(dec) > DEC_BUDGET:
        # 人的话要求**逐字**。要截就把"截了"写大(不静默地截)。
        dec = dec[:DEC_BUDGET].rstrip() + ("\n(…裁定正文过长,截断 %d 字。全文在看板卡片的"
                                           "「裁定记录」栏)" % (len(dec) - DEC_BUDGET))
    return {"options": _trim_options(s[:heads[0].start()].strip()),
            "decision": dec, "skipped": len(heads) - 1}


def verdict_block(t):
    """如果是经裁定回投的卡,返回要插进提示词的行。
    普通的卡(一次都没经裁定)返回 **[]** —— 提示词的形状一毫米都不动(回归条件)。

    ⭐看的是 `last_verdict`(本轮裁定)而不是 `verdict`(结案结果):
      回投的卡 `verdict` 是 **NULL** —— 用旧判据的话,人写了指示送回来的卡反而
      会把裁定从提示词里丢掉(静默死法。合成卡里显式带了 verdict,所以试验也发现不了)。
    ⚠ 留 `or t.get("verdict")` 是对旧板的保险。新旧板都运 —— 倒向"丢掉"那侧
      就是「人的指示到不了 worker」= 代价最高的坏法。"""
    if not str(t.get("last_verdict") or t.get("verdict") or "").strip():
        return []
    tail = verdict_tail(t.get("verdict_note"))
    if not tail:
        return []
    L = ["",
         "【上一轮裁定记录(verdict_note 尾段)】",
         "这张卡上一轮被裁过,并**带着下面这段话**回到了你的线上。"
         "把它当成指令读:**下面的裁定优先于上面的说明与验收标准**"
         "——已经定了的不要再猜,已经答过的不要再问一遍。",
         "(只贴尾段:verdict_note 是追记式,全文会随轮次膨胀。全文在看板卡片的「裁定记录」栏。)"]
    if tail["options"]:
        L += ["", "--- 裁定前,审阅摆在人面前的选项 ---", tail["options"]]
    if tail["skipped"]:
        L += ["", "(中间还有 %d 段更早的裁定记录,未贴 —— 最新的一段在下面)" % tail["skipped"]]
    L += ["", "--- 最近一次裁定(逐字,含时刻戳)---", tail["decision"]]
    return L


def build_prompt(t, worker, evidence_path, prev_tail=None, attempt=1):
    spawn_path = spawn_path_for(t["id"])
    p = [
        f"你是看板 worker(线名 {worker}),任务 #{t['id']} 已经为你认领,这是第 {attempt} 次尝试。",
        f"标题:{t['subject']}",
        f"说明:\n{t.get('description','')}",
    ]
    if t.get("acceptance"):
        p.append(f"验收标准:\n{t['acceptance']}")
    # ⭐运人的裁定。verdict 空的卡返回 [],提示词一点不变。
    p += verdict_block(t)
    # 临时会话每卡都是新的:卡面之外还必须显式带上宿主配置的持久上下文契约。
    # 历史锚点可能含业务示例,只给路径+hash,按需只读技术段,不整篇自动外发。
    p += context_lib.prompt_block(REPO, ANCHOR, RUNTIME)
    if prev_tail:
        p.append("⚠ 上一次尝试**没有产出证据文件**。上次进程的输出尾部如下——"
                 "别再走同一条路,换个做法:\n```\n" + prev_tail + "\n```")
    p += [
        "",
        "【怎么交付】做完后,把证据写进这个文件(用 Write 工具,不需要跑命令):",
        f"  {evidence_path}",
        "证据里要有:改了什么(文件:行)、跑了什么、实际输出是什么。贴机器产出,别手抄。",
        "**只要这个文件存在且非空,就算交付**——剩余步骤由循环完成,不需要调用任何看板命令。",
        "",
        "干不动也要写这个文件,写清楚卡在哪、需要谁裁定什么。",
        "",
        "【发现本卡范围外的工作】不要直接处理。写一个 JSON 文件,循环会替你建成卡挂在本卡下面:",
        f"  {spawn_path}",
        '格式:{"tasks":[{"subject":"...","description":"...","acceptance":"...","line":"<线名>"}]}',
        "(line 不写 = 跟本卡同一条线。要交给别的线才写。)",
        "(权限和验证不由你指定 —— 写了也会被忽略,由协调决定。)",
        "⭐派生是「候选发现」不是新工作流。**最多提 2 项**,且每一项要同时满足:",
        "  明确超出本卡验收范围 / 可独立验证 / 权限·负责人·回滚边界不同 / 不做会阻断目标或风险高。",
        "推测性优化、额外美化、同一问题的更多测试变体 —— **写进证据文件里观察,不要写 spawn**。",
        "本卡失败时这些提案不会立卡(只留档);同一张卡整个生命周期只收割一次 —— 所以只写最值得的。",
        "",
        "【执行】卡声明的正式验证由循环在你退出后代跑并把机器输出并进证据。"
        "你可以为理解与实现做必要的本地只读检查,但不要把未由循环产出的结果声称为正式验收。",
        "",
        "【纪律】禁 push(push 是协调专属);commit 用 pathspec 只含自己改的文件;"
        "中日文走文件不走命令行参数;只处理本卡范围内的事,不要改动范围外的内容。",
    ]
    if RUNTIME == "codex":
        p += [
            "",
            "【隐私硬边界】不得读取、搜索、复制或输出任何 .env/.env.*、看板令牌文件"
            "(<data>/board_token)、连接串文件,以及真实业务数据。"
            "不得把密钥放进提示词、命令、commit 或证据。",
            # ⚠实测订正:codex 的 workspace-write 沙箱**阻断外向通信**。
            #   实测:`git ls-remote origin` → ssh 22 端口 Permission denied /
            #        连接生产库 → connect timeout。
            #   ∴「worker 自己去打探针」在结构上做不到。写成能做,每张卡都要踩 20 秒
            #   连接等待,白烧一次 attempt。
            "【探针分工】需要连外部系统的探测**你这边打不出去**(沙箱阻断外向通信)。"
            "∴ 要只读探针时,写一个只返回一行聚合/真伪值的脚本放进仓库,"
            "并在证据里**带仓库相对路径**写明『这个探针需要协调线代跑』,自己不要尝试执行。",
            "若方案需要产出要人手执行的交付物(迁移脚本、配置文件、运维文档等):"
            "只负责生成完整文件并在证据写明仓库相对路径;不得自行应用到生产。"
            "最终裁定卡会把文件交给用户下载,用户确认即代表其已执行。",
        ]
    # ⭐把同一条流的卡带状态展示。不知道自己在链条何处就动手,会:
    #   重做已经做完的 / 插手别的卡的分工 / 擅自抢先做出等待中的判断。
    chain = chain_of(t["id"])
    if chain:
        p += ["", f"【本卡在一条任务链里 —— 同链另有 {len(chain)} 张】"]
        for x in sorted(chain, key=lambda x: (x["status"] != "done", int(x["id"]))):
            mark, label = ST_MARK.get(x["status"], ("·", x["status"]))
            if x["status"] == "waiting" and x.get("waiting_for"):
                label += "/" + WF_MARK.get(x["waiting_for"], x["waiting_for"])
            kind = "目标" if x.get("kind") == "goal" else (x.get("line") or "未分线")
            p.append(f"  {mark} #{x['id']} {label} [{kind}] {str(x.get('subject') or '')[:52]}")
        p += ["",
              "怎么用这份清单:①`done` 只表示流程已经关闭,**不是事实已经被证明**;不要重做,"
              "但只要它的结论会影响本卡,就必须先运行 `python cli/board.py show <id>`,"
              "核对 result、最新 verdict_note 和机器验证信息,并在本卡证据写明采用了 #几 的哪条证据。"
              "证据为空、只有主观判断或与当前实物冲突时,不得把它当可信前提,也不得擅自重做——转等待说明缺口。 "
              "②等待中的正在等待人工裁定,不要替它下结论 ③别的线的卡不要碰 "
              "④如果你发现本卡其实依赖某张还没完成的,写进证据并转等待,别硬做。"]
        # ⭐一个目标是一个整体任务,单张卡不是独立任务。
        #   实测:某次提示词里同链 36 张卡**每张只有 52 字的标题**,目标卡也只有一行。
        #   ⇒ 结构上,作业者一次都看不到目标的正文。
        #   ⇒ 两段处置:(1)链根目标的正文**总是**内联(用结构保证)
        #               (2)教会它**自己能拉**链上任意卡(不膨胀也能深入)
        goal = next((x for x in chain if x.get("kind") == "goal"), None)
        if goal:
            gd = str(goal.get("description") or "").strip()
            ga = str(goal.get("acceptance") or "").strip()
            # ⚠**正文为空也一定要出**。曾有目标 description 0 字、全文写在 subject 里
            #   —— 上面的一览把 subject 切到 52 字,作业者看到的只是半截。
            #   ∴ 条件写成「有正文才出」的话,**说明最不足的目标反而会掉**。
            cut = lambda v, n: (v if len(v) <= n else v[:n] + f"…[正文还有 {len(v)-n} 字。"
                                f"全文用 `python cli/board.py show {goal['id']}`]")
            p += ["", f"【这条链的目标 #{goal['id']} —— 本卡是它的一部分,不是独立的活】",
                  "目标(标题是**全文**,不是上面一览的 52 字截断):" + chr(10) + str(goal.get("subject") or "")]
            if gd: p.append("目标的说明:" + chr(10) + cut(gd, 2000))
            if ga: p.append("目标的验收:" + chr(10) + cut(ga, 800))
            if not gd and not ga:
                p.append("(这个目标正文为空 —— 要求全在上面的标题里。"
                         "含糊处不要擅自补全,把『目标的哪里读不出来』写进证据)")
            p.append("⚠ 即使满足了本卡的验收,只要那个改动会**破坏目标的验收**就不许交付。"
                     "发现冲突就写进证据转等待(不要擅自偏向任何一边)。")
        if RUNTIME == "codex":
            p += ["", "【链上其他卡你自己能读】"
                  "`python cli/board.py show <id>` 可以拉同链任意卡的全文"
                  "(只读・板在 localhost。⚠外向通信被阻断,到不了外部系统)。"
                  "上面的一览**只有标题**,涉及依赖或既有裁定时**必须拉现物**。"
                  "尤其是:依赖方『依据什么』那样决定,从标题绝对看不出来。"]

    # ⭐工作区里已经有改动的话,动手前**一定**告知。
    #   上一次尝试崩掉只留下半成品的事真的发生过(孤儿 worker 写了 3 个文件后被杀,
    #   卡退回「尝试 1・无结果」)。不告知的话,下一个人会在自己没写过的改动上开工,
    #   要么覆盖掉,要么把做完的事再做一遍。
    ws = worktree_state()
    if ws:
        st, stat = ws
        p += ["", "【⚠工作区已经有未提交的改动 —— 动手前先看】",
              "这些改动**不一定是你写的**:可能是上一次尝试留下的半成品,也可能是别的线正在做的活。",
              "共享 worktree,所以先读再动手——**不要假设文件是干净的**。",
              "", "```", st[:1500], "```"]
        if stat:
            p += ["", "```", stat[:800], "```"]
        p += ["", "怎么办:①先读相关文件的现状 ②如果是你这张卡该做的、且已经做对了,"
              "就在证据里说明「这部分上一轮已完成」并继续剩下的 ③如果不是你的活,别碰。"]
    return "\n".join(p)


def transcript_of(session_id):
    """~/.claude/projects/<由 cwd 派生的 slug>/<sid>.jsonl。自己拼 slug 不如 glob 耐腐。"""
    if not session_id: return None
    base = os.path.join(os.path.expanduser("~"), ".claude", "projects")
    hits = glob.glob(os.path.join(base, "*", session_id + ".jsonl"))
    return hits[0] if hits else None


FORKED_SID = None   # 本次启动如果 fork 了,这是新的 session id(没 fork 则 None)
FORK_DONE  = False  # 本进程是否已完成继承(一个进程内不 fork 两次)


def session_args():
    """自己的转录已存在则 resume。没有的话:
       ・指定了桌面对话就 **--resume <桌面> --fork-session --session-id <新 id>**
       ・没指定就用 --session-id 新建(全新的新人)

    ⭐旧实现是用「转录文件的 mtime 差」去**猜** fork 后的新 id。那会抓到同一时刻诞生的
      别的会话 —— 并行起的别的线、用户的别的窗口、我自己的试验运行,都是污染源,
      而且抓到的 id 会被持久化进设置,于是**静默地**串线。
      实测:`--resume A --fork-session --session-id B` 可以并用,记忆继承,转录落在 B。
      既然不需要猜,就把整段扫描删掉。

    ⚠ SESSION 不能直接当 fork 目标 id —— 试验产生的空壳转录有时已经占着那个 id。
      发新 id,成功后登记到看板,再把它当作该线的 session_id。"""
    global FORKED_SID
    FORKED_SID = None
    if FORK_FROM and not FORK_DONE and transcript_of(FORK_FROM):
        FORKED_SID = str(uuid.uuid4())
        return ["--resume", FORK_FROM, "--fork-session", "--session-id", FORKED_SID]
    if SESSION and transcript_of(SESSION):
        return ["--resume", SESSION]
    if SESSION:
        return ["--session-id", SESSION]
    return []


def confirm_forked(sid):
    """把「继承了」登记到看板。**不去猜也不去找** —— id 是这边定的,早就知道。"""
    global SESSION, FORK_DONE, FORKED_SID
    FORKED_SID = None
    if not transcript_of(sid):
        # fork 本身失败了(CLI 崩了等)。登记的话就等于继承了一个不存在的会话。
        log(f"  ⚠本该继承的转录 {sid[:8]} 不在 —— 不登记(下次重来)")
        return None
    prev, SESSION, FORK_DONE = SESSION, sid, True
    s, r = call("POST", f"/api/workers/{WORKER_LINE}/forked", {"session_id": sid})
    if s == 200:
        log(f"  记忆已继承: {FORK_FROM[:8]} → 自己的 session {sid[:8]}(以后继这边)")
        return sid
    # 登记失败也在本进程内继续用新 session(不 fork 两次)。
    # 下次启动时 server 还认为「未继承」,于是会再 fork 一次。
    log(f"  ⚠fork 登记失败 {s} {r.get('error','')} —— 下次再 fork 一遍(旧 {str(prev)[:8]})")
    return None


LEDGER = os.path.join(DATA, "usage_ledger.jsonl")
LAST_ACCT = {"sid": None, "t0": None}


def usage_of(sid, since=None):
    """从转录合算本次尝试的用量。转录不存在(桩/失败)则零值+note。
    since=ISO 字符串:持续会话(槽 1)只数开始时刻之后的(要的是本次,不是累计)。"""
    out = {"calls": 0, "in": 0, "cc": 0, "cr": 0, "out": 0, "note": None}
    path = transcript_of(sid)
    if not path:
        out["note"] = "转录未见(桩或未启动)"
        return out
    try:
        for line in io.open(path, encoding="utf-8", errors="replace"):
            try: j = json.loads(line)
            except Exception: continue
            u = (j.get("message") or {}).get("usage") or {}
            if not u: continue
            ts = j.get("timestamp") or ""
            if since and ts and ts < since: continue
            out["calls"] += 1
            out["in"] += u.get("input_tokens", 0)
            out["cc"] += u.get("cache_creation_input_tokens", 0)
            out["cr"] += u.get("cache_read_input_tokens", 0)
            out["out"] += u.get("output_tokens", 0)
    except Exception as e:
        out["note"] = f"转录解析失败: {e}"
    return out


def acct_attempt(t, worker, attempt, model, effort):
    """一次尝试记一行账。

    ⭐**行里必须带 model / effort**。没有它,「有没有提权」谁都观测不到
      —— 日志会轮转掉,卡面的总计也切不出「哪一档烧了多少」。
      顶档流向了哪里能事后数得出来,靠的就是这两列。"""
    # 第二座席没有 claude 的转录 ⇒ 用判定时从 turn.completed 取到的东西。
    #   ⚠ 落到「没有转录=零值+note」的话,那些卡的用量会**全部记成 0**,
    #     账本就会撒谎说"很便宜"(空洞的绿的数据版)。
    u = LAST_ACCT.get("usage") or usage_of(LAST_ACCT["sid"], LAST_ACCT["t0"])
    row = {"ts": datetime.datetime.now().isoformat(timespec="seconds"),
           "card": t["id"], "attempt": attempt, "worker": worker,
           "model": model, "effort": effort,
           "sid": (LAST_ACCT["sid"] or "")[:8], **u}
    try:
        io.open(LEDGER, "a", encoding="utf-8").write(json.dumps(row, ensure_ascii=False) + chr(10))
    except Exception as e:
        log(f"  记账写入失败({e})—— 不阻塞交付")
    return row


def fmt_acct(rows):
    tot = {k: sum(r.get(k, 0) for r in rows) for k in ("calls", "in", "cc", "cr", "out")}
    # 档位轨迹要进卡面。只有数字的话知道「烧了 3 次」,但看不出「是一边提档一边烧的」。
    traj = " → ".join(tier_label(r.get("model"), r.get("effort")) for r in rows) or "(无)"
    return ("—— 本卡用量记账(明细在 <data>/usage_ledger.jsonl)——" + chr(10) +
            f"尝试 {len(rows)} 次 · 调用 {tot['calls']} · 输入 {tot['in']:,} · "
            f"缓存写 {tot['cc']:,} · 缓存读 {tot['cr']:,} · 输出 {tot['out']:,} tok" + chr(10) +
            f"档位轨迹: {traj}")


# ── 第二运行时座席(Codex CLI)────────────────────────────────────────────────
def codex_gate(path=None):
    """共用原生可执行文件的门;保留本函数名以兼容既有测试。"""
    return codex_runtime.gate(CODEX_CLI if path is None else path)


def assert_no_bypass(argv):
    return codex_runtime.assert_no_bypass(argv)


def codex_argv(model, effort, last_path, cli=None):
    """workspace-write 形。提示词仍以 `-` 从 stdin 进入。"""
    return codex_runtime.argv(cli or CODEX_CLI, model, effort, last_path, REPO, mode="write")


def judge_codex(rc, stdout, last_path):
    return codex_runtime.judge(rc, stdout, last_path)


def run_codex(t, worker, evidence_path, prev_tail, attempt, model, effort):
    """与主座席的 run_worker **返回同型** (rc, tail) —— handle() 不必知道座席。"""
    global LAST_ACCT
    gate = codex_gate()
    if gate:
        return -3, gate
    last_path = os.path.join(DATA, f"codex-last-{t['id']}-{attempt}.txt")
    try: os.path.isfile(last_path) and os.remove(last_path)   # 别把上次的残骸当证据
    except Exception: pass
    argv = codex_argv(model, effort, last_path)
    prompt = build_prompt(t, worker, evidence_path, prev_tail, attempt)
    env = dict(os.environ); env["PYTHONIOENCODING"] = "utf-8"
    t0 = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    try:
        w = subprocess.run(argv, input=prompt, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", env=env,
                           timeout=TIMEOUT, cwd=REPO)
    except subprocess.TimeoutExpired:
        LAST_ACCT = {"sid": None, "t0": t0, "usage": None}
        return -1, f"(codex 超时 {TIMEOUT}s 被杀)"
    except Exception as e:
        LAST_ACCT = {"sid": None, "t0": t0, "usage": None}
        return -2, f"(codex spawn 失败:{e})"
    v = judge_codex(w.returncode, w.stdout, last_path)
    LAST_ACCT = {"sid": v["thread"], "t0": t0, "usage": v["usage"]}
    tail = v["tail"] + (chr(10) + "stderr 尾: " + (w.stderr or "").strip()[-300:] if w.stderr else "")
    # 成功返 0,失败原样用 CLI 的码(码是 0 却判定 NG 时才造一个 1)
    return (0 if v["ok"] else (w.returncode if w.returncode else 1)), tail[-1500:]


def probe_runtime(live=False):
    """运行时的实地确认。**不领卡也不写看板**(只读),所以未解禁也能打
    —— 它是为了做出"可以解禁"的证据,把它关在门内就成了鸡生蛋。
    ⭐server 的 /api/workers/<线>/probe-runtime 会在**真实 spawn 环境**里起它。"""
    ok = True
    print(f"[probe] runtime = {RUNTIME}", flush=True)
    print(f"[probe] model/effort = {MODEL} / {EFFORT}", flush=True)
    if RUNTIME not in RUNTIME_SEATS:
        print(f"[probe] ⛔ 不在座席表 {RUNTIME_SEATS} 里"); return 1
    if RUNTIME == "claude":
        g = cli_gate()
        print("[probe] CLI 门: " + ("OK " + " ".join(CLAUDE) if not g else "NG" + chr(10) + g))
        if g or not live:
            return 0 if not g else 1
        # 额度窗到点的复查不能只看版本/路径,要打**最小的实调用**。只过门就解禁的话,
        # 额度其实还满,却把全槽退回原座席,同样的失败会在全局重演一遍。
        try:
            v = subprocess.run(CLAUDE + ["-p", "Reply with exactly: PROBE-OK",
                               "--model", MODEL, "--effort", EFFORT,
                               "--permission-mode", "acceptEdits",
                               "--allowedTools", "Read"],
                               capture_output=True, text=True, encoding="utf-8", errors="replace",
                               timeout=600, cwd=REPO)
        except Exception as e:
            print(f"[probe] ⛔ 实调用抛异常: {e}"); return 1
        out = ((v.stdout or "") + (v.stderr or "")).strip()
        good = v.returncode == 0 and "PROBE-OK" in out
        print(f"[probe] 实调用 rc={v.returncode} 尾={out[-400:]}")
        print("[probe] " + ("PASS" if good else "FAIL"))
        return 0 if good else 1
    print(f"[probe] 解禁 = {CODEX_RELEASED}(未解禁也能跑 probe)", flush=True)
    g = codex_gate()
    if g:
        print("[probe] ⛔ 被门拒绝:" + chr(10) + g); return 1
    print(f"[probe] 门 OK(绝对路径・实体在・非 .bat): {CODEX_CLI}", flush=True)
    try:
        v = subprocess.run([CODEX_CLI, "--version"], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=60)
        print(f"[probe] --version rc={v.returncode} {(v.stdout or '').strip()}", flush=True)
        ok = ok and v.returncode == 0
    except Exception as e:
        print(f"[probe] ⛔ --version 失败: {e}"); return 1
    last_path = os.path.join(DATA, "codex-probe-last.txt")
    argv = codex_argv(MODEL, EFFORT, last_path)          # 内部会过 bypass 守卫
    print("[probe] argv(提示词走 stdin 所以不在里面) = " + json.dumps(argv, ensure_ascii=False), flush=True)
    print("[probe] bypass 守卫 = OK(组装时已检查)", flush=True)
    if not live:
        print("[probe] " + ("PASS" if ok else "FAIL") + "(无 --live: 没做实调用)", flush=True)
        return 0 if ok else 1
    try: os.path.isfile(last_path) and os.remove(last_path)
    except Exception: pass
    os.makedirs(DATA, exist_ok=True)
    try:
        w = subprocess.run(argv, input="Reply with exactly: PROBE-OK", capture_output=True,
                           text=True, encoding="utf-8", errors="replace", timeout=600, cwd=REPO)
    except Exception as e:
        print(f"[probe] ⛔ 实调用抛异常: {e}"); return 1
    v2 = judge_codex(w.returncode, w.stdout, last_path)
    print("[probe] " + v2["tail"].replace(chr(10), chr(10) + "        "), flush=True)
    if v2["usage"]:
        u = v2["usage"]
        print(f"[probe] 用量: in={u['in']} cr={u['cr']} cc={u['cc']} out={u['out']}", flush=True)
    print("[probe] " + ("PASS" if v2["ok"] else "FAIL"), flush=True)
    return 0 if v2["ok"] else 1


def codex_selftest():
    """纯函数的单体试验(板与 CLI 都不需要)。⭐夹具取自**实测输出**。"""
    import tempfile
    n_pass = n_fail = 0

    def ok(name, cond, extra=""):
        nonlocal n_pass, n_fail
        if cond: n_pass += 1; print(f"PASS {name}")
        else: n_fail += 1; print(f"FAIL {name}  {extra}")
    FIX = (chr(10).join([
        '{"type":"thread.started","thread_id":"01a00000-0000-7000-8000-000000000000"}',
        '{"type":"turn.started"}',
        '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Skill descriptions were shortened"}}',
        '{"type":"turn.completed","usage":{"input_tokens":17114,"cached_input_tokens":4608,'
        '"cache_write_input_tokens":0,"output_tokens":63,"reasoning_output_tokens":56}}']))
    d = tempfile.mkdtemp(prefix="codexjudge_")
    good = os.path.join(d, "last.txt"); io.open(good, "w", encoding="utf-8").write("OK")
    empty = os.path.join(d, "empty.txt"); io.open(empty, "w", encoding="utf-8").write("   ")
    missing = os.path.join(d, "nope.txt")
    v = judge_codex(0, FIX, good)
    ok("① 三条齐了才算成功", v["ok"], v["tail"])
    ok("⭐item.type=error(skills 警告)不算失败", v["ok"])
    ok("② 用量映射(reasoning 已含在 out 里,不再加)",
       v["usage"] == {"calls": 1, "in": 17114, "cc": 0, "cr": 4608, "out": 63, "note": None},
       str(v["usage"]))
    ok("③ 拾到 thread_id", v["thread"] == "01a00000-0000-7000-8000-000000000000")
    ok("④ 只有退出码非零 → 失败", not judge_codex(1, FIX, good)["ok"])
    ok("⑤ 缺 turn.completed → 失败(哪怕退出码 0)",
       not judge_codex(0, '{"type":"turn.started"}', good)["ok"])
    ok("⑥ 最终消息为空 → 失败", not judge_codex(0, FIX, empty)["ok"])
    ok("⑦ 最终消息文件不存在 → 失败", not judge_codex(0, FIX, missing)["ok"])
    tf = judge_codex(1, FIX + chr(10) + '{"type":"turn.failed","error":{"message":"boom"}}', good)
    ok("⑧ turn.failed 的理由出现在尾部(指纹的材料)", "boom" in tf["tail"], tf["tail"])
    a = codex_argv("gpt-5.6-sol", "high", "C:/tmp/last.txt", cli="C:/x/codex.exe")
    ok("⑨ argv 里不含提示词(走 stdin)", a[-1] == "-" and not any("你是看板" in x for x in a))
    ok("⑩ 档位是 -c model_reasoning_effort(不是旗)",
       "-c" in a and "model_reasoning_effort=high" in a, str(a))
    ok("⭐⑪ 有 --approve-for-me,且**没有** --sandbox(实测互斥)",
       "--approve-for-me" in a and "--sandbox" not in a, str(a))
    ok("⑪b 子命令只继承 core 环境并启用默认密钥名排除",
       "shell_environment_policy.inherit=core" in a and
       "shell_environment_policy.ignore_default_excludes=false" in a, str(a))
    ok("⑪c 无头 worker 不加载用户配置、不开 web search、会话不落盘",
       "--ignore-user-config" in a and "tools.web_search=false" in a and "--ephemeral" in a, str(a))
    ro = codex_runtime.argv("C:/x/codex.exe", "gpt-5.6-sol", "xhigh", "C:/tmp/ro.txt",
                            "C:/tmp", mode="read-only", schema="C:/tmp/schema.json")
    ok("⑪d 只读形有 --sandbox read-only、无 --approve-for-me、带 output schema",
       "--sandbox" in ro and "read-only" in ro and "--approve-for-me" not in ro and
       "--output-schema" in ro, str(ro))
    try:
        assert_no_bypass(["codex", "exec", "--dangerously-bypass-approvals-and-sandbox"])
        ok("⑫ bypass 旗在组装时抛异常", False, "没有抛异常")
    except RuntimeError:
        ok("⑫ bypass 旗在组装时抛异常", True)
    ok("⑬ 门: BOARD_CODEX_CMD 空 → 拒绝", "BOARD_CODEX_CMD" in (codex_gate("") or ""))
    ok("⑭ 门: 相对路径 → 拒绝", "绝对路径" in (codex_gate("codex.exe") or ""))
    ok("⑮ 门: 实体不在 → 拒绝", "不存在" in (codex_gate(os.path.join(d, "no.exe")) or ""))
    bat = os.path.join(d, "codex.cmd"); io.open(bat, "w", encoding="utf-8").write("@echo off")
    ok("⭐⑯ 门: .cmd 因 BatBadBut 被拒", "BatBadBut" in (codex_gate(bat) or ""),
       str(codex_gate(bat))[:80])
    print(f"{chr(10)}结果: {n_pass} PASS / {n_fail} FAIL")
    return 0 if n_fail == 0 else 1


def budget_args():
    """单次调用的美元帽 argv: min(每尝试帽, 今日全局余额),下限 $1(让在途卡收尾)。
    帽=0/空 表示明示关闸 —— 关的是单次帽,全局预算的领卡前置查仍在主循环。
    ⚠ 默认关(见 gates_lib 与 INCIDENT-8):**订阅制额度不能用美元度量**。"""
    cap = os.environ.get("WORKER_MAX_BUDGET_USD", "0")
    if cap in ("0", ""):
        return []
    rem, _spent, _n, _cap = gates_lib.remaining_today(DATA)
    eff = max(1.0, min(float(cap), rem))
    return ["--max-budget-usd", "%.2f" % eff]


def run_worker(t, worker, evidence_path, prev_tail, attempt, model, effort):
    """⭐(model, effort) 是**参数**。以前直接读进程级常量,同一张卡的第 1 次和第 3 次
    必然用同一个脑子同一个强度(=静态钉死)。档位由 handle() 每次尝试决定,
    这里**只负责打出去** —— 决定点保持一处(两处决定的话,日志和真实 argv 会静默不一致)。

    ⭐座席分派就是**这一行**。handle() 不知道座席(返回同型)。
    ⚠ 提权阶梯由主座席的模型名构成 ⇒ 第二座席的槽 `slot_rung` 返回 None,
      自然落进「阶梯外=逐字沿用槽配置」这条既有分支(不需要改造,由试验钉住)。"""
    if RUNTIME == "codex":
        return run_codex(t, worker, evidence_path, prev_tail, attempt, model, effort)
    # ⚠ --allowedTools 给了明示列表就会**把 MCP 工具全部关在外面**(实测:想调 MCP 工具时
    #   卡在"需要授权",无头状态下给不出授权就死锁)。要放行就在 server 单位明示放行。
    # ⭐不给 worker Bash:执行只该由协调线做,也就是只有协调线可以 push。
    #   需要执行的卡去指名 verify_registry.json 的键,由 **loop**(协调线的代理)代跑。
    #   这样执行权和 push 权在 worker 侧一次都不出现 —— 不必依赖提示词里的「禁 push」
    #   (用结构防,不用纪律防)。
    #   ⚠卡的 needs_bash 不再增加工具。列还在,但这里不看。
    tools = ["Read", "Write", "Edit", "Glob", "Grep"]
    # 加派槽(无 session)也发明示 id —— 不发的话没人知道转录在哪,用量就**数不出来**。
    global LAST_ACCT
    sargs = session_args()
    sid_acct = FORKED_SID or SESSION
    if not sargs:
        sid_acct = str(uuid.uuid4())
        sargs = ["--session-id", sid_acct]
    LAST_ACCT = {"sid": sid_acct,
                 "t0": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")}
    argv = CLAUDE + [
        "-p", build_prompt(t, worker, evidence_path, prev_tail, attempt),
        *sargs,
        "--model", model,
        "--effort", effort,
        # 硬停止(可选): 单次帽 = min(每尝试帽, 今日余额)。
        #   实测:单卡曾跑出 147 次内部调用/2790 万缓存读,唯一的止损是 3600s 超时。
        #   --max-budget-usd 是 --print 专用,超帽 CLI 自断 → 既有的失败尾→指纹/park 承接。
        #   主循环在**领卡前**查过余额;此处再 min 一层,给同卡多次尝试之间兜底。
        *budget_args(),
        "--permission-mode", "acceptEdits",
        "--allowedTools", *tools,
        "--add-dir", REPO,
    ]
    env = dict(os.environ); env["PYTHONIOENCODING"] = "utf-8"
    try:
        w = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", env=env, timeout=TIMEOUT, cwd=REPO)
        return w.returncode, ((w.stdout or "") + (w.stderr or ""))[-1500:]
    except subprocess.TimeoutExpired:
        return -1, f"(worker 超时 {TIMEOUT}s 被杀)"
    except Exception as e:
        return -2, f"(spawn 失败:{e})"


def read_evidence(path):
    try:
        if os.path.isfile(path):
            s = io.open(path, encoding="utf-8", errors="replace").read().strip()
            return s or None
    except Exception as e:
        log(f"  证据读取失败:{e}")
    return None


def _failure_fp(vr, tail):
    """失败指纹:把数字・路径・空白规范化后取 md5 —— 同因异文面折成同一指纹。
    指纹被行号或时刻切碎的话,刹车永远不会生效(规范化才是本体)。"""
    if vr and not vr.get("ok"):
        src = "verify:%s:rc=%s:%s" % (vr.get("key"), vr.get("rc"), (vr.get("out") or "")[-400:])
    else:
        src = (tail or "")[-400:]
    # 路径折叠要认两种形:Windows 盘符形与 POSIX 绝对路径形。只认一种的话,
    # 另一个平台上带路径的报错永远折不进同一指纹,刹车在那边就是聋的。
    s0 = re.sub(r"[A-Za-z]:[\\/][^\s'\"]+|(?:/[^\s'\"/]+){2,}", "@path", src)
    s0 = re.sub(r"\d+", "#", s0)
    s0 = re.sub(r"\s+", " ", s0).strip().lower()
    return hashlib.md5(s0.encode("utf-8", "replace")).hexdigest()[:12]


def handle(t, worker):
    """一张卡的完整处置。返回时卡一定不在 in_progress(不会悬空)。"""
    tid = t["id"]
    os.makedirs(EVID, exist_ok=True)
    attempt = int(t.get("attempts", 1))
    # ⭐判定上限**只在这里**。看板只返回次数,不说"已经用尽"。
    max_att = int(t.get("max_attempts", 3))
    # ⭐判定用的是**本轮派发用掉的次数**。`attempts` 是生涯累计,被打回的卡
    #   在认领的瞬间就已经是 4/3 的脸(= 跑一次就 park)。
    #   预算每次认领都回满 —— 锚由 store.claim 打(attempts_base)。
    #   ⚠板旧、没有这一栏时落回生涯累计:**不往放松那侧落**。
    used = int(t.get("attempts_this_claim") or attempt)
    # 起点预判来自**卡的列**。板旧没这列就落到 standard(正中间)。
    weight = str(t.get("weight") or "standard")
    hb = Heartbeat(tid, worker); hb.start()
    tails = []
    fps = []           # 失败指纹的履历(本 handle 内=没有新输入的连续尝试)
    acct = []          # 本卡的用量行(证据里并记总计)
    rate_waits = 0
    try:
        while True:
            ev_path = os.path.join(EVID, f"task-{tid}-attempt-{attempt}.md")
            try: os.path.isfile(ev_path) and os.remove(ev_path)   # 别把上次残骸当证据
            except Exception: pass
            # ⭐档位在**这一处**定好,再把同一个东西发给日志・argv・账本三方。
            #   三方各读各的会出现「日志说 max 而 argv 是 high」,而且谁都看不见
            #   (观测不到的不一致必然在生产爆出来)。
            a_model, a_effort, a_rung = tier_of(weight, attempt)
            # 分子是**本轮**的次数(与预算同口径)。证据文件名保持生涯累计 ——
            #   跨派发撞名会覆盖掉上一轮的证据(见开头 EVID 那段的坑)。
            #   两者不一致 = 这是被打回后重认领的卡,只在那时并记生涯侧。
            log(f"  第 {used}/{max_att} 次尝试 [{tier_label(a_model, a_effort)}]"
                + (f"(weight={weight} 第 {a_rung + 1}/{TOP_RUNG + 1} 档)" if a_rung is not None
                   else "(槽配置在阶梯外 —— 本槽不爬梯,逐字沿用)")
                + f" → {os.path.basename(ev_path)}"
                + (f"(生涯累计第 {attempt} 次 —— 本卡被打回过,预算已回满)" if used != attempt else ""))
            rc, tail = run_worker(t, worker, ev_path, tails[-1] if tails else None, attempt,
                                  a_model, a_effort)
            log(f"  {RUNTIME} 退出 rc={rc}")
            global LAST_CARD_ID
            LAST_CARD_ID = t["id"]          # 链边界判定用(下一周回的压缩判断)
            row_acct = acct_attempt(t, worker, attempt, a_model, a_effort)
            acct.append(row_acct)
            # 全局预算记账: token→USD 估算入账(单价表在 gates_lib)。
            #   这本账约束的是**下一次开工**;单次硬止损在 --max-budget-usd。
            # ⭐⭐池不要混(实测自捕): 第二座席是**另一个池**。PRICE 表里没有的模型会被
            #   usd_of 按主座席单价估 ⇒ 别的池的消耗吃掉主座席的美元帽,**整块板误停**。
            #   ⇒ 非主座席以 usd=0 记账。
            #   ⚠这不是"它免费"的意思 —— 那侧的节奏由各自池的闸承担,而那件事**尚未装**,
            #     所以要在 note 里明写(不静默地写 0)。
            _other_pool = (RUNTIME != "claude")
            gates_lib.append_spend(DATA, f"worker:{worker}",
                                   0.0 if _other_pool else gates_lib.usd_of(row_acct, a_model),
                                   card=t["id"], model=a_model,
                                   note=("另一个池(不占主座席美元账;实际 token 在 usage_ledger)"
                                         if _other_pool else None),
                                   log=log)

            # ⭐燃料耗尽不是「失败」。既没产出、输出又自称限流的话,
            #   就不推进 attempts 而去等 —— 推进的话,到早上所有卡都会顶着
            #   「尝试用尽」的脸排在那里(不是因为难,是因为跑不了)。
            if rc != 0 and not read_evidence(ev_path) and RATE_LIMIT_PAT.search(tail or ""):
                # 进单槽等待之前先报全局。server 单写共享档,切换不了的线就停。
                report_exhausted(call, RUNTIME, tail or "", log=log)
                rate_waits += 1
                if rate_waits > RATE_MAX_WAITS:
                    log(f"  ⚠限流等待超过 {RATE_MAX_WAITS} 次 —— 不再等,转等待中")
                    call("POST", f"/api/tasks/{tid}/report",
                         {"worker": worker, "outcome": "wait",
                          "evidence": "**额度耗尽**: 限流导致长时间跑不动。"
                                      "不是本卡内容的问题 —— 额度恢复后重新放行即可。"
                                      + chr(10) + chr(10) + (tail or "")[-1200:]})
                    return "wait"
                # ⭐档位也**不动**。限流不是「能力不够」而是「跑不了」——
                #   在这里提权的话,每次燃料耗尽都会往顶档爬,用最无意义的理由烧最细的池。
                #   档位是 attempt 的函数,而这条分支不推进 attempt ⇒ 结构上原地不动。
                log(f"  ⚠疑似限流输出。**不消耗尝试次数**,等 {RATE_WAIT_SEC}s 后重打同一轮"
                    f"(累计 {rate_waits}/{RATE_MAX_WAITS} 次;档位仍 [{tier_label(a_model, a_effort)}])")
                # 心跳由另一条线程在打,等待期间不会被收回卡
                time.sleep(RATE_WAIT_SEC)
                continue
            if FORKED_SID:
                confirm_forked(FORKED_SID)
            # ⭐派生闸: 收割挪到**成功+验证通过之后**。在这之前收割的话,
            #   失败的父卡也会生子卡,每重试一次就增殖一次。
            ev = read_evidence(ev_path)

            # ⭐验证由 **loop** 跑。worker 没有执行权,所以也不可能持有"通过了"的申告
            #   —— 通过的证明由这边来做。
            #   有产出但验证挂了就不算交付(把真实输出交给下一次尝试)。
            vr = run_verify(t) if ev else None
            if vr:
                ev += chr(10) + chr(10) + fmt_verify(vr)
                log(f"  验证 {vr['key']}: " + ("通过" if vr["ok"] else f"失败 rc={vr.get('rc')}"))

            if ev and (vr is None or vr["ok"]):
                made, memo = harvest_spawned(t, worker)   # ⭐成功之后才收割
                if made and not any(isinstance(x, dict) for x in made):
                    ev += (chr(10) + chr(10) + "—— 本卡派生出的子任务卡 ——" + chr(10) +
                           "#" + " #".join(str(x) for x in made))
                if memo:
                    ev += chr(10) + chr(10) + memo
                ev += chr(10) + chr(10) + fmt_acct(acct)
                call("POST", f"/api/tasks/{tid}/report",
                     {"worker": worker, "outcome": "done", "evidence": ev})
                log(f"  #{tid} → 等待中/待验收")
                return "done"

            if vr and not vr["ok"]:
                tails.append(f"[第 {attempt} 次 验证 {vr['key']} 失败 rc={vr.get('rc')}]" + chr(10) +
                             (vr.get("out") or "")[-1500:])
            else:
                tails.append(f"[第 {attempt} 次 rc={rc}]" + chr(10) + str(tail))
            # ⭐失败指纹刹车: 同一指纹**连续 2 次**就不再烧。
            #   只要来了「新的前提」(裁定追记/依赖完成/验证变更),卡会回原线被重新认领,
            #   这个 handle 就重新开始 —— 刹车只停「零新输入的空转」。
            #
            # ⭐⭐与提权阶梯的咬合: **提权本身就是「新的前提」**。
            #   同指纹 + 更高档 = 不是「同一条路第三遍」而是「**换个脑子**再来一次」——
            #   这不是空转,所以刹车条件要加上「**且已经没有档可提**」。
            #   ⇒ 刹车的语义一毫米都没放松(空转现在照样停)。变的只是
            #     「空转」的定义改成按 **(指纹, 档位)** 的组合看。
            #   ⚠ 反过来说 **顶档同指纹 2 次 = 真正的空转** —— 那里必须停。
            #     槽配置在阶梯外(a_rung is None)时也落在「没有档可提」那侧:
            #     既然没挂阶梯,下一次就是字面意义上的同条件重复。
            fp = _failure_fp(vr, tail)
            fps.append(fp)
            no_rung_left = (a_rung is None) or (a_rung >= TOP_RUNG)
            same_fp = len(fps) >= 2 and fps[-1] == fps[-2]
            if same_fp and not no_rung_left:
                # 不停,但**不默默放过**。「刹车没生效」和「靠提权放过」在盘面上
                # 都表现为『没有 park』—— 要让它们能被区分,留在 log 里。
                log(f"  同指纹 2 次(fp={fp})但**还有档可提** —— 不刹车,"
                    f"下一次尝试提到 [{tier_label(*tier_of(weight, attempt + 1)[:2])}]")
            if same_fp and no_rung_left:
                st_memo = stash_spawn(tid, "父卡未成功(指纹刹车)")
                why = (f"**失败指纹刹车**: 第 {attempt-1}/{attempt} 两次尝试的失败指纹一致"
                       f"(fp={fp}),且**已在顶档 [{tier_label(a_model, a_effort)}] 无档可提**"
                       f"—— 换更强的脑子已经试过了,再走一遍只会烧钱,转等待中。" + chr(10) +
                       "下一次尝试的前提=裁定记录里有新指示 / 依赖卡完成 / 验证命令变化"
                       "(**提权已经用尽,不再是新前提**)。"
                       + chr(10) + chr(10) + (chr(10) + chr(10)).join(tails)
                       + ((chr(10) + chr(10) + st_memo) if st_memo else ""))
                call("POST", f"/api/tasks/{tid}/report",
                     {"worker": worker, "outcome": "wait", "evidence": why + chr(10) + chr(10) + fmt_acct(acct)})
                log(f"  #{tid} → 等待中/待裁定(指纹刹车 fp={fp})")
                return "wait"
            if used >= max_att:      # ⭐比的是**本轮**,不是生涯累计(attempt)
                st_memo = stash_spawn(tid, "父卡未成功(尝试用尽)")
                why = ((st_memo + chr(10) + chr(10)) if st_memo else "") + (f"自行尝试 {max_att} 次都没能交付,转等待中待裁定。" + chr(10) +
                       (f"(本轮派发用满 {used}/{max_att};此卡生涯累计已 {attempt} 次 —— "
                        "**预算是每次认领回满的**,累计数只作审计,不是这次没跑够的理由)" + chr(10)
                        if used != attempt else "") +
                       "原因是下面两者之一:**没产出证据文件**,或**卡指定的验证没通过**"
                       "(验证由循环执行,不是 worker 自己说的)。" + chr(10) +
                       "需要人看的是:任务是否可执行 / 说明是否缺前提 / 验证的期望是否本就不对。"
                       + chr(10) + chr(10) + (chr(10) + chr(10)).join(tails))
                call("POST", f"/api/tasks/{tid}/report",
                     {"worker": worker, "outcome": "wait", "evidence": why + chr(10) + chr(10) + fmt_acct(acct)})
                log(f"  #{tid} → 等待中/待裁定(尝试已用尽)")
                return "wait"
            s, r = call("POST", f"/api/tasks/{tid}/attempt", {"worker": worker})
            if s != 200:
                log(f"  attempt 累加被拒 {s} {r.get('error','')},转等待中")
                call("POST", f"/api/tasks/{tid}/report",
                     {"worker": worker, "outcome": "wait", "evidence": "\n\n".join(tails)})
                return "wait"
            attempt = int(r["attempts"])
            # 本轮的次数也从板拿(自己 +1 的话,板和 loop 就有了两套口径)。
            # 旧板的返回没有这一栏,只有那时才在手边推进。
            used = int(r.get("attempts_this_claim") or (used + 1))
            # 用返回的上限更新手边的值。**判定不动**(判定在上面那一处)—— 动的是材料。
            # 没有这行,max_att 会冻在 claim 那一刻的值。
            max_att = int(r.get("max_attempts", max_att))
    finally:
        hb.stop.set()
        log(f"  心跳线程停止(共 {hb.beats} 次)")


def parse_until(v):
    """截止时刻的解释。
    ・`2026-08-20T01:00`(ISO・带日期)= **绝对时刻**。已过就**立即到期**(不顺延)。
      server 总是给这个形 —— HH:MM 顺延曾造出「截止 1 分钟后重启,却跑到明天」。
    ・`01:30`(旧形)= 顺延到今天/明天。留给人手打时用。"""
    if not v: return None
    if "T" in v:
        dt = datetime.datetime.fromisoformat(v)
        if dt.tzinfo is not None: dt = dt.astimezone().replace(tzinfo=None)
        return dt
    hh, mm = (int(x) for x in v.split(":"))
    now = datetime.datetime.now()
    t = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if t <= now: t += datetime.timedelta(days=1)
    return t


LAST_CARD_ID = None      # 上一张处理过的卡(用于链边界判定)


def chain_has_open_cards():
    """上一张卡的**同一条链**里是否还有未结的卡。还有就不折叠。
    ⚠判不出来时倒向 **True(不折叠)** —— 折叠那边不可逆
      (改写了前缀之后才发现"其实还有后续"是复原不了的)。
    ⚠链的定义归板(`/api/tasks/<id>/related`)。在这边重新遍历 parent 的话,
      就有了两套定义,早晚只有一套被改。"""
    if LAST_CARD_ID is None:
        return False                      # 一张都还没做 = 不在链的中途
    try:
        s0, r0 = call("GET", f"/api/tasks/{LAST_CARD_ID}/related")
        ids = [int(i) for i in (r0.get("ids") or []) if int(i) != int(LAST_CARD_ID)]
        if not ids:
            return False
        s1, r1 = call("GET", "/api/tasks?archived=false")
        by = {int(t["id"]): t for t in (r1.get("tasks") or [])}
        open_ = [i for i in ids
                 if by.get(i) and by[i].get("status") in ("not_started", "in_progress", "waiting")
                 and by[i].get("released")]
        if open_:
            log(f"  链 #{LAST_CARD_ID} 还有未结的卡 {open_[:6]} —— 本轮不整理(到链边界才折叠)")
        return bool(open_)
    except Exception as e:
        log(f"  链边界判定失败({type(e).__name__}: {e})—— 倒向安全侧(不折叠)")
        return True


def maybe_compact(chain_open=False):
    """在卡与卡之间折叠上下文。**跑着的时候不折叠**(同一个 session 正被 CLI 抓着的时候
    打 /compact,两边的结果都不可信了)。折叠本身也要花 token,但让窗口溢出更贵
    —— 溢出之后那条线就只能靠眼前那点东西做判断了。"""
    if not SESSION:
        # 加派槽(每卡新会话)没有可折叠的东西。⚠而且 /api/context/{线}/compact 折的是
        # **槽 1 的持续会话** —— 从这里打就成了折别人的会话。默默返回才是对的。
        return
    try:
        s, r = call("GET", "/api/context")
    except Exception as e:
        log(f"  上下文取得失败({e})—— 本轮不整理"); return
    me = next((c for c in (r.get("lines") or []) if c.get("line") == WORKER_LINE), None)
    tok = (me or {}).get("tokens")
    if not isinstance(tok, int):
        log("  上下文量读不出来 —— 本轮不整理(**读不出来不等于 0**)"); return
    # ⭐只有硬顶在链的中途也无条件(让窗口溢出更贵)。
    hard = int(os.environ.get("WORKER_CTX_HARD", "600000"))
    if chain_open and tok < hard:
        return
    if tok < CTX_COMPACT_AT:
        return
    log(f"  上下文 {tok:,} tok ≥ {CTX_COMPACT_AT:,} —— 下一张卡之前先整理")
    # ⭐留个印。没有它,「压缩花了多少」就**永远无法从账本测出**
    #   (只能看到紧接着的尝试 `in` 跳高,却说不出那是压缩造成的)。
    try:
        io.open(LEDGER, "a", encoding="utf-8").write(json.dumps(
            {"ts": datetime.datetime.now().isoformat(timespec="seconds"),
             "event": "compact", "worker": WORKER_LINE, "before": tok,
             "chain_open": bool(chain_open)}, ensure_ascii=False) + chr(10))
    except Exception as e:
        log(f"  压缩印记账失败({e})—— 整理继续")
    try:
        # 压缩要让 CLI 往返一次,**几分钟**起步。默认 20s 必然读超时,
        # 未捕获的话进程会整个死掉(已实测)。等久一点,任何情况下都继续运行。
        s2, r2 = call("POST", f"/api/context/{WORKER_LINE}/compact",
                      {"note": "看板 worker: 卡与卡之间的自动整理。"
                               "该留下的是 约定・踩过的坑・已裁定的事・进行中卡片的上下文。"
                               "各张卡逐条的作业日志不需要。"},
                      timeout=900)
        log(f"  整理 {'完成' if s2 == 200 else '失败 %s' % s2}"
            + (f" → {r2.get('after'):,} tok" if isinstance(r2.get("after"), int) else ""))
    except Exception as e:
        # server 侧的压缩通常在投出去的那一刻就已经在跑(实测:超时之后它也完成了)。
        # 下一周回的 GET /api/context 会告诉我们折没折成,所以这里可以放弃。
        log(f"  整理的应答等待失败({type(e).__name__}: {e})—— 继续运行")


def main():
    global WORKER_LINE
    if "--codex-selftest" in sys.argv:      # 纯函数的单体试验(板和 CLI 都不需要)
        sys.exit(codex_selftest())
    if "--as" not in sys.argv:
        sys.exit("--as <线名> 必需(线名见 fleet.config.json 的 lines[])")
    line = sys.argv[sys.argv.index("--as") + 1]
    # 并行槽: 身份(worker)与线(line)分离。槽 1 无 --worker,两者同名 = 与单槽一致。
    worker = arg_of("--worker", line)
    # ⭐probe 在**门之前**(它是为了测量未解禁的座席,放门内就永远测不了)。
    #   只读: 不领卡・不写看板・不碰证据文件。
    if "--probe-runtime" in sys.argv:
        sys.exit(probe_runtime(live="--live" in sys.argv))
    # 座席 allowlist(未知值落拒绝侧)
    if RUNTIME not in RUNTIME_SEATS:
        print(f"[worker] 运行时 {RUNTIME} 不在座席表 {'/'.join(RUNTIME_SEATS)} —— 拒绝启动", flush=True)
        sys.exit(gates_lib.EXIT_REFUSED)
    # ⭐解禁的门(宿主明示许可制)。实装在,但没许可 ⇒ **不领卡**。
    if RUNTIME == "codex" and not CODEX_RELEASED:
        print("[worker] codex 实装已就位,但**未获解禁**(宿主明示许可制)—— 拒绝领卡。"
              + chr(10) + "  解禁前能做的只有 --probe-runtime(只读)。", flush=True)
        sys.exit(gates_lib.EXIT_REFUSED)
    # 宿主配置的门。server 在启动请求时也会拒,但**这里也放一道** ——
    #   手动执行・试验等不经 server 的路径上,同一判据同样生效才是防御的本体。
    if RUNTIME == "codex":
        g2 = codex_gate()
        if g2:
            print(g2, flush=True)
            sys.exit(gates_lib.EXIT_REFUSED)
    # ⭐CLI 的门**只在这里**(领卡之前=一张都还没跑就落下)。CLAUDE 是模块常量,
    #   运行中没有被替换的路,所以不放两道。⚠要做成按卡/运行时可换 CLI 的人:
    #   那时请把这道门一起搬过去(不要造出绕过门的路径)。
    if CLI_NOTE:
        log("ℹ " + CLI_NOTE)
    gate = cli_gate()
    if gate:
        print(gate, flush=True)
        sys.exit(gates_lib.EXIT_REFUSED)
    if ALLOW_BATCH and cli_is_batch(CLAUDE[0]):
        # 打开过这件事**一定要留记录**。默默允许的话,"试验用的逃生口"会变成常规运用。
        log(f"⚠ WORKER_ALLOW_BATCH_CLI=1 —— 明示允许了经 cmd.exe(.bat/.cmd): {CLAUDE[0]}")
        log("  提示词(=卡片正文)可能被当作 cmd.exe 的命令行解释。除测试桩外不要使用。")
    # ⭐revision 绑定门: 受闸子树的**树哈希**必须 = 已验收值(.data/accepted_rev)
    #   且子树零未提交改动 —— 脏工作区跑的代码「验收过什么」没人答得上来。
    #   与 cli_gate 同位: 领卡之前落下。逃生口=试验 harness 专用 env。
    cgate = context_lib.context_gate(REPO, ANCHOR, RUNTIME)
    if cgate:
        print(cgate, flush=True)
        sys.exit(gates_lib.EXIT_REFUSED)
    sgate = gates_lib.source_gate(CODE_ROOT, DATA, log=log, loaded_tree=LOADED_TREE)
    if sgate:
        print(sgate, flush=True)
        sys.exit(gates_lib.EXIT_REFUSED)
    WORKER_LINE = line
    interval = int(sys.argv[sys.argv.index("--interval") + 1]) if "--interval" in sys.argv else 120
    once, dry = "--once" in sys.argv, "--dry-run" in sys.argv
    until = parse_until(arg_of("--until"))
    route = sys.argv[sys.argv.index("--route") + 1] if "--route" in sys.argv else "default"
    if FORK_FROM and transcript_of(FORK_FROM):
        sess = "从桌面对话 " + FORK_FROM[:8] + " 继承记忆(首次 fork)"
    elif SESSION and transcript_of(SESSION):
        sess = "续用 " + SESSION[:8]
    elif SESSION:
        sess = "新建 " + SESSION[:8] + "(无继承)"
    else:
        sess = "无(每卡新会话)"
    # 槽配置是「起点」而不是全线固定值。启动时就写明它落在第几档
    #   —— 阶梯外(None)也要写。不写的话会静默出现「不爬梯的槽」。
    _sr = slot_rung()
    log(f"worker={worker} line={line} route={route} 槽配置={tier_label(MODEL, EFFORT)}"
        + (f"(阶梯第 {_sr + 1}/{TOP_RUNG + 1} 档 = standard 卡的起点)" if _sr is not None
           else "(⚠不在阶梯上 —— 本槽不爬梯,逐字沿用槽配置)")
        + f" 会话={sess} interval={interval}s base={BASE} dry={dry}"
        + (f" 截止={until:%m-%d %H:%M}" if until else " 截止=无(**无人值守就该加 --until**)"))

    while True:
        # 不只在启动时查:共享 worktree 入库新版本后,旧进程必须在下一次领卡前自停。
        # 同时重验锚点,避免运行中被移走后先领卡、再在组 prompt 时才发现失忆。
        cgate = context_lib.context_gate(REPO, ANCHOR, RUNTIME)
        sgate = gates_lib.source_gate(CODE_ROOT, DATA, log=log, loaded_tree=LOADED_TREE)
        if cgate or sgate:
            print(cgate or sgate, flush=True)
            return
        if dry:
            s, r = call("GET", f"/api/tasks?status=not_started&route={route}&line={line}")
            n = len([t for t in r.get("tasks", []) if t.get("released")])
            log(f"dry-run:{worker} 可领 {n} 件(归档 {r.get('archived_count')} 件不在其中)")
            return
        # ⭐压缩在**领卡前**。放在事后的话,「压缩发生之前的那张卡」要付全额。
        # ⭐折叠的位置是**链边界**而不是卡边界(账本实测):
        #   全量 36 行里 缓存读 92.6% / 缓存写 5.8% / 输入 **0.2%** ⇒ 只要缓存是热的,
        #   长上下文就便宜。贵的是**冷掉的前缀** —— 单发输入 40 万 tok
        #   (账本输入总量的 99.2% 出自那一行)。压缩会改写前缀 = **自己把它弄冷**。
        #   加上在链中途折叠的话,链内已经查明的事(文件:行・试过不行的路)会从摘要里掉,
        #   下一张卡**把同一个发现再做一遍**。⇒ 链还在就不折叠。
        try:
            maybe_compact(chain_open=chain_has_open_cards())
        except Exception as e:
            log(f"  整理时出了意外({type(e).__name__}: {e})—— 继续运行")
        if until and datetime.datetime.now() >= until:
            log(f"过了截止 {until:%H:%M} —— 不再取新卡,就此结束"
                "(在途没有卡的状态下停=不会悬空)")
            return
        # ⭐全局预算前置查: 余额见底就不领新卡 —— 在途允许收尾,新开一律等窗口。
        #   loud 报数(与用量纪律同形: 不许只说「还够/不够」)。默认此闸是关的。
        rem, spent, _n, cap = gates_lib.remaining_today(DATA)
        if RUNTIME == "claude" and rem < 1.0:
            log(f"⛔ 全局预算见底: 今日已花 ${spent:.2f} / ${cap:.2f},余 ${rem:.2f} < $1 "
                f"—— 不领新卡,睡 {max(interval, 300)}s"
                f"(账本 <data>/spend_ledger.jsonl,帽 env BOARD_GLOBAL_BUDGET_USD)")
            if once: return
            time.sleep(max(interval, 300)); continue
        try:
            s, r = call("POST", "/api/claim",
                        {"worker": worker, "line": line, "route": route, "lease_minutes": LEASE,
                         # ⭐认领时自报运行时,面板据此显示实际运行方
                         "runtime": RUNTIME})
        except RuntimeError as e:
            log(str(e)); time.sleep(min(interval, 30)); continue

        # 503(池满/全局停)不要和 204(队列空)长同一张脸 —— 池塌了的舰队日志
        #   如果显示"无可领任务",就没人会去怀疑池(说不出理由的饥饿)。
        if s == 503:
            log("⛔ 池额度门(HTTP 503): " + str((r or {}).get("error") or "pool down")
                + f" —— 不是队列空,是 server 拒发。睡 {max(interval, 120)}s")
            if once: return
            time.sleep(max(interval, 120)); continue
        if s >= 400:
            log(f"⚠ claim 异常 HTTP {s}: " + str((r or {}).get("error") or r)[:200] + f",睡 {min(interval, 60)}s")
            if once: return
            time.sleep(min(interval, 60)); continue
        if s == 204 or not r.get("task"):
            log("无可领任务" + ("(once 退出)" if once else f",睡 {interval}s"))
            if once: return
            time.sleep(interval); continue

        t = r["task"]
        log(f"领到 #{t['id']}: {t['subject']}")
        # ⚠这个 try 是为了「不把卡留在 in_progress」,线的生存保证由下面的
        #   except Exception(周回总保险)和 call() 的异常折叠承担。
        try:
            outcome = handle(t, worker)
        except Exception as e:
            # handle 自己崩了也不把卡留在 in_progress
            log(f"  处置异常:{e}")
            call("POST", f"/api/tasks/{t['id']}/report",
                 {"worker": worker, "outcome": "wait", "evidence": f"loop 自身异常:{e}"})
            outcome = "wait"
        # ⭐无论哪种结局都继续下一张。waiting 停的是那条任务链,不是这个 worker。
        if once: return
        log(f"  ({outcome})继续领下一张")


# ⭐素的 `main()` 会**在 import 的瞬间开始循环**,那样就没法只试验提示词的组装
#   (「必须跑真实输出才能验收」的一种形)。加了这个守卫,
#   `python loops/worker_loop.py --as <线>` 与 server 的启动都一点不变。
if __name__ == "__main__":
    main()
