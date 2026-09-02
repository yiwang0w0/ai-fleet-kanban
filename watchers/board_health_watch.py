# -*- coding: utf-8 -*-
"""Board periodic health check, for a persistent monitor.

SILENCE IS NOT HEALTH (the structural fix behind this file): the SSE sentry only
reports EVENTS — a paralyzed board emits zero events and looks exactly like a
quiet healthy one. This watcher probes STATE on a clock:
  ① server reachable  ② gated subtree clean (claims refuse on a dirty one)
  ③ claimable cards exist but no line is running (suspected full stop)
  ④ review-queue stall (cards awaiting review, no fresh verdict files)
Anomalies print IMMEDIATELY (loud); health prints one line every 6 rounds (~1h)
so a silent watcher is distinguishable from a dead one.

Run under your Claude's persistent monitor:
  python watchers/board_health_watch.py
Env:
  BOARD_URL             board base URL         (default http://127.0.0.1:47824)
  BOARD_DATA_DIR        data dir (board_token, review verdicts)  (default <repo>/.data)
  (the tree check and data-dir default anchor the board's OWN tree — v0.3
   dropped the BOARD_REPO knob here: it aimed the check at the WORK repo on
   split deployments, which is the wrong repo for a claims-refuse gate)
  BOARD_GATED_SUBTREE   subtree whose dirtiness blocks claims — same variable the
                        source gate uses; unset = skip the tree check
  BOARD_WATCH_IGNORE_LINES  comma-separated lines deliberately stopped (their
                        claimable cards don't count toward the full-stop alarm)
  BOARD_WATCH_INTERVAL  seconds between rounds (default 600)
"""
import glob
import io
import json
import os
import subprocess
import sys
import time
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
HERE = os.path.dirname(os.path.abspath(__file__))
# fleet.config.json 部署键回填 env 缺省(v0.3;env 已设者优先)——含 gated_subtree,
# 让本哨的受闸子树检查与 server/loop 读同一处真相。
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "core"))
import board_env
board_env.apply()
# ⚠ The tree check and the data dir anchor the BOARD'S OWN tree (CODE_ROOT) —
#   NOT BOARD_REPO. The claims-refuse gate measures the board's gated subtree,
#   and the token/verdict files live under the board's core/.data. In the origin
#   deployment the board lived inside the work repo so the two were one; split
#   deployments (BOARD_REPO = the work repo) made the old BOARD_REPO anchor
#   check the WRONG repo and read tokens from a path that never existed.
CODE_ROOT = os.path.dirname(HERE)
BASE = os.environ.get("BOARD_URL") or (
    "http://127.0.0.1:" + os.environ["BOARD_PORT"] if os.environ.get("BOARD_PORT")
    else "http://127.0.0.1:47824")
DATA = os.environ.get("BOARD_DATA_DIR") or os.path.join(CODE_ROOT, "core", ".data")   # the store's default (core/store.js)
SUBTREE = os.environ.get("BOARD_GATED_SUBTREE") or ""
IGNORE_LINES = {x.strip() for x in os.environ.get("BOARD_WATCH_IGNORE_LINES", "").split(",") if x.strip()}
INTERVAL = max(30, int(os.environ.get("BOARD_WATCH_INTERVAL", "600")))


def tok():
    try:
        return io.open(os.path.join(DATA, "board_token"), encoding="utf-8").read().strip()
    except Exception:
        return ""


def get(path):
    req = urllib.request.Request(BASE + path, headers={"X-Board-Token": tok()})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))


def stamp():
    return time.strftime("[%H:%M]")


