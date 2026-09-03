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


def stalled_lines(rows):
    """线出事了 = **想跑却没在跑**(desired_running 而非 running)。
    ⭐ 判据从「有没有线在跑」改成这个,是因为前者把「操作者故意停线」当故障:
      配额见底停了线、只跑一条线、夜里全停 —— 全都会每轮报一次「疑似全停」,
      而人对此唯一的自救是把哨关掉(实测:一次部署被同一条告警刷屏到要求消音)。
      告警把人训练成关掉它,就是告警本身的失败。"""
    return sorted(w.get("line") for w in rows
                  if w.get("desired_running") and not w.get("running"))


def idle_but_wanted(rows, claimable):
    """有可领的卡,却没有任何线**想**跑 —— 这不是故障,是没开工。
    单独成条、措辞不同:操作者需要的是「你可能忘了按启动」,不是「疑似全停事故」。"""
    return claimable > 0 and not any(w.get("desired_running") for w in rows)


class AlarmThrottle:
    """同一个状态不刷屏,状态一变立刻说,恢复了告诉你。

    静默≠健康,但**重复≠信息**。持续存在的问题按轮数退避重报(1、2、4、8…,
    间隔封顶 cap 轮),每次带上「持续多久、第几次」;指纹一变(新问题/问题变了)
    立即重报;问题消失报一行恢复 —— 没有 all-clear 的告警系统,人无法判断
    「不响了」是好了还是哨死了。"""

    def __init__(self, cap_rounds=36):
        self.fp = ""
        self.rounds = 0
        self.reports = 0
        self.next_round = 1
        self.cap = max(1, cap_rounds)

    def tick(self, fp):
        """返回 ("report"|"quiet"|"clear", 第几次报, 已持续轮数)。"""
        if fp != self.fp:
            was = self.fp
            self.fp, self.rounds = fp, 1
            if fp:
                self.reports, self.next_round = 1, 2
                return ("report", 1, 1)
            self.reports, self.next_round, self.rounds = 0, 1, 0
            return ("clear", 0, 0) if was else ("quiet", 0, 0)
        if not fp:
            return ("quiet", 0, 0)
        self.rounds += 1
        if self.rounds >= self.next_round:
            self.reports += 1
            self.next_round = self.rounds + min(self.rounds, self.cap)
            return ("report", self.reports, self.rounds)
        return ("quiet", self.reports, self.rounds)


if "--selftest" in sys.argv:
    NOW = 1_000_000
    cases = [
        ("双钟皆陈旧 → 报", review_stalled(NOW, NOW - 3600, NOW - 3600) is True),
        ("实测假阳性形: 判决旧但卡刚入审 3 秒 → 不报", review_stalled(NOW, NOW - 3 * 3600, NOW - 3) is False),
        ("判决新鲜 → 不报(审阅活着)", review_stalled(NOW, NOW - 60, NOW - 3600) is False),
        ("从无判决文件 = 审阅未部署 → 永不报", review_stalled(NOW, 0, NOW - 3600) is False),
        ("卡时刻不可读 → 不报(垃圾不触警)", review_stalled(NOW, NOW - 3600, 0) is False),
    ]
    ROWS_IDLE = [{"line": "alpha", "running": False, "desired_running": False},
                 {"line": "coord", "running": False, "desired_running": False}]
    ROWS_DROP = [{"line": "alpha", "running": False, "desired_running": True},
                 {"line": "coord", "running": True, "desired_running": True}]
    ROWS_OK = [{"line": "alpha", "running": True, "desired_running": True}]
    cases += [
        ("故意停着的线(desired=False)不算异常 —— 实测被刷屏的那一条", stalled_lines(ROWS_IDLE) == []),
        ("想跑却没跑 = 异常,并点名是哪条线", stalled_lines(ROWS_DROP) == ["alpha"]),
        ("都在跑 → 无异常", stalled_lines(ROWS_OK) == []),
        ("有可领卡且没有任何线想跑 → 是「没开工」提示,不是故障", idle_but_wanted(ROWS_IDLE, 3) is True),
        ("有线想跑时不再报「没开工」", idle_but_wanted(ROWS_DROP, 3) is False),
        ("没有可领卡就不提醒开工", idle_but_wanted(ROWS_IDLE, 0) is False),
    ]
    th = AlarmThrottle(cap_rounds=4)
    seq = [th.tick("A")[0] for _ in range(9)]           # 同一问题连续 9 轮
    cases += [
        ("同一告警退避重报: 第 1、2、4、8 轮报,其余安静(不再每轮刷屏)",
         seq == ["report", "report", "quiet", "report", "quiet", "quiet", "quiet", "report", "quiet"], ),
        ("报的时候带得出「第几次、持续几轮」", th.tick("A")[1] >= 1 and th.tick("A")[2] >= 9),
    ]
    th2 = AlarmThrottle()
    th2.tick("A")
    cases += [
        ("问题变了 → 立刻重报(不被退避压住)", th2.tick("B")[0] == "report"),
        ("问题消失 → 报一行恢复(没有 all-clear 的告警不可信)", th2.tick("")[0] == "clear"),
        ("一直没问题 → 一直安静", th2.tick("")[0] == "quiet"),
    ]
    for c in cases:
        name, o = c[0], c[1]
        print(("PASS " if o else "FAIL ") + name)
    sys.exit(0 if all(c[1] for c in cases) else 1)

n = 0
alarm = AlarmThrottle()      # problems: fires loud, backs off, reports recovery
notice = AlarmThrottle()     # notes: same treatment, gentler wording
last_problems = []
while True:
    n += 1
    problems = []
    notes = []
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
        dropped = stalled_lines(rows)
        if dropped:
            problems.append(f"线掉了(想跑却没在跑): {','.join(dropped)}")
        elif idle_but_wanted(rows, claimable):
            # Not a fault — nobody pressed start. Separate wording, and it rides
            # the same throttle so it says this once, not every ten minutes.
            notes.append(f"板闲着: 有 {claimable} 张可领的卡,但没有一条线开着(要跑就在面板按启动)")
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

    # ── Say it once, then back off; say it again when it CHANGES; say when it
    #    is over. (A sentry that repeats itself every round trains its reader to
    #    silence it — measured on a live deployment.)
    held = lambda rounds: f"{int(rounds * INTERVAL / 60)} 分" if rounds > 1 else ""
    act, k, rounds = alarm.tick(" / ".join(problems))
    if act == "report":
        tail = f"(持续 {held(rounds)},第 {k} 次报)" if k > 1 else ""
        print(f"{stamp()} ⛔体检异常{tail}: " + " / ".join(problems))
    elif act == "clear":
        print(f"{stamp()} ✅体检恢复正常(之前: {' / '.join(last_problems)[:80]})")
    if problems:
        last_problems = problems

    nact, nk, nrounds = notice.tick(" / ".join(notes))
    if nact == "report":
        print(f"{stamp()} ℹ {' / '.join(notes)}" + (f"(持续 {held(nrounds)},第 {nk} 次)" if nk > 1 else ""))
    elif nact == "clear":
        print(f"{stamp()} ▶ 板不再闲着了")

    if not problems and not notes and n % 6 == 1 and n > 1:
        print(f"{stamp()} 体检平安(线 {lines_up} 在跑·进行中 {inprog}·在审 {waiting}·可领 {claimable})")
    time.sleep(INTERVAL)
