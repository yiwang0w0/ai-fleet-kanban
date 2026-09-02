# -*- coding: utf-8 -*-
"""Two process-level gates shared by every loop.

1) source_gate — running code is pinned to an accepted revision:
   the **gated subtree's tree hash** must equal `.data/accepted_rev` AND the
   subtree must have zero uncommitted changes before a loop may start.
   Starting workers from a dirty tree means "nobody accepted the code that is
   running" — afterwards you cannot even answer *what* was running.
   `accepted_rev` is written by the coordinator after acceptance — normally via
   `python cli/board.py bless`, equivalently:
       git rev-parse HEAD:<subtree> > <data_dir>/accepted_rev

   The anchor is the SUBTREE, not the repository HEAD (a production first-catch
   correction): in a shared repo, unrelated business commits move HEAD daily —
   pinning HEAD would hang the whole fleet on every unrelated commit. The
   subtree hash moves only when the governance code itself changes.

   Escape hatch BOARD_ALLOW_UNPINNED=1 exists for isolated test harnesses
   only; every use is logged loudly, and habitual use is a discipline breach.

2) global budget — spend_ledger.jsonl summed over the local calendar day.
   Prices are ESTIMATES (the official bill is the authority); the gate exists so
   someone brakes *before* burn-through, and estimation error is far smaller
   than the divergence of having no gate at all.
"""
import datetime
import io
import json
import os
import subprocess

# ── exit-code contract ───────────────────────────────────────────────────────
# "The gate refused to start" is NOT a crash.
#   A crash (accidental) is worth restarting with backoff; a gate refusal is
#   DETERMINISTIC — retrying without changing the environment yields the same
#   text forever. Feeding refusals to the crash ladder was measured to climb a
#   restart ladder to 457 while the same period produced ~50 real work units —
#   about 400 spawns died at the gate having produced nothing, recovery lagged
#   up to 15 minutes behind a clean tree, and the panel could only say
#   "stopped, code=2" without telling anyone WHAT was refused.
# ⇒ Refusals announce themselves with a dedicated code. The supervisor sees it,
#   does not restart, and preserves the reason.
# Do not reuse the generic error code: the supervisor's ladder harness
# deliberately manufactures crashes; if refusal and crash share a code, that
# harness would certify "refusals restart too" in green — freezing the exact
# pathology this contract removes.
EXIT_REFUSED = 3  # paired with the supervisor's REFUSED_EXIT

# ── ① revision-pinning gate ─────────────────────────────────────────────────

_UNSET = object()

# Default gated subtree; hosts override via config/env (B2: never hardcode a
# specific deployment's path into the gate itself).
DEFAULT_SUBTREE = os.environ.get("BOARD_GATED_SUBTREE", "")


def gated_tree(repo, subtree):
    """Tree hash of `HEAD:<subtree>` at this instant; (None, reason) on failure.

    Loops capture this at module load and compare each round against the
    current HEAD — so even if `accepted_rev` on disk is updated, an already
    running old process cannot impersonate the new version and keep claiming.

    ⭐ subtree "." means THE WHOLE TREE — the right anchor for a standalone
    board clone, where every commit IS a governance change. (Git's spelling of
    the root tree is the empty path `HEAD:`; `HEAD:.` is a syntax error, so the
    dot is translated here. `git status -- .` needs no translation.)
    """
    spec = "" if str(subtree) == "." else subtree
    try:
        r = subprocess.run(["git", "-C", repo, "rev-parse", f"HEAD:{spec}"],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=30)
    except Exception as e:
        return None, "%s: %s" % (type(e).__name__, e)
    if r.returncode != 0:
        return None, (r.stderr or r.stdout or "git rev-parse failed").strip()
    return (r.stdout or "").strip() or None, None


def loaded_tree_gate(current_tree, loaded_tree):
    """Pure gate: process-loaded subtree vs. current on-disk subtree.
    Unknown and stale both refuse."""
    if not loaded_tree:
        return ("[gate] REFUSED: this process could not identify the subtree it "
                "loaded at startup — refusing to claim.\n"
                "  The on-disk accepted_rev cannot prove what is in this "
                "process's memory; restart the process.")
    if loaded_tree != current_tree:
        return ("[gate] REFUSED: this process loaded a stale governance tree — "
                "refusing to continue claiming.\n"
                f"  loaded at startup = {loaded_tree}\n"
                f"  current subtree   = {current_tree}\n"
                "  accepted_rev only proves the on-disk version was accepted; "
                "it cannot hot-swap code into an old process. Restart it.")
    return None