def _ts(iso):
    """updated_at → epoch seconds; unparseable → None (garbage must not alarm)."""
    try:
        import datetime as _dt
        return _dt.datetime.fromisoformat(str(iso).replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def review_stalled(now, newest_verdict, oldest_wait, threshold=2700):
    """The review-stall verdict, BOTH conditions stale (measured on the origin
    deployment: 3h idle + a card entering review 3 seconds before the probe =
    certain false alarm under the old single condition — the reviewer was alive
    and simply had had nothing to do).
      newest_verdict : mtime of the newest verdict file (0 = none seen — review
                       not deployed, never alarm; that polarity predates this fix)
      oldest_wait    : the EARLIEST entered-review timestamp among waiting cards
                       (0/None = unknown — don't alarm on what we can't date)"""
    if not newest_verdict or not oldest_wait:
        return False
    return (now - newest_verdict > threshold) and (now - oldest_wait > threshold)


if "--selftest" in sys.argv:
    NOW = 1_000_000
    cases = [
        ("双钟皆陈旧 → 报", review_stalled(NOW, NOW - 3600, NOW - 3600) is True),
        ("实测假阳性形: 判决旧但卡刚入审 3 秒 → 不报", review_stalled(NOW, NOW - 3 * 3600, NOW - 3) is False),
        ("判决新鲜 → 不报(审阅活着)", review_stalled(NOW, NOW - 60, NOW - 3600) is False),
        ("从无判决文件 = 审阅未部署 → 永不报", review_stalled(NOW, 0, NOW - 3600) is False),
        ("卡时刻不可读 → 不报(垃圾不触警)", review_stalled(NOW, NOW - 3600, 0) is False),
    ]
    for name, o in cases:
        print(("PASS " if o else "FAIL ") + name)
    sys.exit(0 if all(o for _, o in cases) else 1)

n = 0
while True:
    n += 1
    problems = []
    lines_up = claimable = inprog = waiting = -1
    waiting_review = 0
    review_oldest = 0
    try:
        d = get("/api/workers")
        rows = d if isinstance(d, list) else d.get("workers") or []
        lines_up = sum(1 for w in rows if w.get("running"))
        # A gate REFUSAL is deterministic — it never restarts itself; surface it.
        refused = [w.get("line") for w in rows
                   for s in (w.get("slots") or [])
                   if not s.get("running") and ("拒绝启动" in (s.get("tail") or "") or "refus" in (s.get("tail") or "").lower())]
        t = get("/api/tasks?archived=false")
        tasks = t.get("tasks") if isinstance(t, dict) else t
        by_id = {x["id"]: x for x in tasks}

        # Claimable mirrors the claim gates it can see from here (measured false
        # alarms taught each clause): released, task-kind, no human gate, ignored
        # lines excluded, dependencies done.
        def _claimable(x):
            if x.get("status") != "not_started" or not x.get("released"):
                return False
            if x.get("kind") != "task" or x.get("human_gate"):
                return False
            if (x.get("line") or "") in IGNORE_LINES:
                return False
            return all(by_id.get(dep, {}).get("status") == "done"
                       for dep in (x.get("blocked_by") or []))

        claimable = sum(1 for x in tasks if _claimable(x))
        inprog = sum(1 for x in tasks if x.get("status") == "in_progress")
        waiting = sum(1 for x in tasks if x.get("status") == "waiting")
        # Stall detection watches ONLY waiting_for=review — confirm means "waiting
        # on the human", where an idle reviewer is CORRECT, not dead (measured
        # false alarm).
        review_rows = [x for x in tasks if x.get("status") == "waiting"
                       and x.get("waiting_for") == "review"]
        waiting_review = len(review_rows)
        review_oldest = min((t2 for t2 in (_ts(x.get("updated_at")) for x in review_rows)
                             if t2), default=0)
        if refused:
            problems.append("门拒启动: " + ",".join(sorted(set(refused))))
        if claimable > 0 and lines_up <= 1 and inprog == 0:
            problems.append(f"可领 {claimable} 张但仅 {lines_up} 线在跑(疑似全停)")
    except Exception as e:
        problems.append(f"server 不可达: {type(e).__name__} {str(e)[:60]}")

    # Review playing dead: cards sit in review while the newest verdict file has
    # not moved for 45 minutes (measured: one card sat silent for 7 hours). The
    # carrier is the review line's verdict files; absent dir = review not deployed
    # = skip, never alarm. ⭐BOTH clocks must be stale (the verdict clock AND the
    # oldest waiting card's clock) — the single-condition form fired a measured
    # false alarm: 3h of idle made the newest verdict old, then a card entered
    # review 3 seconds before the probe.
    try:
        if waiting_review > 0:
            vs = glob.glob(os.path.join(DATA, "review", "verdict-*.json"))
            newest = max((os.path.getmtime(v) for v in vs), default=0)
            if review_stalled(time.time(), newest, review_oldest):
                problems.append(f"审阅疑似装死: {waiting_review} 卡待审(最旧已等 "
                                f"{int((time.time() - review_oldest) / 60)} 分)且 "
                                f"{int((time.time() - newest) / 60)} 分钟无新判决")
    except Exception:
        pass

    if SUBTREE:
        try:
            r = subprocess.run(["git", "status", "--short", "--", SUBTREE],
                               cwd=CODE_ROOT, capture_output=True, text=True,
                               encoding="utf-8", timeout=30)
            dirty = [l for l in (r.stdout or "").splitlines() if l.strip()]
            if dirty:
                problems.append(f"受闸子树脏 {len(dirty)} 文件(claims 将被拒): "
                                + dirty[0].strip()[:50])
        except Exception as e:
            problems.append(f"git 检查失败: {type(e).__name__}")

    if problems:
        print(f"{stamp()} ⛔体检异常: " + " / ".join(problems))
    elif n % 6 == 1 and n > 1:
        print(f"{stamp()} 体检平安(线 {lines_up} 在跑·进行中 {inprog}·在审 {waiting}·可领 {claimable})")
    time.sleep(INTERVAL)
