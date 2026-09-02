#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""verify_lib —— 卡指名验证的**唯一**执行器(worker_loop 与将来的 reviewer_loop 共用)。
写在两处必有一处腐烂。登记簿 = verify_registry.json(与 core/store.js 读**同一个文件**)。
审阅在烧模型之前也先打这里的确定性验证 —— 红了就机器打回,不烧模型。"""
import json, os, re, subprocess, sys, io, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.environ.get("BOARD_REPO", os.path.abspath(os.path.join(HERE, "..")))

def log(m): print(f"[{datetime.datetime.now():%H:%M:%S}] {m}", flush=True)

VERIFY_TIMEOUT = int(os.environ.get("WORKER_VERIFY_SEC", "900"))
# ⭐与 core/store.js 的约定一致(BOARD_VERIFY_REGISTRY || <repo>/core/verify_registry.json)。
#   路径约定分叉的后果:store 按 A 校验键、loop 按 B 找命令,卡面绿而执行 404。
REGISTRY = os.environ.get("BOARD_VERIFY_REGISTRY") or os.path.join(REPO, "core", "verify_registry.json")

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
    #   ⛔映射不了就 loud 失败,不赌 PATH。
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
