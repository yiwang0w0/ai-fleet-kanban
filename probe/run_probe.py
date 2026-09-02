#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Read-only production probe runner (v2, hardened after operator review).

  python probe/run_probe.py <probe.sql> [--agent-safe] [--json] [--allow-filtered]
  python probe/run_probe.py --key <name>        # path via probe_registry.json
  python probe/run_probe.py --selfcheck         # mutations must reliably go RED first
  python probe/run_probe.py --policy-selftest   # no DB: output-redaction gate only

v1 claimed "server-side enforced read-only" — an overstatement (caught in
review): default_transaction_read_only is only a default for new transactions,
overridable, not a permission boundary. v2's read-only is LAYERED:
  1. a dedicated read-only role (the credential IS that role);
  2. every probe = explicit `BEGIN TRANSACTION READ ONLY` → verify
     `SHOW transaction_read_only` = on → single statement → `ROLLBACK` always;
  3. single-statement is PROTOCOL-enforced: the extended query protocol rejects
     multi-statement strings server-side (v1's regex splitting is abolished —
     never parse SQL with regex to make security decisions);
  4. --selfcheck: DELETE / set_config bypass / data-modifying CTE mutations
     must be rejected with exactly SQLSTATE 25006; only then is the unlock
     mark written, and without the mark real probes refuse to run.