def source_gate(repo, data_dir, subtree=None, log=print, loaded_tree=_UNSET):
    """Returns None to pass; returns the refusal text otherwise (caller prints
    it and exits EXIT_REFUSED)."""
    if os.environ.get("BOARD_ALLOW_UNPINNED", "") == "1":
        log("WARNING: BOARD_ALLOW_UNPINNED=1 — revision gate explicitly skipped "
            "(isolated test harnesses only)")
        return None
    subtree = subtree or DEFAULT_SUBTREE
    if not subtree:
        return ("[gate] REFUSED: no gated subtree configured — set it in "
                "fleet.config (gated_subtree) or BOARD_GATED_SUBTREE. An "
                "unconfigured gate must not pretend to guard anything.")
    rev_file = os.path.join(data_dir, "accepted_rev")
    try:
        accepted = io.open(rev_file, encoding="utf-8").read().strip()
    except Exception:
        return ("[gate] REFUSED: no accepted revision (%s missing/unreadable)."
                "\n  After acceptance, run: python cli/board.py bless   (equivalently: "
                "git rev-parse HEAD:%s > %s)" % (rev_file, subtree, rev_file))

    def _git(*args):
        r = subprocess.run(["git", "-C", repo, *args], capture_output=True,
                           text=True, encoding="utf-8", errors="replace",
                           timeout=30)
        return r.returncode, (r.stdout or "").strip(), (r.stderr or "").strip()

    cur, tree_err = gated_tree(repo, subtree)
    if not cur:
        return (f"[gate] REFUSED: git rev-parse failed ({tree_err}) — revision "
                "undecidable; unknown values fall on the refusing side")
    rc, dirty, err = _git("status", "--porcelain", "--", subtree)
    if rc != 0:
        return (f"[gate] REFUSED: git status failed ({err}) — tree cleanliness "
                "undecidable; refusing to start")
    if cur != accepted:
        # ⚠ This is the MOST-HIT refusal, so it must name a command that exists:
        #   a blind install test followed the old "run board bless" here and found
        #   no such command anywhere — a dead end drawn on our own map.
        return ("[gate] REFUSED: gated subtree is not the accepted version.\n"
                f"  current  = {cur}\n  accepted = {accepted}\n"
                "  Either revert the governance changes, or accept them and bless:\n"
                f"    python cli/board.py bless   (equivalently: git rev-parse HEAD:{subtree} > {rev_file})")
    if dirty:
        return ("[gate] REFUSED: gated subtree has uncommitted changes — will "
                "not start from a dirty tree:\n" + dirty + "\n"
                "  Accept & commit (or revert) first. Experiments belong in the "
                "isolated harnesses.")
    if loaded_tree is not _UNSET:
        stale = loaded_tree_gate(cur, loaded_tree)
        if stale:
            return stale
    return None

# ── ② global budget ─────────────────────────────────────────────────────────

# $/1M tokens: (input, cache write, cache read, output). Public list prices as
# of 2026-06; when prices move, this one table is the only edit site.
PRICE = {
    "claude-fable-5":   (10.0, 12.5, 1.0, 50.0),
    "claude-opus-5":    (5.0,  6.25, 0.5, 25.0),
    "claude-sonnet-5":  (3.0,  3.75, 0.3, 15.0),
    "claude-haiku-4-5": (1.0,  1.25, 0.1, 5.0),
}
# Default 0 = gate OFF (an operator ruling with a scar behind it, INCIDENT-8):
#   flat-rate subscription quota cannot be measured in USD. "Full" is detected
#   by the provider's rate-limit reply (= a failure), not predicted by a number.
#   0 does not mean "zero budget" — it means "do not use this gate". Set a
#   positive value to re-arm it (emergency use); it then works as before.
GLOBAL_BUDGET_USD = float(os.environ.get("BOARD_GLOBAL_BUDGET_USD", "0"))


def usd_of(u, model):
    """u = {'in','cc','cr','out'} token counts. Unknown models are priced as
    opus-tier (middle of the table — never accidentally cheap)."""
    p = PRICE.get(str(model)) or PRICE["claude-opus-5"]
    return (u.get("in", 0) * p[0] + u.get("cc", 0) * p[1]
            + u.get("cr", 0) * p[2] + u.get("out", 0) * p[3]) / 1e6


def _ledger_path(data_dir):
    return os.path.join(data_dir, "spend_ledger.jsonl")


def append_spend(data_dir, who, usd, card=None, model=None, note=None, log=print):
    row = {"ts": datetime.datetime.now().isoformat(timespec="seconds"),
           "who": who, "usd": round(float(usd), 4)}
    if card is not None:
        row["card"] = card
    if model:
        row["model"] = model
    if note:
        row["note"] = note
    try:
        io.open(_ledger_path(data_dir), "a", encoding="utf-8").write(
            json.dumps(row, ensure_ascii=False) + "\n")
    except Exception as e:
        log(f"WARNING: spend_ledger append failed ({e}) — one ledger row lost; "
            "next check will lean conservative")
    return row


def spent_today(data_dir):
    """Sum spent in the local calendar day. Unreadable ledger returns 0 —
    this fail-open is deliberate: day one without a ledger must not deadlock
    the board; the hard stop-loss lives at the per-call CLI budget cap, which
    does not depend on this ledger."""
    today = datetime.date.today().isoformat()
    total, n = 0.0, 0
    try:
        for line in io.open(_ledger_path(data_dir), encoding="utf-8"):
            try:
                j = json.loads(line)
            except Exception:
                continue
            if str(j.get("ts", ""))[:10] == today:
                total += float(j.get("usd", 0) or 0)
                n += 1
    except FileNotFoundError:
        pass
    except Exception:
        pass
    return total, n


