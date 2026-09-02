#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Unified board CLI. Every line uses this; do not talk to the API with raw curl.

  P="python cli/board.py"
  $P ls [--status not_started|in_progress|waiting|done] [--line alpha] [--archived false|true|all]
  $P show <id>
  $P create --file payload.json
  $P claim --as alpha                        # pick-a-card claim (routing/locks/deps decided server-side)
  $P take  <id> --as coord                   # claim a SPECIFIC id (coordinator finishing one card)
  $P edit  <id> --file payload.json          # rewrite the card face. An in-progress card accepts ONLY a
                                             #   tail-append to description, invisible to this round's worker
  $P done  <id> --as alpha --file evidence.md   # -> waiting/review
  $P wait  <id> --as alpha --file reason.md     # -> waiting/decision (own attempts exhausted)
  $P approve|reject <id> [--file note.md] [--verify-ok]
  $P reopen <id> [--line alpha]              # done/waiting -> not_started (attempts + ruling history kept)
  $P release|hold <id>                       # release to workers / pull back into coordinator staging
  $P archive <id> [--restore|--force]
  $P lines status|start <line|all>|stop <line|all>   # worker-loop supervisor
  $P bless                                   # accept THIS tree: write the gated subtree's hash to
                                             #   <data>/accepted_rev (the revision gate compares against it)