Credential: `<data_dir>/probe_conn`, one postgres:// line (operator-placed,
recommended to be the dedicated read-only role). Inside .gitignore territory.
Output: may contain production values → archives only under
`<data_dir>/probes/` and card evidence, never the repository.
"""
import io, json, os, sys, datetime, re, hashlib

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("BOARD_DATA_DIR") or os.path.join(HERE, ".data")
CONN_FILE = os.path.join(DATA, "probe_conn")
OK_MARK = os.path.join(DATA, "probe_selfcheck_ok")

# Probe files are honored only from allow-listed directories (paths are
# resolved before comparison — symlink/.. games don't slip through).
# Configure via BOARD_PROBE_DIRS (os.pathsep-separated); default: ./probes
# under the current working directory plus this module's own directory.
ALLOWED_DIRS = [
    os.path.abspath(p) for p in
    (os.environ.get("BOARD_PROBE_DIRS", "").split(os.pathsep)
     if os.environ.get("BOARD_PROBE_DIRS") else
     [os.path.join(os.getcwd(), "probes"), HERE])
    if p
]

# Mutation target for --selfcheck. It must be a table that EXISTS everywhere,
# because the check demands SQLSTATE 25006 exactly: a missing table (42P01) or
# a permission error (42501) would be a *fake* rejection — the environment
# being wrong must not count as the gate working. pg_catalog.pg_class exists
# in every PostgreSQL database and the read-only check fires at executor
# start, before ACLs. Override for exotic setups.
CHECK_TABLE = os.environ.get("BOARD_PROBE_CHECK_TABLE", "pg_catalog.pg_class")

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def die(m):
    sys.exit("REFUSED: " + m)

# ── driver: postgres (pg8000) ───────────────────────────────────────────────
# Driver contract (to add another database, implement these five and keep the
# polarity notes):
#   connect() -> conn                          loud failure, never silent None
#   ro_begin(conn)                             open verified read-only txn or die
#   run_one(conn, sql) -> {columns, rows}      single statement, ALWAYS rollback
#   sqlstate(exc) -> code|None                 driver error → standard code
#   whoami(conn) -> {user, bypassrls, note}    identity + visibility caveat


def connect():
    if not os.path.isfile(CONN_FILE):
        die(f"no credential file {CONN_FILE}\n   → operator places one "
            "postgres:// line (recommended: the dedicated read-only role). "
            "Inside .gitignore territory.")
    url = io.open(CONN_FILE, encoding="utf-8").read().strip()
    m = re.match(r"postgres(?:ql)?://([^:]+):([^@]+)@([^:/]+):(\d+)/([^?\s]+)", url)
    if not m:
        die("credential file is not a postgres:// connection string")
    try:
        import pg8000.native as pg
    except ImportError:
        die("pg8000 missing — pip install pg8000")
    try:
        return pg.Connection(m.group(1), host=m.group(3), port=int(m.group(4)),
                             database=m.group(5), password=m.group(2),
                             ssl_context=True, timeout=20)
    except Exception as e:
        die(f"cannot connect ({type(e).__name__}: {e})")


def ro_begin(con):
    """Explicit read-only transaction + verification. If verification fails,
    the environment is wrong — die rather than run."""
    con.run("BEGIN TRANSACTION READ ONLY")
    con.run("SET LOCAL statement_timeout = '15s'")
    ro = con.run("SHOW transaction_read_only")
    if str(ro[0][0]).lower() != "on":
        con.run("ROLLBACK")
        die("transaction_read_only verification failed — the read-only "
            "transaction did not take; refusing to execute")


def whoami(con):
    """Identity and visibility, printed atop every output. With bypassrls=off,
    "0 rows" may mean rows were FILTERED by row-level security, not that zero
    exist (measured in production: probe said all-zero, a manual run said
    thousands) — that ambiguity is never allowed to stay silent."""
    r = con.run("select current_user, (select rolbypassrls from pg_roles "
                "where rolname = current_user)")
    u, byp = r[0][0], r[0][1]
    note = "" if byp else (" WARNING: RLS not bypassed — 0 rows may be "
                           "policy-filtered, not truly zero")
    return {"user": str(u), "bypassrls": bool(byp), "note": note}


def run_one(con, sql):
    """Single-statement execution (multi-statement is rejected server-side by
    the extended query protocol). ALWAYS rolls back."""
    ro_begin(con)
    try:
        rows = con.run(sql)
        cols = [c["name"] for c in (con.columns or [])]
        return {"columns": cols,
                "rows": [[None if v is None else str(v) for v in r] for r in rows]}
    finally:
        try:
            con.run("ROLLBACK")
        except Exception:
            pass


def sqlstate(e):
    """SQLSTATE of a pg8000 DatabaseError; None when unavailable."""
    try:
        return e.args[0].get("C")
    except Exception:
        return None

# ── output-redaction gate (agent-safe) ──────────────────────────────────────

SAFE_COL = re.compile(
    r"(?:^|_)(?:count|rows?|total|exists|present|missing|duplicate|actual|expected|ok|flag|"
    r"true|false|left|bypassrls|is|has)(?:$|_)", re.I)
SAFE_VALUE = re.compile(r"^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$")


def agent_safe_result(result):
    """Agent-visible probe output is restricted to a single aggregate/boolean
    row. On refusal the caller must DROP the raw result before archiving or
    printing — a failure must not leak customer rows into evidence either."""
    cols = (result or {}).get("columns")
    rows = (result or {}).get("rows")
    if not isinstance(cols, list) or not isinstance(rows, list) or len(rows) != 1:
        return False, "result must be exactly one row"
    if len(cols) != len(rows[0]):
        return False, "column/value count mismatch"
    for c in cols:
        if not SAFE_COL.search(str(c or "")):
            return False, f"column name is not aggregate/boolean-shaped: {c}"
    for v in rows[0]:
        if v is None or isinstance(v, (bool, int, float)):
            continue
        s = str(v).strip().lower()
        if s in ("true", "false", "t", "f") or SAFE_VALUE.fullmatch(s):
            continue
        return False, "result contains non-numeric/non-boolean values"
    return True, ""


def policy_selftest():
    cases = [
        ("single aggregate row passes",
         {"columns": ["missing_count", "is_ok"], "rows": [["2", "false"]]}, True),
        ("multiple rows refused",
         {"columns": ["total"], "rows": [["1"], ["2"]]}, False),
        ("customer-looking value refused",
         {"columns": ["actual"], "rows": [["Alice Ltd"]]}, False),
        ("dangerous column name refused",
         {"columns": ["customer_name"], "rows": [["1"]]}, False),
    ]
    good = True
    for name, value, want in cases:
        got, why = agent_safe_result(value)
        ok = got is want
        good = good and ok
        print(("PASS" if ok else "FAIL"), name, ("" if got else why))
    sys.exit(0 if good else 1)

# ── mutation selfcheck (the arming gate) ────────────────────────────────────

def selfcheck():
    """The three mutation classes must be rejected with EXACTLY 25006
    (read_only_sql_transaction). "Any exception counts as rejected" was ruled
    too loose in review — a missing table (42P01), a permission error (42501)
    or a syntax error would fake a pass. Assert the code per case; any other
    code means the environment is wrong and the mark is NOT written."""
    con = connect()
    muts = [
        ("DELETE", f"delete from {CHECK_TABLE} where false"),
        ("data-modifying CTE",
         f"with x as (delete from {CHECK_TABLE} where false returning 1) "
         "select count(*) from x"),
    ]
    fails = []
    for name, sql in muts:
        try:
            run_one(con, sql)
            fails.append(f"{name}: executed successfully (must be refused with 25006)")
        except Exception as e:
            code = sqlstate(e)
            if code == "25006":
                print(f"  OK {name} refused (25006 read-only)")
            else:
                fails.append(f"{name}: code {code or type(e).__name__} != 25006 "
                             "— environment wrong, does not count as refused")
    # set_config bypass: flip the default inside the read-only txn, then try
    # to write — the write must STILL fail.
    try:
        ro_begin(con)
        try:
            con.run("select set_config('default_transaction_read_only','off', false)")
            try:
                con.run(f"delete from {CHECK_TABLE} where false")
                fails.append("set_config bypass: write succeeded after flipping the default")
            except Exception as e:
                code = sqlstate(e)
                if code == "25006":
                    print("  OK write still refused after set_config (25006)")
                else:
                    fails.append(f"set_config path: code {code or type(e).__name__} != 25006")
        finally:
            try:
                con.run("ROLLBACK")
            except Exception:
                pass
    except Exception as e:
        code = sqlstate(e)
        if code in ("25006", "42501"):
            print(f"  OK set_config path refused outright ({code})")
        else:
            fails.append(f"set_config outer path: unexpected code {code or type(e).__name__}")
    try:
        con.close()
    except Exception:
        pass
    if fails:
        try:
            os.remove(OK_MARK)
        except Exception:
            pass
        die("selfcheck RED:\n   " + "\n   ".join(fails))
    # The mark binds an environment fingerprint (review catch: a bare
    # timestamp would stay valid across a credential swap).
    con2 = connect()
    ident = whoami(con2)
    try:
        con2.close()
    except Exception:
        pass
    url = io.open(CONN_FILE, encoding="utf-8").read().strip()
    hostdb = re.sub(r"//[^@]+@", "//", url)   # strip credentials, keep host:port/db
    io.open(OK_MARK, "w", encoding="utf-8").write(json.dumps(
        {"at": datetime.datetime.now().isoformat(), "hostdb": hostdb,
         "user": ident["user"], "bypassrls": ident["bypassrls"]}, ensure_ascii=False))
    print("OK all mutation classes refused with 25006 — armed "
          "(mark bound to host/db/user/bypassrls fingerprint)")

# ── main ────────────────────────────────────────────────────────────────────

def main():
    if "--policy-selftest" in sys.argv:
        policy_selftest()
        return
    if "--selfcheck" in sys.argv:
        selfcheck()
        return
    if len(sys.argv) < 2:
        die(__doc__)
    # --key <name> resolves through probe_registry.json (coordinator-registered,
    # git-tracked). Every other gate still applies.
    if sys.argv[1] == "--key":
        if len(sys.argv) < 3:
            die("--key needs a key name")
        try:
            reg = json.load(io.open(os.path.join(HERE, "probe_registry.json"),
                                    encoding="utf-8"))
        except Exception as e:
            die(f"probe registry unreadable ({e})")
        rel = reg.get(sys.argv[2])
        if not rel or str(sys.argv[2]).startswith("_"):
            die(f"probe key '{sys.argv[2]}' not in registry (available: "
                f"{' / '.join(k for k in reg if not k.startswith('_')) or '(none)'})")
        root = os.environ.get("BOARD_TARGET_REPO", os.getcwd())
        probe = os.path.join(root, rel)
    else:
        probe = sys.argv[1]
    if not os.path.isfile(probe):
        die(f"probe file does not exist: {probe}")
    ap = os.path.abspath(probe)
    apn = os.path.normcase(os.path.normpath(ap))
    if not any(apn.startswith(os.path.normcase(os.path.normpath(d)) + os.sep)
               for d in ALLOWED_DIRS):
        die(f"probe directory not allow-listed: {ap}\n   allowed: {ALLOWED_DIRS}"
            "\n   configure BOARD_PROBE_DIRS")
    if not os.path.isfile(OK_MARK):
        die("selfcheck has not passed — arming gate closed: "
            "python probe/run_probe.py --selfcheck")
    try:
        mark = json.loads(io.open(OK_MARK, encoding="utf-8").read())
    except Exception:
        die("unlock mark is the legacy bare-timestamp form — rerun --selfcheck "
            "to generate the fingerprint-bound mark")
    sql = io.open(probe, encoding="utf-8").read()
    con = connect()
    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    ident = whoami(con)
    print(f"identity: {ident['user']} · bypassrls="
          f"{'on' if ident['bypassrls'] else 'off'}{ident['note']}")
    # Fingerprint check: credential/db/role changed → the old mark is void.
    url = io.open(CONN_FILE, encoding="utf-8").read().strip()
    hostdb = re.sub(r"//[^@]+@", "//", url)
    if mark.get("hostdb") != hostdb or mark.get("user") != ident["user"]:
        die("unlock mark does not match this environment (host/db/user changed) "
            "— rerun --selfcheck")
    # Insufficient visibility = refuse by default, not warn: "can't read" is
    # not "zero". --allow-filtered is the explicit waiver.
    if not ident["bypassrls"] and "--allow-filtered" not in sys.argv:
        die("bypassrls=off: results can be RLS-filtered into fake zeros — "
            "refusing by default. To run filtered anyway, pass --allow-filtered")
    out = {"probe": os.path.basename(probe), "at": ts, "ident": ident,
           "sql_sha256": hashlib.sha256(sql.encode("utf-8")).hexdigest(),
           "mode": "BEGIN READ ONLY + single statement + ROLLBACK"}
    print("sql_sha256:", out["sql_sha256"][:16], "…")
    try:
        out["result"] = run_one(con, sql)
    except Exception as e:
        out["error"] = f"{type(e).__name__}: {e}"
    finally:
        try:
            con.close()
        except Exception:
            pass
    if "--agent-safe" in sys.argv and out.get("result") is not None:
        safe, why = agent_safe_result(out["result"])
        if not safe:
            # Drop the raw value BEFORE archiving/printing; even a refusal must
            # not let customer rows into evidence.
            out.pop("result", None)
            out["error"] = "agent-safe output gate refused: " + why
        else:
            out["agent_safe"] = True
    os.makedirs(os.path.join(DATA, "probes"), exist_ok=True)
    arch = os.path.join(DATA, "probes",
                        f"{os.path.splitext(os.path.basename(probe))[0]}-{ts}.json")
    io.open(arch, "w", encoding="utf-8").write(json.dumps(out, ensure_ascii=False, indent=1))
    if "--json" in sys.argv:
        print(json.dumps(out, ensure_ascii=False, indent=1))
    elif out.get("error"):
        print("REFUSED:", out["error"])
    else:
        r = out["result"]
        print(" | ".join(r["columns"]))
        for row in r["rows"][:120]:
            print(" | ".join("∅" if v is None else v for v in row))
        if len(r["rows"]) > 120:
            print(f"… ({len(r['rows'])} rows total; full set in the archive)")
    print("archive:", arch)
    sys.exit(1 if out.get("error") else 0)


main()