def remaining_today(data_dir, cap=None):
    """Remaining budget. cap <= 0 turns the gate OFF (remaining = ∞).
    See INCIDENT-8: an estimated cap once killed a card mid-run — after letting
    it climb to the priciest model first — then locked the whole board on a
    number that never corresponded to any real payment. Flat-rate quota is
    detected by failure strings, not predicted in USD; default is therefore
    off, and the polarity of an *unknown* cap value must never fall on the
    'silently stop everything' side."""
    cap = GLOBAL_BUDGET_USD if cap is None else float(cap)
    spent, n = spent_today(data_dir)
    if cap <= 0:
        return float("inf"), spent, n, cap
    return max(0.0, cap - spent), spent, n, cap


def fmt_budget(data_dir):
    rem, spent, n, cap = remaining_today(data_dir)
    return (f"global budget: spent today ${spent:.2f} ({n} rows) / "
            f"${cap:.2f}, remaining ${rem:.2f}")

# ── selftest ─────────────────────────────────────────────────────────────────

def _selftest():
    import tempfile
    ok = True

    def chk(name, cond, extra=""):
        nonlocal ok
        print(("PASS  " if cond else "FAIL  ") + name + ((" — " + extra) if extra else ""))
        ok = ok and bool(cond)

    chk("usd_of: opus 1M output = $25",
        abs(usd_of({"out": 1_000_000}, "claude-opus-5") - 25.0) < 1e-9)
    chk("usd_of: unknown model priced as opus (never accidentally cheap)",
        abs(usd_of({"in": 1_000_000}, "no-such") - 5.0) < 1e-9)
    with tempfile.TemporaryDirectory() as td:
        rem0, _s0, _n0, _c0 = remaining_today(td, cap=0)
        chk("cap=0 → gate off (remaining=∞)", rem0 == float("inf"))
        rem0b, _s, _n, _c = remaining_today(td, cap=-5)
        chk("negative cap also off (unknown values do not fall on 'stop')",
            rem0b == float("inf"))
        rem, spent, n, cap = remaining_today(td, cap=10)
        chk("explicit positive cap works as before", spent == 0 and rem == 10)
        append_spend(td, "t", 2.5)
        append_spend(td, "t", 1.0)
        y = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()
        io.open(_ledger_path(td), "a", encoding="utf-8").write(
            json.dumps({"ts": y + "T09:00:00", "who": "t", "usd": 99}) + "\n")
        rem, spent, n, cap = remaining_today(td, cap=10)
        chk("window = local calendar day (yesterday's 99 not counted)",
            abs(spent - 3.5) < 1e-9 and n == 2, f"spent={spent}")
        chk("remaining = cap - today", abs(rem - 6.5) < 1e-9)
        append_spend(td, "t", 100)
        rem, spent, n, cap = remaining_today(td, cap=10)
        chk("over cap → remaining clamps at 0 (never negative)", rem == 0.0)
    with tempfile.TemporaryDirectory() as td:
        r = source_gate(td, td, subtree="gates", log=lambda *a: None)
        chk("source_gate: missing accepted_rev → refuse (text carries the fix)",
            r is not None and "accepted_rev" in r)
        r2 = source_gate(td, td, subtree=None, log=lambda *a: None) \
            if not DEFAULT_SUBTREE else None
        chk("source_gate: unconfigured subtree → refuse (a gate must not "
            "pretend to guard)", DEFAULT_SUBTREE or (r2 is not None and "configured" in r2))
        os.environ["BOARD_ALLOW_UNPINNED"] = "1"
        try:
            chk("source_gate: escape env → pass + loud",
                source_gate(td, td, subtree="gates", log=lambda *a: None) is None)
        finally:
            del os.environ["BOARD_ALLOW_UNPINNED"]
    chk("loaded_tree: same subtree passes", loaded_tree_gate("a" * 40, "a" * 40) is None)
    old = loaded_tree_gate("b" * 40, "a" * 40)
    chk("loaded_tree: stale process refuses and says restart",
        old is not None and "stale" in old and "estart" in old)
    chk("loaded_tree: unknown startup identity also refuses",
        loaded_tree_gate("b" * 40, None) is not None)
    repo = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    whole, werr = gated_tree(repo, ".")
    chk("gated_tree: '.' anchors the WHOLE tree (standalone-clone convention)",
        bool(whole) and len(whole) == 40, str(werr))
    sub, _serr = gated_tree(repo, "gates")
    chk("whole-tree and subtree hashes are different objects",
        bool(whole) and bool(sub) and whole != sub)
    cur, err = gated_tree(repo, "gates")
    if cur:
        chk("gated_tree: 40-char subtree identity readable on this repo",
            len(cur) == 40, cur)
    else:
        chk("gated_tree: subtree identity readable", False, err)
    print("—— gates_lib selftest " + ("all green" if ok else "HAS RED") + " ——")
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    _selftest()