Environment:
  BOARD_URL           board base URL                       (default http://127.0.0.1:47824)
  BOARD_DATA_DIR      data dir holding board_token         (default <repo>/core/.data)
  BOARD_CLI_RUNTIME   runtime badge stamped by claim/take  (default "cli")
  BOARD_DEFAULT_ROUTE default --route for pick-a-card claim (default "default")

Exactly four states: not_started / in_progress / waiting / done.
There is deliberately no "stuck" state — a worker that cannot produce keeps trying
on its own, and lands in waiting/decision only when its own attempts are exhausted.

A ruling can go three ways:
   empty note + approve -> done
   empty note + reject  -> not_started (back to its original line)
   NON-EMPTY note (approve OR reject) -> not_started, SAME line (the original
      worker holds the context; rerouting forced a full context rebuild = double
      burn, measured — so the card goes back to whoever was working it)
   -- text written by a human is an instruction, not a comment; if the card were
      closed anyway, nobody would be left to execute it.

CJK / non-ASCII text must travel via --file (write a file, pass its path), never
as a command-line argument: on Windows, argv passes through ANSI conversion and
UTF-8 arrives as U+FFFD (measured). The same rule covers Windows paths in card
text: a bare backslash inside inline JSON is an escape error (measured — a card
creation died on a C:\\ path), while a file passed via --file needs no escaping
gymnastics; inside JSON strings write / or a doubled backslash.
"""
import json, sys, io, os, urllib.request, urllib.error

# Python on Windows writes to PIPES in the locale code page (GBK, CP932, ...).
# Card subjects legitimately contain non-ASCII — a single CJK wave dash was enough
# to kill `ls` with UnicodeEncodeError (measured). Don't bet on every caller
# remembering PYTHONUTF8; pin it here.
for _s in (sys.stdout, sys.stderr):
    try: _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception: pass

# fleet.config.json 的部署键(port/repo/gated_subtree)回填 env 缺省 —— 部署真相
# 写一次,server 与全部客户端同读(v0.3;env 已设者永远优先)。
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "core"))
import board_env
board_env.apply()

# BOARD_PORT is honoured as a fallback — the preflight recommends it on a port
# clash, and ignoring it here would aim this client at the DEFAULT port's board.
BASE = os.environ.get("BOARD_URL") or (
    "http://127.0.0.1:" + os.environ["BOARD_PORT"] if os.environ.get("BOARD_PORT")
    else "http://127.0.0.1:47824")
HERE = os.path.dirname(os.path.abspath(__file__))
# Data-dir convention: the STORE owns it — core/.data by default (core/store.js is
# the writer of board_token). Reading a different default here once returned an
# empty token and every write 401'd while reads worked: a half-broken CLI that
# looks alive. Same env override as everything else.
DATA = os.environ.get("BOARD_DATA_DIR") or os.path.join(os.path.dirname(HERE), "core", ".data")

def _board_token():
    """Unreadable -> empty string: the request then fails 401 loudly rather than
    pretending auth was optional."""
    try:
        return io.open(os.path.join(DATA, "board_token"), encoding="utf-8").read().strip()
    except Exception:
        return ""

def call(method, path, body=None):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json; charset=utf-8",
                                          "X-Board-Token": _board_token()})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read().decode("utf-8")
            return r.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        return e.code, (json.loads(raw) if raw.strip() else {})
    except urllib.error.URLError as e:
        sys.exit(f"看板不可达({BASE}):{e.reason}\n"
                 f" → 先启动:node core/server.mjs(或设 BOARD_URL)")

def die(s, d):
    sys.exit(f"{s} {json.dumps(d, ensure_ascii=False)}")

def arg(flag, default=None):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else default

def readfile(p):
    return io.open(p, encoding="utf-8").read() if p else ""

LABEL = {"not_started": "未开始", "in_progress": "进行中",
         "waiting": "等待中", "done": "已完成"}
WF = {"review": "待验收", "confirm": "待确认", "decision": "待裁定",
      "dep": "待依赖", "rearm": "等待重审"}
# This table is deliberately the same thing written in two places: the panel
# (core/panel.html, WF_LABEL) carries its own copy. Grow only one side and the
# other displays the raw code unstyled (measured: `confirm` was the one missing).

def main():
    if len(sys.argv) < 2: sys.exit(__doc__)
    cmd = sys.argv[1]
    who = arg("--as")
    fp = arg("--file")
    tid = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2].isdigit() else None

    if cmd == "ls":
        qs = []
        for k, f in (("status", "--status"), ("line", "--line"), ("route", "--route")):
            if arg(f): qs.append(f"{k}={arg(f)}")
        qs.append("archived=" + (arg("--archived") or "false"))
        s, d = call("GET", "/api/tasks?" + "&".join(qs))
        if s >= 400: die(s, d)
        print(f"{'ID':<5} {'状态':<10} {'线':<8} {'尝试':<6} 标题")
        for t in d["tasks"]:
            st = LABEL.get(t["status"], t["status"])
            if t["status"] == "waiting" and t.get("waiting_for"):
                st += "/" + WF.get(t["waiting_for"], t["waiting_for"])
            hold = "" if t.get("released") else " [未放行]"
            att = f"{t['attempts']}/{t['max_attempts']}" if t["attempts"] else "-"
            ln = (t.get('line') or '-') + (f"(<-{t['prev_line']})" if t.get('prev_line') else "")
            print(f"{t['id']:<5} {st:<10} {ln:<8} {att:<6} {t['subject']}{hold}")
        # The default view hides archived cards — the count goes on the face of
        # every listing, so a window can never impersonate the full set.
        print(f"— 共 {len(d['tasks'])} 件 @ {BASE}" +
              (f"(另有已归档 {d['archived_count']} 件,`--archived all` 可见)"
               if d.get("archived_count") and (arg("--archived") or "false") == "false" else ""))

    elif cmd == "show":
        if not tid: sys.exit("show <id>")
        s, d = call("GET", f"/api/tasks/{tid}")
        if s >= 400: die(s, d)
        print(json.dumps(d["task"], ensure_ascii=False, indent=1))

    elif cmd == "create":
        if not fp: sys.exit("create 需要 --file payload.json")
        s, d = call("POST", "/api/tasks", json.loads(readfile(fp)))
        if s >= 400: die(s, d)
        print(f"已建 #{d['task']['id']}: {d['task']['subject']}")

    elif cmd == "claim":
        if not who: sys.exit("claim 需要 --as <线名>")
        s, d = call("POST", "/api/claim",
                    {"worker": who, "line": who,
                     "route": arg("--route", os.environ.get("BOARD_DEFAULT_ROUTE", "default")),
                     # Badge self-report: whoever runs this CLI by hand IS the
                     # runtime doing the work. Without stamping it, a card taken
                     # over by the coordinator keeps the previous automated
                     # worker's runtime badge (measured).
                     "runtime": os.environ.get("BOARD_CLI_RUNTIME", "cli")})
        if s == 204 or not d.get("task"):
            print("没有可认领的任务(路由/放行/依赖/锁 都会挡住,不是错误)"); return
        if s >= 400: die(s, d)
        t = d["task"]
        print(f"已认领 #{t['id']}(第 {t['attempts']}/{t['max_attempts']} 次): {t['subject']}")
        print(f"  证据请写到 loop 指定的 evidence_path;手动交付用"
              f" board.py done {t['id']} --as {who} --file <证据>")

    elif cmd == "take":
        # Claim a SPECIFIC id. `claim` is pick-a-card, so a coordinator that must
        # run one particular card to completion had no path through this CLI at
        # all (hit twice in practice: could not attach findings to a card, could
        # not close out a series). The server already had /api/tasks/:id/claim;
        # only the CLI mouth was missing. This exists so nobody reaches for raw
        # curl — it does NOT loosen any gate: released/deps/lock/human_gate are
        # all enforced server-side in claimById; this is a pass-through.
        if not tid or not who: sys.exit("take <id> --as <线名>")
        s, d = call("POST", f"/api/tasks/{tid}/claim",
                    {"worker": who, "line": who,
                     "runtime": os.environ.get("BOARD_CLI_RUNTIME", "cli")})  # badge: same rule as claim
        if s >= 400: die(s, d)
        t = d["task"]
        print(f"已领 #{t['id']}(第 {t['attempts']}/{t['max_attempts']} 次): {t['subject']}")
        print(f"  → 交付: board.py done {t['id']} --as {who} --file <证据>")

    elif cmd in ("done", "wait"):
        if not tid or not who: sys.exit(f"{cmd} <id> --as <线名> --file <证据/原因>")
        ev = readfile(fp)
        if not ev.strip(): sys.exit("必须用 --file 附证据(改了什么/跑了什么/输出是什么)")
        s, d = call("POST", f"/api/tasks/{tid}/report",
                    {"worker": who, "outcome": cmd, "evidence": ev})
        if s >= 400: die(s, d)
        t = d["task"]
        print(f"#{tid} → {LABEL[t['status']]}/{WF.get(t['waiting_for'], t['waiting_for'])}")

    elif cmd in ("approve", "reject"):
        if not tid: sys.exit(f"{cmd} <id> [--file note.md]")
        # `--verify-ok` is the adjudicator's declaration "I ran the registered
        # verify JUST NOW and it came back green". Linked closure (parent /
        # alternates) triggers on this alone — never on a bare approve, because
        # approve by itself only means "nobody objected", the weakest possible
        # evidence (measured). Do not pass it without having run the verify: the
        # moment you do, someone else's card closes on hollow green.
        body = {"verdict": cmd, "note": readfile(fp), "resolved_by": "human"}
        if "--verify-ok" in sys.argv: body["verify_ok"] = True
        s, d = call("POST", f"/api/tasks/{tid}/resolve", body)
        if s >= 400: die(s, d)
        print(f"#{tid} → {LABEL[d['task']['status']]}")

    elif cmd == "lines":
        # Worker-loop supervisor (POST /api/workers/<line>/<start|stop>).
        # `start all` / `stop all` walk every supervised line and keep going on
        # failure — an "already running" CONFLICT is a state, not an error.
        sub = sys.argv[2] if len(sys.argv) > 2 else ""
        tgt = sys.argv[3] if len(sys.argv) > 3 else "all"
        if sub == "status":
            s2, d2 = call("GET", "/api/workers", None)
            for w in (d2 if isinstance(d2, list) else d2.get("workers") or []):
                print(f"  {w.get('line'):8s} running={w.get('running')} desired={w.get('desired_running')}")
        elif sub in ("start", "stop"):
            s2, d2 = call("GET", "/api/workers", None)
            rows = d2 if isinstance(d2, list) else d2.get("workers") or []
            names = [w.get("line") for w in rows] if tgt == "all" else [tgt]
            for ln in names:
                st, dd = call("POST", f"/api/workers/{ln}/{sub}", {})
                print(f"  {ln:8s} {sub} -> {st} {json.dumps(dd, ensure_ascii=False)[:90]}")
        else:
            sys.exit("lines status | lines start <线|all> | lines stop <线|all>")

    elif cmd == "edit":
        # The write-path for card faces. Every time a ruling needed to be carried
        # onto an implementation card, the CLI had no mouth for it (`wait`
        # requires in_progress / `reject` requires a decision-waiting product /
        # the update endpoint existed but was unexposed). Payload = the accepted
        # shape of /api/tasks/:id/update (store.update camelCase keys: subject /
        # description / acceptance / line / route / humanGate / blockedBy ...).
        # CJK must come via --file (argv ANSI-mangles to U+FFFD on Windows).
        if not tid or not fp: sys.exit("edit <id> --file payload.json")
        s, d = call("POST", f"/api/tasks/{tid}/update", json.loads(readfile(fp)))
        if s >= 400: die(s, d)
        print(f"#{tid} 已改(subject: {d['task']['subject'][:40]}…)")
        # The one place a human actually SEES the notice: the panel's edit dialog has no
        # description box, so an in-progress append can only be made from here. A notice
        # with no consumer is a notice nobody reads.
        if d.get("notice"):
            print("注意:" + d["notice"])

    elif cmd == "bless":
        # The acceptance ritual the revision gate's refusal texts point at. One line
        # of git, but a NAMED command: the refusal can now say "run bless" and be
        # telling the truth (a blind install test hit the hash-mismatch refusal and
        # found the command it recommended did not exist — a dead end by our own map).
        import subprocess
        sub = os.environ.get("BOARD_GATED_SUBTREE", "")
        if not sub:
            sys.exit("BOARD_GATED_SUBTREE 未设 —— 先决定闸住哪棵子树(独立部署常用 \".\"=整树),再 bless")
        spec = "" if sub == "." else sub
        r = subprocess.run(["git", "rev-parse", f"HEAD:{spec}"], capture_output=True,
                           text=True, encoding="utf-8", errors="replace",
                           cwd=os.path.dirname(HERE))
        if r.returncode != 0:
            sys.exit("git rev-parse 失败:" + (r.stderr or r.stdout).strip())
        tree = r.stdout.strip()
        os.makedirs(DATA, exist_ok=True)
        io.open(os.path.join(DATA, "accepted_rev"), "w", encoding="utf-8").write(tree + chr(10))
        print(f"已 bless:{sub} = {tree}")
        print(f"  写入 {os.path.join(DATA, 'accepted_rev')} —— 在跑的旧进程不会热换代码,重启后生效")

    elif cmd in ("release", "hold"):
        if not tid: sys.exit(f"{cmd} <id>")
        s, d = call("POST", f"/api/tasks/{tid}/release", {"released": cmd == "release"})
        if s >= 400: die(s, d)
        print(f"#{tid} {'已放行(worker 可见)' if cmd == 'release' else '已收进协调待机区'}")

    elif cmd == "reopen":
        if not tid: sys.exit("reopen <id> [--line 线名]")
        s, d = call("POST", f"/api/tasks/{tid}/reopen", {"line": arg("--line")})
        if s >= 400: die(s, d)
        t = d["task"]
        print(f"#{tid} → {LABEL[t['status']]}(线={t.get('line') or '-'})"
              + ("" if d.get("changed") else " ※本来就在未开始,没动"))

    elif cmd == "archive":
        if not tid: sys.exit("archive <id>")
        s, d = call("POST", f"/api/tasks/{tid}/archive", {
            "restore": "--restore" in sys.argv,
            "force": "--force" in sys.argv,
        })
        if s >= 400: die(s, d)
        print(f"#{tid} {'已恢复' if '--restore' in sys.argv else '已归档'}")

    else:
        sys.exit(__doc__)

main()
