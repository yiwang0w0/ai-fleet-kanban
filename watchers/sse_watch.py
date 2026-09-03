# Board SSE sentry — one line per board event, for a persistent monitor.
#
# Run it under your Claude's persistent monitor (or any supervisor):
#   python watchers/sse_watch.py
# Env: BOARD_URL (default http://127.0.0.1:47824)
#
# Lesson ledger (from the origin deployment, kept because each version DIED):
#   v1 (curl|awk)  cause① Windows pipe block-buffering ate the lines;
#                  cause② wrong filter carrier (see v2).
#   v2 (python)    cause② again — the board's SSE `event:` field is ALWAYS
#                  "change"; the real event name rides in the data JSON's "type".
#   v3             cause③ an incomplete type list: verdicts (task.autoreviewed)
#                  and claims (task.claimed) were missing → five verdicts passed
#                  in ten minutes with ZERO output. A sentry that is deaf but not
#                  mute (measured).
#                  cause④ no reconnect: a server restart ended the stream and the
#                  script exited — the post stood empty.
#   v4             full enumerated type list + 10s reconnect + failures speak.
#   v5 (this)      the LIST IS ABOLISHED — cause③'s root fix. Every change event
#                  prints one line, KNOWN OR NOT; a type added server-side arrives
#                  by construction. pool.changed is compressed (alarm only when a
#                  pool is exhausted). Heartbeats/log frames never reach this
#                  stream, so there is no noise to filter.
import json
import os
import sys
import time
import urllib.request
import datetime

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
# fleet.config.json 部署键回填 env 缺省(v0.3;env 已设者优先)。
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "core"))
import board_env
board_env.apply()
BASE = os.environ.get("BOARD_URL") or (
    "http://127.0.0.1:" + os.environ["BOARD_PORT"] if os.environ.get("BOARD_PORT")
    else "http://127.0.0.1:47824")


def emit(msg):
    print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def stream_once():
    # ?as=sentry: announce what we are, so the board can MEASURE "is the
    # coordinator seat listening" (the setup guide's step 5 and the shortcut
    # request alarm both read it). A panel tab is not a sentry.
    req = urllib.request.Request(BASE + "/api/events?as=sentry",
                                 headers={"Accept": "text/event-stream"})
    with urllib.request.urlopen(req, timeout=None) as r:
        emit(f"sse 已接上 {BASE}/api/events(v5·无事件名单)")
        for raw in r:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data: "):
                continue
            try:
                d = json.loads(line[6:])
            except Exception:
                continue
            t = d.get("type") or "(untyped)"
            if t == "pool.changed":
                pools = d.get("pools") or {}
                hot = {k: v for k, v in pools.items() if v.get("exhausted_at")}
                if hot or d.get("global_stop"):
                    emit(f"⚠pool.changed 竭尽={list(hot)} global_stop={d.get('global_stop')}")
                else:
                    emit("pool.changed(各池健康)")
                continue
            if t.startswith("request."):
                # v0.5: a panel shortcut button addressed to the coordinator seat —
                # this line IS the wake-up. The seat acks first, then acts
                # (coordinator-seat skill), then dones; pending too long alarms
                # on the panel.
                emit(f"📣 {t} #{d.get('id')} {d.get('kind')} "
                     f"{json.dumps(d.get('params') or {}, ensure_ascii=False)[:120]}"
                     + (" —— 先 board.py requests ack,再按 kind 执行" if t == "request.created" else ""))
                continue
            body = json.dumps({k: v for k, v in d.items() if k != "type"},
                              ensure_ascii=False)[:130]
            emit(f"{t} {body}")


while True:
    try:
        stream_once()
        emit("⚠ SSE 流正常结束(服务端关闭?)—— 10s 后重连")
    except Exception as e:
        emit(f"⛔ SSE 断开: {e!r} —— 10s 后重连")
    time.sleep(10)
