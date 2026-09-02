#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Mock runtime adapter — a fake agent CLI for demos and offline runs.

Wire it in with the loop's base-argv escape hatch (no real CLI, no tokens spent):

    WORKER_CLI_ARGV='["python","examples/mock_worker_cli.py"]' \
        python loops/worker_loop.py --as alpha --once

It accepts the same argv shape the loop uses for the real CLI (-p <prompt>,
--model, --effort, --session-id, ... — everything but -p is ignored), finds the
evidence path inside the prompt exactly where a real worker would read it, and
writes a small honest evidence file. Exit 0.

⚠ This is a DEMO adapter: it always "succeeds". It exists so the full loop —
claim → run → deliver → waiting/review → human ruling — can be walked end to end
on a fresh clone before any real CLI is configured. It is not a test stub (the
harnesses build their own) and not a template for real adapters (a real adapter
is just a real CLI; see WORKER_CLAUDE_CLI).
"""
import re
import sys
import datetime

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def main():
    prompt = ""
    if "-p" in sys.argv:
        i = sys.argv.index("-p")
        if i + 1 < len(sys.argv):
            prompt = sys.argv[i + 1]
    # The evidence path sits on the indented line after the delivery header —
    # the same contract a real worker reads.
    m = re.search(r"【怎么交付】[^\r\n]*\r?\n  ([^\r\n]+)", prompt)
    if not m:
        print("mock adapter: prompt has no delivery header — nothing to do", file=sys.stderr)
        return 3
    evidence_path = m.group(1).strip()
    card = re.search(r"任务 #(\d+)", prompt)
    subject = re.search(r"标题:([^\r\n]*)", prompt)
    body = "\n".join([
        "—— mock adapter 交付(演示用,未执行任何真实工作)——",
        f"卡片: #{card.group(1) if card else '?'} {subject.group(1).strip() if subject else ''}",
        f"时刻: {datetime.datetime.now().isoformat(timespec='seconds')}",
        "",
        "这份证据由 examples/mock_worker_cli.py 生成。它证明的是**流程通了**:",
        "认领 → 起 CLI → 写证据 → 循环代交 → 待验收。",
        "换上真 CLI(WORKER_CLAUDE_CLI)之后,这里就是真实的工作记录。",
        "",
    ])
    with open(evidence_path, "w", encoding="utf-8") as f:
        f.write(body)
    print("mock adapter: evidence written to " + evidence_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
