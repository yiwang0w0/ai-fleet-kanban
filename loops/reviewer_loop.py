#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""自动审阅 —— 轮询「等待中」,判断哪些不需要人再点一次头。

  python loops/reviewer_loop.py [--interval 90] [--once] [--limit N] [--dry-run]

为什么要有它:等待中堆的大多数东西本质上有推荐做法,人再确认一遍只是走过场。
让它替人过掉那些明摆着的,把真正需要裁定的留下来。

三条设计约束(每一条都是生产实害换来的):

1) **每次判断都开新会话**(不用 --resume)。审阅要凭这张卡自己的证据站住,
   不能靠"上一张我批了所以这张也批"的惯性。上下文不累积,也就不会被污染。

2) **不给 Edit / Bash**——审阅者改不了现有代码,也跑不了命令。这两条是结构上的:
   工具没放行就是没放行。
   ⚠ 但 Write **是**放行的(判决文件得写得出来),而 Write 在 --add-dir 范围内哪都能写。
   "只写判决文件"是**提示词约束,不是结构约束**。别把它当成保证。
   真正兜底的是:审阅者改不了代码(无 Edit)、执行不了任何东西(无 Bash),
   且它的判决只有经过 /resolve 才会变成状态——那一步在服务端,
   而它持有的 review_token **只能**以 resolved_by=auto 裁定(server 强制)。

3) **不确定就升级**。判决只有三种:approve / reject / escalate。
   碰到生产数据、migration、push、删除、花钱、或者需要人拍板的取舍,一律 escalate。
   宁可多留给人看,也不能替人批掉一个错的。
"""
import json, os, re, subprocess, sys, time, datetime, urllib.request, urllib.error, io, shutil, threading

HERE   = os.path.dirname(os.path.abspath(__file__))
CODE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(CODE_ROOT, "gates"))
sys.path.insert(0, HERE)
import gates_lib          # revision 绑定门 + 全局预算(诸 loop 共用,勿各自复写)
import codex_runtime
import context_lib
from pool_state import report_exhausted
from verify_lib import run_verify, fmt_verify, verify_registry

BASE = os.environ.get("BOARD_URL") or (
    "http://127.0.0.1:" + os.environ["BOARD_PORT"] if os.environ.get("BOARD_PORT")
    else "http://127.0.0.1:47824")
REPO   = os.environ.get("BOARD_REPO", CODE_ROOT)
LOADED_TREE, LOADED_TREE_ERROR = gates_lib.gated_tree(CODE_ROOT, gates_lib.DEFAULT_SUBTREE)
DATA   = os.environ.get("BOARD_DATA_DIR") or os.path.join(CODE_ROOT, "core", ".data")
OUTDIR = os.path.join(DATA, "review")
RUNTIME = os.environ.get("WORKER_RUNTIME", "claude")
CODEX_CLI = os.environ.get("BOARD_CODEX_CMD") or ""
CODEX_RELEASED = os.environ.get("BOARD_CODEX_RELEASED") == "1"
CODEX_SCHEMA = os.path.join(HERE, "codex_review_schema.json")
MODEL  = os.environ.get("REVIEWER_MODEL", "claude-opus-5")
EFFORT = os.environ.get("REVIEWER_EFFORT", "high")
# 并行判读数(判读=慢段可并行;落盘回主线程串行,保日志与事件顺序)。
REVIEWER_PARALLEL = max(1, int(os.environ.get("REVIEWER_PARALLEL", "3")))
# 美元帽:与 worker 移植版同一立场 —— 默认关(订阅池部署按 token 记账,美元帽会虚报)。
REVIEWER_BUDGET = os.environ.get("REVIEWER_MAX_BUDGET_USD", "0")
# 超长证据的头部逐字保留段。origin 在此接过本地小模型做溢出段摘要;开源版不携带
# 那套私有基建 —— 超长走响亮截断,截断本身写明原文字数(沉默截断曾是实害)。
VERBATIM = int(os.environ.get("REVIEWER_VERBATIM", "12000"))


def result_for_prompt(t):
    """≤VERBATIM 字=原样逐字。超长=头部逐字 + 响亮截断标记(说明还剩多少、去哪读全文)。"""
    r = str(t.get("result") or "(没有证据)")
    if len(r) <= VERBATIM:
        return r
    return (r[:VERBATIM] + chr(10) + chr(10) +
            f"—— 证据超长,此处截断(原文共 {len(r)} 字,以上为前 {VERBATIM} 字;"
            "逐字核对请 Read 卡面原文/相关文件)——")


def log(m): print(f"[{datetime.datetime.now():%H:%M:%S}] {m}", flush=True)


def _board_token():
    """审阅持 **review_token**(只能 resolve(auto)/autoreview/pools;server 强制)。
    ⚠ 不回退到 board_token —— 那是 operator 全权令牌。文件读不到 = server 旧版,
      发空令牌让 401 响亮落地。"""
    try:
        return io.open(os.path.join(DATA, "review_token"), encoding="utf-8").read().strip()
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
        raise RuntimeError(f"看板不可达({BASE}):{e.reason}") from None

# ══ 机器产出闸 ═══════════════════════════════════════════════════════════════
# origin 部署的一次全量体检(68 张已完成卡逐张查)找到的根因: 审阅**如实写下**
# 「我核实不了 / 我没有 Bash / 以实际输出为准」,然后**照样 approve**。
# `verdict=approve` 的实义退化成了「**没人反对**」。
#
# 这不是谁失职 —— 判决词汇没问题,是**判据缺一层**。所以补的不是提示词的语气,而是
# 模型判读之后的一道**不读散文的机械门**。三条设计约束:
#   ① 门只看 approve。reject / escalate 原样放过 —— 它**只能收紧,不能放宽**。
#   ② 门只会把 approve 降成 escalate,**永远不会**把什么降成 reject。判据不足 ≠ 活做错了,
#      而打回会把卡退回同一个没有执行权的 worker(体检里反复出现的空转)。
#   ③ 机器产出的可信度按**来源**分层: 循环代跑的(run_verify / 并进证据的验证块)无条件采信;
#      worker 散文里的 PASS/rc 数字,若同一份证据里自陈「一条都没跑」,则**不采信**
#      —— 那是预期值或抄来的,不是这一轮产出的。

# 验收を「条」へ割る印。①〜⑳ / 1) 1） 1. 1、 —— 行头でも文中でも拾う。
# ⛔字類は**半角と全角を両方**入れてある(卡面は両方混在する)。⚠見た目が同じ字なので
#   grep でも差が見えない —— 片方を落とすと「なぜか或る卡だけ 1 条に見える」という
#   **静かな**壊れ方をする。此処を触る時は文字数(class の要素数)を数えて確かめる事。
_ITEM_MARK = re.compile(
    r"[①-⑳]"
    r"|(?:^|(?<=[\s;；。,，、]))"
    r"[(（]?\d{1,2}[)）.．、]", re.M)

# 「この条は機械が要る」の印。動詞(走らせる)と名詞(その出力)と道具名の三系統。
#   ⛔「测试」「断言」単体は入れない —— 拾い過ぎると門が広過ぎて escalate の山になる。
_DEMAND = [
    ("要跑",   r"跑|実行|执行|运行|実測|实测|实跑|复现|重启|启动|联调"),
    ("要输出", r"输出|stdout|机器产出|日志|贴出|贴上|贴机器|rc=|PASS|FAIL|全绿|绿|截图"),
    ("点名工具", r"curl|node |npm|tsc|vite|build|git |sqlite|selftest|servertest|looptest"
                 r"|decisiontest|gatetest|decomposetest|pytest|unittest"),
]
# 機械産出の形。**loop 由来**(先頭)と**散文由来**(残り)を分けて持つ。
_EV_LOOP  = r"——\s*验证\(由循环执行"
_EV_PROSE = [
    ("PASS/FAIL 计数", r"\d+\s*(?:项|個|个|件)?\s*(?:PASS|FAIL|合格|不合格)|(?:PASS|FAIL)\s*\d+|\[OK\]|\[FAIL\]"),
    ("退出码",         r"\brc\s*=\s*-?\d+|exit(?:\s+code)?\s*[=:]\s*\d+"),
    ("报错原文",       r"Traceback \(most recent call last\)|at Object\.<anonymous>|SyntaxError:|AssertionError"),
    ("HTTP 实测码",    r"HTTP/1\.[01]\s+\d{3}|←\s*\d{3}\b"),
]
# 「今回は一つも走らせていない」の自陈。之が在る時、散文由来の数字は採らない。
_NO_RUN = (r"一条(命令)?都?没(跑|执行)|一条也没跑|零执行|零命令|没有跑过任何|什么都没跑"
           r"|跑了什么[::]\s*(零|无|没有|一条|什么都没)|未跑过任何|没跑过任何|一次都没(跑|执行)")


def acceptance_items(text):
    """验收を機械的に「条」へ割る。散文を読んで数える代わりに**数を出す**。
    ⭐印が一つも無い時は全文を 1 条として返す —— 「割れなかったから 0 条」にはしない。
      0 条にすると門が素通しになる。割れない验收こそ人が見るべき形。"""
    s = (text or "").strip()
    if not s:
        return []
    marks = [m.start() for m in _ITEM_MARK.finditer(s)]
    if not marks:
        return [s]
    head = s[:marks[0]].strip()
    # 「验收标准:」の様な見出しは条ではない。「:」は半角(U+003A)と全角(U+FF1A)の両方。
    if head and not (len(head) <= 12 and head.endswith((":", "："))):
        marks.insert(0, 0)
    out = []
    for a, b in zip(marks, marks[1:] + [len(s)]):
        seg = s[a:b].strip()
        if seg:
            out.append(seg)
    return out


def demand_tags(item):
    """この一条が機械を要求しているか。要求している理由(系統名)を返す。空 = 要求無し。"""
    return [name for name, pat in _DEMAND if re.search(pat, item or "", re.I)]


def machine_evidence(t, vr=None):
    """機械産出の有無。**来源で信頼度を分ける**(設計約束③)。"""
    r = str(t.get("result") or "")
    hits, muted = [], []
    if vr and vr.get("ok"):
        hits.append(f"循环代跑 {vr.get('key')} → rc={vr.get('rc')} 通过")
    if re.search(_EV_LOOP, r):
        hits.append("证据里有循环并进的验证块")
    no_run = bool(re.search(_NO_RUN, r))
    for name, pat in _EV_PROSE:
        m = re.search(pat, r)
        if not m:
            continue
        (muted if no_run else hits).append(f"{name}({m.group(0)[:24].strip()})")
    return {"ok": bool(hits), "hits": hits, "muted": muted, "no_run": no_run}


def suggest_verify_key(t):
    """验收/说明が登録簿の鍵を名指していれば其れを返す。**新しい鍵は作らない**
    —— 登録簿へ書くのは協調(operator)の権限動作。"""
    hay = " ".join(str(t.get(k) or "") for k in ("acceptance", "description", "subject"))
    for k in verify_registry():
        if re.search(r"\b" + re.escape(k) + r"\b", hay, re.I):
            return k
    return None


def coverage_block(t, vr=None):
    """提示词へ挿す**機械の勘定**。審阅が散文を読んで数えるのを止めさせる。
    ⚠之は判定ではなく材料 —— 判定は gate_verdict が別に撃つ。両方が同じ関数を使う。"""
    items = acceptance_items(t.get("acceptance"))
    ev = machine_evidence(t, vr)
    L = ["—— 验收逐条(机械拆分。这不是我的意见,是从卡面数出来的)——"]
    if not items:
        L.append("(卡面没有验收标准 —— 这本身值得在判决里说一句)")
    for i, it in enumerate(items, 1):
        tg = demand_tags(it)
        one = " ".join(str(it).split())[:110]
        L.append(f"[{i}] {one}" + (f"    ⚙要机器验证({'/'.join(tg)})" if tg else ""))
    n_dem = sum(1 for it in items if demand_tags(it))
    L.append(f"共 {len(items)} 条,其中要机器验证的 {n_dem} 条。")
    L.append("本卡 verify_cmd: " + (str(t.get("verify_cmd")) if t.get("verify_cmd") else "未挂(=循环没有可代跑的键)"))
    L.append("卡上机械可见的机器产出: " + ("、".join(ev["hits"]) if ev["hits"] else "**一条也没有**"))
    if ev["muted"]:
        L.append("⚠证据里出现过数字(" + "、".join(ev["muted"]) +
                 "),但同一份证据自陈「本轮一条都没跑」⇒ 那是预期值/抄来的,不算本轮产出。")
    if n_dem and not ev["ok"]:
        L.append("⛔ 机器产出闸判据: 有要机器验证的条目而卡上零机器产出 ⇒ **你不能 approve**,只能 escalate。")
    return chr(10).join(L)


def _gate_core(t, d, vr=None):
    """模型の判読の後ろに置く機械の門(機器産出閘の本体)。approve だけを見て、
    判据が足りなければ escalate へ落とす。
    ⭐模型の原判は消さずに残す(reason に併記)—— 後から「門が何を覆したか」を追える様に。
    ⚠外側に confirm 壁(_confirm_wall)が被さる —— 壁が**末尾**なのは、此処が後半で
    approve→escalate へ書換える為(先頭に置くと壁は恒緑になる)。"""
    if (d or {}).get("verdict") == "escalate":
        bad = validate_escalation(d)
        if bad:
            # 人に「文件を用意して」と頼む半成品は待确认へ出さず、原 Agent へ loud に返す。
            return {"verdict": "reject", "reason": "【裁定包机械闸】" + bad +
                    "。原 Agent 请先把可下载的完整文件备好再送审;探测类只读脚本写进仓库并在证据里"
                    "注明相对路径,由协调代跑(worker 的沙箱通常隔断外向通信,实测)。",
                    "checked": d.get("checked") or [], "summary": "", "options": [], "recommend": ""}
        return d
    if (d or {}).get("verdict") != "approve":
        return d
    items = acceptance_items(t.get("acceptance"))
    demand = [(i, it, demand_tags(it)) for i, it in enumerate(items, 1) if demand_tags(it)]
    if not demand:
        return d                      # 机器验证を要求していない卡は素通し(過度に締めない)
    ev = machine_evidence(t, vr)
    if ev["ok"]:
        return d                      # 産出が在る = 本来の approve。門は何もしない
    tid = t.get("id")
    nos = "、".join("第%d条" % i for i, _, _ in demand[:6]) + ("…" if len(demand) > 6 else "")
    orig = (d.get("reason") or "").strip()
    key = suggest_verify_key(t)
    d = dict(d)
    d["verdict"] = "escalate"
    d["gated_by"] = "machine-evidence"     # 機械が覆した印(人にも後の集計にも見える)
    d["model_verdict"] = "approve"
    d["reason"] = ("【机械闸·机器产出】验收有 %d 条要机器验证(%s),而卡上零机器产出 ⇒ 不能自动通过。"
                   % (len(demand), nos)) + ("  模型原判 approve:" + orig if orig else "")
    d["summary"] = (
        "这张卡的验收里有 %d 条要机器验证(%s),但卡面上一条机器产出都没有"
        "(没有循环代跑的验证块,也没有 PASS/rc 之类的实际输出)。\n"
        "自动审阅本来判的是「通过」,理由是:%s\n"
        "这种情况**不能算验收闭合**——不是活没做,是「谁去跑」没定。"
        % (len(demand), nos, orig[:200] or "(没写理由)"))
    if ev["muted"]:
        d["summary"] += "\n⚠证据里是有数字的(" + "、".join(ev["muted"]) + \
                        "),但同一份证据自陈本轮一条都没跑 ⇒ 那不是这轮产出的。"
    opts = []
    if key:
        opts.append({"key": "A", "title": "给本卡挂 verify_cmd=%s,让循环代跑" % key,
                     "detail": "改卡的 verify_cmd 为登记簿里已有的键 `%s`;下一轮审阅前循环会先跑它,"
                               "红了机械打回,绿了这一条就自动闭合。" % key,
                     "cost": "改卡是 operator 的权限动作(worker/审阅都不能改)。若这个键跑起来是红的,"
                             "卡会先被打回一轮。", "kind": "none", "files": []})
    else:
        opts.append({"key": "A", "title": "交回原 Agent 自主补跑验收命令后复审",
                     "detail": "原 Agent 自己跑验收点名的命令并把 stdout/rc 写进证据;跑不了的"
                               "(沙箱隔断)把只读探测脚本写进仓库注明相对路径,由协调代跑。",
                     "cost": "会再占一轮执行时间。若要常态化,可在后续把稳定命令登记为 verify_cmd。",
                     "kind": "none", "files": []})
    opts.append({"key": "B", "title": "认下静态核对,由你手动通过",
                 "detail": "你看过之后直接点通过 —— 卡会记成 resolved_by=human,与自动通过分得开。",
                 "cost": "若静态判断错了,错误会顶着「已完成」的脸留在板上,"
                         "而且没有任何机器产出可供以后回查。",
                 "kind": "none", "files": []})
    opts.append({"key": "C", "title": "改验收:把做不到的那几条切出去,只留当下能闭合的",
                 "detail": "把要活体机器的条目从本卡验收里摘掉,写清「已切给谁/什么时候跑」,剩下的当场闭合。",
                 "cost": "会多一张卡(或一个待办),而且摘条目要留痕 —— 不留痕就是偷偷放宽验收。",
                 "kind": "none", "files": []})
    d["options"] = opts
    d["recommend"] = "A"
    log(f"  #{tid} ⛔机械闸(机器产出): 模型判 approve,但验收 {len(demand)} 条要机器验证而零产出 → 转 escalate")
    return d


def _to_reject(d, why):
    return {"verdict": "reject", "reason": why,
            "checked": (d or {}).get("checked") or [],
            "summary": "", "options": [], "recommend": ""}


def _confirm_wall(t, d, vr):
    """confirm 壁 —— 「人が実行を確認した直後の一輪」は構造上二終局のみ。
    結案できる出口は **approve × 本輪 verify 緑** ただ一つ。escalate は一律 reject へ
    降格(人へ回問しない —— 人は今裁定したばかり)。
    ⚠confirm_pending が読めない時は壁不発火 = 従来挙動(不結案側)へ退回。"""
    if t.get("confirm_pending"):
        green = bool(vr and vr.get("ok"))
        v = (d or {}).get("verdict")
        if v == "approve" and not green:
            return _to_reject(d, "【机械闸·confirm】用户的执行回执是**自述**,不是机器产出;"
                "本轮也没有绿色的机器验证(本卡 verify_cmd=%s)⇒ 不能凭它结案。"
                "请在原线跑出机器产出再送审。审阅原判 approve:%s"
                % (t.get("verify_cmd") or "无", ((d or {}).get("reason") or "")[:200]))
        if v == "escalate":
            return _to_reject(d, "【机械闸·confirm】人刚刚给过最终裁定(方案 %s,回执已附),"
                "同一个问题不再回问 ⇒ 交回原线补齐机器产出。审阅原判 escalate:%s"
                % ((t.get("decision_receipt") or {}).get("option") or "?",
                   ((d or {}).get("reason") or "")[:300]))
    return d


def gate_verdict(t, d, vr=None):
    """機械門の合成: 機器産出閘の**後**に confirm 壁。順序が承重(逆にすると壁は恒緑)。"""
    return _confirm_wall(t, _gate_core(t, d, vr), vr)


def human_decision_block(t):
    """confirm 輪の**材料**(判定は gate 側·此処は提示詞に事実を並べるだけ)。
    confirm_pending が偽なら "" —— 普通卡の提示詞は一字も変わらない。"""
    if not t.get("confirm_pending"):
        return ""
    r = t.get("decision_receipt") or {}
    files = r.get("files") or []
    flines = "".join("  - %s  sha256=%s  status=%s\n"
                     % (f.get("name"), f.get("sha256"), f.get("status")) for f in files)
    at = r.get("at") or "?"
    ago = ""
    try:
        import datetime as _dt
        _t0 = _dt.datetime.fromisoformat(str(at).replace("Z", "+00:00"))
        ago = "(距今 %d 分)" % int((_dt.datetime.now(_dt.timezone.utc) - _t0).total_seconds() // 60)
    except Exception:
        pass
    return ("\n—— 人的最终裁定与执行回执(confirm 轮)——\n"
            "方案: %s   结果: %s\n"
            "回执(逐字): %s\n"
            "补充指示(逐字): %s\n"
            "%s"
            "回执时刻: %s %s\n"
            "⚠这是**用户自述**的回执,不是看板核实过的事实。\n"
            "⚠本轮的机械规则(gate 层强制,先告知你): ①approve 只在本轮机器验证为绿时成立,"
            "否则机械降为 reject;②escalate 会被机械降为 reject(人刚给过裁定,不再回问)。\n"
            % (r.get("option") or "?", r.get("outcome") or "?",
               r.get("receipt") or "(空)", r.get("said") or "(无)",
               flines, at, ago))


def line_anchor_block(t):
    """卡の line に対応する**線圧縮アンカー**の冒頭を提示詞へ(lineage.json —— 形は
    examples/lineage.example.json)。材料であって門ではない —— 読めない/線に anchor
    無しは ""(fail-open が正極性: 之は判定材料の追加であって安全判定ではない)。"""
    line = t.get("line") or ""
    try:
        with open(os.path.join(DATA, "lineage.json"), encoding="utf-8") as f:
            lg = json.load(f)
        path = ((lg.get(line) or {}).get("anchor")) or ""
        if not path:
            return ""
        with open(os.path.join(REPO, path), encoding="utf-8") as f:
            head = f.read(1600)
        return ("\n—— 该线的压缩锚(域记忆·%s 冒头)——\n" % path) + head + "\n(…锚点全文在仓库,可 Read)\n"
    except Exception:
        return ""
# ══════════════════════════════════════════════════════════════════════════

def validate_escalation(d):
    """结构化裁定包的机械门。返回空串=合法;否则返回可直接交回 Agent 的理由。
    ⭐路径准入(允许目录/受保护目录/链接逃逸)不在这里重复 —— 那是 server 侧
    resolveAttachment 的**唯一**判据;这里只查结构完整与文件存在,双拷贝=必然分叉。"""
    opts = d.get("options") if isinstance(d, dict) else None
    if not isinstance(opts, list) or len(opts) != 3:
        return "escalate 必须给出三个完整方案"
    if not str(d.get("summary") or "").strip(): return "escalate 缺少面向人的摘要"
    keys = []
    for o in opts:
        if not isinstance(o, dict): return "方案不是对象"
        k = str(o.get("key") or "").upper(); keys.append(k)
        if any(not str(o.get(f) or "").strip() for f in ("title", "detail", "cost")):
            return f"方案 {k or '?'} 的标题/做法/代价没有写完整"
        kind = o.get("kind"); files = o.get("files")
        if kind not in ("none", "apply"):
            return f"方案 {k or '?'} 缺少合法 kind(none/apply)"
        if not isinstance(files, list): return f"方案 {k or '?'} 的 files 不是数组"
        if kind == "none" and files:
            return f"方案 {k or '?'} 标为 none 却附了文件"
        if kind == "apply" and not files:
            return f"方案 {k or '?'} 涉及需人手应用的修改却没有可下载文件"
        for f in files:
            if not isinstance(f, dict): return f"方案 {k or '?'} 的附件格式不完整"
            rel = str(f.get("path") or "").replace("\\", "/")
            if f.get("role") not in ("apply", "rollback", "companion") or not str(f.get("label") or "").strip():
                return f"方案 {k or '?'} 的附件缺少 label 或合法 role"
            if os.path.isabs(rel):
                return f"方案 {k or '?'} 的附件必须是仓库相对路径"
            if not os.path.isfile(os.path.join(REPO, *rel.split("/"))):
                return f"方案 {k or '?'} 的附件文件不存在: {rel}"
    if sorted(keys) != ["A", "B", "C"]:
        return "方案键必须恰好是 A/B/C"
    if str(d.get("recommend") or "").upper() not in keys:
        return "recommend 必须指向 A/B/C 中的一项"
    return ""


PROMPT = """你是任务看板的**自动审阅**。判断这张「等待中」的卡能不能直接放行,不必再劳烦人。

你**不做这张卡的活**。你只读证据、下判断。

—— 卡 ——
#{id}  {subject}
等待类型:{wf}   尝试:{attempts}/{max_attempts}   线:{line}
说明:
{description}
{acceptance}
—— worker 交回的证据 / 原因 ——
{result}
{confirm}{anchor}{coverage}
—— 判断规则 ——
判决只有三种,输出为 JSON:

* `approve` —— 活已经做完且证据站得住:说明里要求的事做了,验收标准满足,证据里有**机器产出**
  (实际命令与输出、文件:行、数字),不是只有"我做完了"的自述。
* `reject` —— 明确没做到或做错了,而且**下一步怎么做是显然的**。note 里写清楚哪儿不对、
  重做时该注意什么(这条会原样交给 worker)。
* `escalate` —— 需要人来定。**拿不准就选这个。**
* ⭐**机器产出闸**: 验收里凡是要「跑 / 输出 / 全绿 / 实测」的条目,卡上必须有**对应的机器产出**
  (循环代跑的验证块、PASS 计数、rc、报错原文)。一条都没有 ⇒ **不许 approve**,只能 escalate,
  并在 options 里写清**谁去跑**。
  「我核实不了,但静态看下来没问题」——这句话配 approve,正是全量体检里反复出现的形。
  ⚠上面【验收逐条】是**机械拆的**,不是我的意见。你可以在 reason 里指出它拆错了(比如把
  「参考实现」误当成要跑的条目),但**不能无视它**。而且: 就算你还是判了 approve,
  这道门在你之后也会机械地把它降成 escalate —— 与其被降,不如你自己把「谁去跑」写清楚。
* ⭐盘点/总当类的口子: 验收或正文里出现「另行分卡」「可分割」「转派担当线」这类写法 =
  给队列开了**无终结条件**的口子(实测: 这类卡是抛卡繁殖器)。
  不要按原样 approve —— escalate,方案里给出**收窄**(明确的完成边界),并注明:
  后续卡不得挂在盘点卡之下,须回根重开。「测得无则写无即可关」是正面范本。
  选这个时**必须**额外写 summary / options / recommend 三项(见下面的输出格式)——
  人看到的是这几项,不是你的推理过程。

**必须 escalate,不许自作主张的:**
- 碰生产数据、DB migration、删除、push、花钱、凭证/密钥
  ⚠ 若卡处于「人刚确认执行成功」的状态(下方有 confirm 轮材料块),escalate 会被
  机械降级为 reject —— 你要判的是**应用之后**本卡验收能否闭合,不是要不要 apply。
- 卡本身就在问"该选哪个方案"这类取舍
- 等待类型是 decision(worker 自行尝试用尽后求助)且卡住的原因是缺前提/缺授权
- 证据里的关键结论你无法从证据本身核实,而这个结论错了代价很大
- 影响到别的线或共享文件,而你看不到那边的状态

**审阅纪律:**
- 允许你用 Read/Glob/Grep 去核对证据里提到的文件是否真的长那样——证据是自述,文件是实物。
- 证据里说"跑了 X 得到 Y",你无法验证 Y 就别当真;这种情况看这个结论重不重要:
  不重要可以 approve,重要就 escalate。
- 别因为写得漂亮就批。也别因为写得短就毙。
{tool_discipline}
  `checked` 里每一条都要写清**凭什么知道的**,
  格式是「载体 → 看到了什么」,例如
  「Read core/store.js → `const VALID_STATUS = new Set(STATUS)` 在」。
  ⛔**别在这里写行号**。行号是会腐烂的证据(origin 部署实测: 样板里的 `:37-39`
    两天后就指向了别的常量,**看上去还像那么回事**)。
    指位置用**名字**(函数名/常量名),要更准就附 grep:`grep -n VALID_STATUS <file>`。
  **不许把推断写成命令输出的样子**(比如写"git diff 的结果是…"——你跑不了 git)。
  从文件读到的就写「Read <文件> → …」。自己想的就写「推断:…」。混淆这两者,比看漏还糟。

—— 输出 ——
{delivery}

内容是一个 JSON 对象,不要包在代码块里:

{{"verdict":"approve|reject|escalate",
  "reason":"给人看的一两句话,说清凭什么",
  "checked":["载体 → 看到了什么"],
  "summary":"仅 escalate 必填。用大白话两三句说清:现在卡在哪、为什么需要人。不要术语堆砌,不要复述任务说明。假设读的人几小时没看这张卡了。",
  "options":[
    {{"key":"A","title":"一句话方案名","detail":"具体做什么","cost":"代价/风险/会牵动什么","kind":"none|apply","files":[]}},
    {{"key":"B","title":"...","detail":"...","cost":"...","kind":"none","files":[]}},
    {{"key":"C","title":"...","detail":"...","cost":"...","kind":"none","files":[]}}
  ],
  "recommend":"A"}}

关于 options(只在 escalate 时要):
- **给三个**。想不出三个真实可行的,就把第三个写成「维持现状 / 先不动」并说明代价——
  「不动」永远是一个真实选项,而且常常是对的。
- 每个都要能直接执行,不要写「再研究一下」这种非方案。
- recommend 填 A/B/C 之一,**必须选一个**。你比读的人更清楚细节,别把选择成本原样丢回去。
- 如果某个方案会碰生产数据/迁移/删除/花钱,在它的 cost 里**明确写出来**。
- 方案若包含接下来要**人手应用**的文件修改,`kind` 必须是 `apply`,并在 `files` 列出已经
  存在的完整文件;每项格式为
  `{{"path":"仓库相对路径","label":"给人看的名字","role":"apply|rollback|companion","archive_name":"落盘名"}}`。
  不能只给片段、不能让人自行拼、不能引用不存在的文件。
  文件没备好时应 reject 交回原 Agent,不得把半成品放进 A/B/C。
- `none` 方案的 `files` 必须是空数组。用户点击 apply 方案的确认,含义是"我已经执行过";
  面板随后只做归档,不会替用户执行任何东西。
"""

def family_block(t):
    """派生関係を判断材料に載せる。⭐親卡の再審は「子卡の結果」が新証拠 —— 之を見せずに
    再審させると、前回と同じ材料で同じ判決が出るだけで、再審の意味が無い。"""
    try:
        s, r = call("GET", f"/api/tasks/{t['id']}/related")
        rows = r.get("tasks") or []
    except Exception:
        return ""
    byid = {x["id"]: x for x in rows}
    kids = [x for x in rows if x.get("parent_id") == t["id"]]
    anc, cur, g = [], byid.get(t.get("parent_id")), 0
    while cur and g < 10:
        anc.insert(0, cur); cur = byid.get(cur.get("parent_id")); g += 1
    L = []
    if anc:
        L.append("本卡派生自: " + " → ".join("#%s(%s)" % (a["id"], str(a["subject"])[:24]) for a in anc))
    if kids:
        L.append("本卡派生出的子任务卡(⭐重审时,已完成子任务卡的**结果**就是新证据,必须纳入判断;"
                 "还没完成的子任务卡不要替它下结论):")
        for k in sorted(kids, key=lambda x: x["id"]):
            st = k["status"] + ("/" + k["waiting_for"] if k.get("waiting_for") else "")
            L.append("  #%s [%s] %s" % (k["id"], st, str(k["subject"])[:60]))
            if k["status"] == "done" and k.get("result"):
                L.append("    结果摘录: " + " ".join(str(k["result"]).split())[:300])
    return (chr(10) + chr(10) + "—— 派生关系 ——" + chr(10) + chr(10).join(L)) if L else ""


def _resolve_claude_cli():
    """审阅的 CLI 解析:REVIEWER_CLI_ARGV(JSON 数组,整条 argv —— 测试与 mock 的钥匙)
    → WORKER_CLAUDE_CLI(绝对路径,doctor 已验形)→ PATH 上的 claude(拒 .cmd/.bat 包装,
    BatBadBut 门与 worker 同则)。都没有 = 响亮拒启,不猜。"""
    if os.environ.get("REVIEWER_CLI_ARGV"):
        v = json.loads(os.environ["REVIEWER_CLI_ARGV"])
        if not (isinstance(v, list) and v):
            raise ValueError("REVIEWER_CLI_ARGV 必须是非空 JSON 数组")
        return v
    p = os.environ.get("WORKER_CLAUDE_CLI") or shutil.which("claude") or ""
    if not p:
        return None
    if re.search(r"\.(cmd|bat|ps1)$", p, re.I):
        # PATH 通常只给包装器;拒绝并指路(与 worker/doctor 同一判据)。
        log(f"⛔ {p} 是包装器脚本(BatBadBut 门拒绝)—— 把 WORKER_CLAUDE_CLI 指向原生可执行文件")
        return None
    return [p]


def review_one(t, vr=None):
    os.makedirs(OUTDIR, exist_ok=True)
    out = os.path.join(OUTDIR, f"verdict-{t['id']}.json")
    try:
        if os.path.isfile(out): os.remove(out)     # 前回の判決を今回の物と誤認しない
    except Exception: pass
    if RUNTIME == "codex":
        delivery = ("只在最终回复返回一个 JSON 对象,不要写文件、不要包代码块、不要附解释。"
                    "六个字段必须全部出现;approve/reject 时 summary 可为空、options 可为 []、recommend 可为空。")
        tool_discipline = (
            "- ⭐你处在 read-only 沙箱,可以用只读命令核对仓库实物,但不能修改文件。"
            "绝对不得读取或搜索 .env/.env.*、看板数据目录(board_token/worker_token/review_token 所在)"
            "或真实业务数据;若证据只能靠这些内容核实,必须 escalate。")
    else:
        delivery = f"只做一件事:用 Write 工具把判决写进这个文件,别的什么都不要动。\n\n  {out}"
        tool_discipline = "- ⭐你没有 Bash,跑不了任何命令。"
    prompt = PROMPT.format(
        id=t["id"], subject=t["subject"], wf=t.get("waiting_for") or "-",
        attempts=t.get("attempts"), max_attempts=t.get("max_attempts"),
        line=t.get("line") or "-",
        description=(t.get("description") or "(无)") + family_block(t),
        acceptance=("验收标准:\n" + t["acceptance"] + "\n") if t.get("acceptance") else "",
        result=result_for_prompt(t), delivery=delivery, tool_discipline=tool_discipline,
        confirm=human_decision_block(t), anchor=line_anchor_block(t),
        # ⭐緑の検証も見せる —— origin の初版は run_verify が通った時、其の出力を**捨てて**
        #   いた(赤の時だけ使う)。審阅からは「検証が在って通った」事が見えず、其の卡の
        #   approve は結局散文だけを根拠にしていた。
        coverage=chr(10) + coverage_block(t, vr) +
                 ((chr(10) + chr(10) + "—— 本轮循环已代跑的验证(机器产出,可直接采信)——" +
                   chr(10) + fmt_verify(vr)) if (vr and vr.get("ok")) else ""))
    ctx = context_lib.prompt_block(REPO, None, RUNTIME)
    if ctx:
        prompt = chr(10).join(ctx + ["", prompt])
    env = dict(os.environ); env["PYTHONIOENCODING"] = "utf-8"
    if RUNTIME == "codex":
        try:
            argv = codex_runtime.argv(CODEX_CLI, MODEL, EFFORT, out, REPO,
                                       mode="read-only", schema=CODEX_SCHEMA)
            r = subprocess.run(argv, input=prompt, capture_output=True, text=True, encoding="utf-8",
                               errors="replace", env=env, timeout=900, cwd=REPO)
        except Exception as e:
            return None, f"(Codex 审阅进程失败:{e})"
        cv = codex_runtime.judge(r.returncode, r.stdout, out)
        codex_runtime.append_usage(DATA, "reviewer", MODEL, EFFORT, cv, card=t["id"], log=log)
        tail = (cv["tail"] + ("\nstderr 尾: " + (r.stderr or "")[-300:] if r.stderr else ""))[-1200:]
        if r.returncode != 0 and report_exhausted(call, "codex", tail, log=log):
            return None, f"(Codex 服务限流,已上报全局池状态)rc={r.returncode}\n{tail}"
        if not cv["ok"]:
            return None, f"(Codex 审阅没有闭合成功判据)\n{tail}"
        raw = cv["last"]
    else:
        cli = _resolve_claude_cli()
        if not cli:
            return None, "(找不到可用的 claude CLI —— 设 WORKER_CLAUDE_CLI 或 REVIEWER_CLI_ARGV)"
        argv = cli + ["-p", prompt, "--model", MODEL, "--effort", EFFORT,
                      *(["--max-budget-usd", REVIEWER_BUDGET]
                        if REVIEWER_BUDGET not in ("0", "") else []),
                      "--output-format", "json", "--permission-mode", "acceptEdits",
                      "--allowedTools", "Read", "Glob", "Grep", "Write",
                      "--add-dir", REPO, "--add-dir", OUTDIR]
        try:
            r = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8",
                               errors="replace", env=env, timeout=900, cwd=REPO)
            tail = ((r.stdout or "") + (r.stderr or ""))[-600:]
        except Exception as e:
            return None, f"(审阅进程失败:{e})"
        if r.returncode != 0 and report_exhausted(call, "claude", tail, log=log):
            return None, f"(Claude 额度耗尽,已上报全局池状态)rc={r.returncode}\n{tail}"
        if str(REVIEWER_BUDGET) not in ("0", ""):
            try:
                j0 = json.loads((r.stdout or "").strip().splitlines()[-1])
                usd, note = float(j0["total_cost_usd"]), None
            except Exception:
                usd, note = float(REVIEWER_BUDGET), "按帽保守计(stdout 无 total_cost_usd)"
            gates_lib.append_spend(DATA, "reviewer", usd, card=t["id"], model=MODEL, note=note, log=log)
        if not os.path.isfile(out):
            return None, f"(没写出判决文件)rc={r.returncode}\n{tail}"
        raw = io.open(out, encoding="utf-8", errors="replace").read().strip()
    m = re.search(r"\{.*\}", raw, re.S)          # 万一代码块で包まれても拾う
    try:
        d = json.loads(m.group(0) if m else raw)
    except Exception as e:
        return None, f"(判决不是合法 JSON:{e})\n{raw[:300]}"
    if d.get("verdict") not in ("approve", "reject", "escalate"):
        return None, f"(未知判决 {d.get('verdict')!r})"
    return d, None


def judge_one(t):
    """一枚の卡に対する判読の**全経路**。("mech_reject"|"model", 中身, err, vr) を返す。
    ⭐main の中の閉包ではなく module 関数なのは、**試験から撃てる形**にする為。
    ⭐vr を返すのは origin の実バグの修正: 旧形は vr が main へ戻らず、審阅経由の
      resolve に verify_ok が一度も乗らなかった —— 聯動結案(機械緑が引金)が審阅路径で
      恒久不発だった。効果断言の隣に前提断言を(vr が戻らなければ緑は「起きていない」)。
    経路は三段で、順序に意味が在る:
      ① 卡が指名した検証を先に撃つ —— 赤なら模型を焼かずに機械打回。
      ② 模型が読む(緑の検証出力と逐条の勘定を渡す)。
      ③ 模型の approve に機器産出の機械闸を掛ける —— 判据が足りなければ escalate へ落とす。"""
    vr = run_verify(t)
    if vr and not vr.get("ok"):
        return "mech_reject", vr, None, vr
    d, err = review_one(t, vr)
    if d and not err:
        d = gate_verdict(t, d, vr)
    return "model", d, err, vr


def fmt_escalation(t, d):
    """人が読む物として組み立てる。判決 JSON を其のまま貼っても誰も読まない。"""
    L = []
    L.append("## 需要你确认")
    L.append("")
    L.append((d.get("summary") or d.get("reason") or "").strip())
    opts = d.get("options") or []
    rec = str(d.get("recommend") or "").strip().upper()
    if opts:
        L.append("")
        L.append("### 方案")
        for o in opts:
            k = str(o.get("key") or "?").upper()
            star = "  ← **推荐**" if k == rec else ""
            L.append("")
            L.append("**" + k + ". " + str(o.get("title", "")) + "**" + star)
            if o.get("detail"):
                L.append("- 做什么:" + str(o["detail"]))
            if o.get("cost"):
                L.append("- 代价:" + str(o["cost"]))
            for f in (o.get("files") or []):
                L.append("- 可下载文件:" + str(f.get("archive_name") or f.get("path") or ""))
    else:
        L.append("")
        L.append("(自动审阅没有给出方案——它只说需要你定,理由见下。)")
    ck = d.get("checked") or []
    if ck:
        L.append("")
        L.append("### 我核对过什么")
        for c in ck:
            L.append("- " + str(c))
    if d.get("reason") and d.get("summary"):
        L.append("")
        L.append("### 判断依据(原文)")
        L.append(str(d["reason"]))
    L.append("")
    L.append("")
    L.append(f"—— 自动审阅({MODEL})· 这不是最终裁定 ——")
    L.append("下面的输入框里**写点什么再提交**(比如只写一个 `A`),这张卡就不会结案,")
    L.append("而是带着你写的内容转给协调去执行。什么都不写就直接按,才是「就此了结」。")
    return chr(10).join(L)


def apply_verdict(t, d, vr=None):
    tid, v = t["id"], d["verdict"]
    reason = (d.get("reason") or "").strip()
    checked = d.get("checked") or []
    note = f"【自动审阅】{reason}"
    if checked: note += "\n核对过:" + " / ".join(str(c) for c in checked)
    if v in ("approve", "reject"):
        # ⭐联动结案の引金は**機械の緑**であって approve ではない。此処で渡すのは
        #   「本審で実際に撃った verify の結果」だけ —— 撃っていなければ渡さない
        #   (推論して true にしない。推論は測定ではない)。
        body = {"verdict": v, "note": note, "resolved_by": "auto"}
        if vr is not None and vr.get("key"):
            body["verify_ok"] = bool(vr.get("ok"))
        s, r = call("POST", f"/api/tasks/{tid}/resolve", body)
        if s >= 400:
            log(f"  #{tid} 落盘失败 {s} {r.get('error','')}"); return "error"
        log(f"  #{tid} → 自动{'通过' if v == 'approve' else '打回'}:{reason[:70]}")
        cas = (r.get("cascade") or {}) if isinstance(r, dict) else {}
        if cas:
            log(f"  ⭐联动: 关闭 {cas.get('closed') or []} / 父卡 {cas.get('parent')} "
                f"/ 在途待关 {cas.get('deferred') or []}")
        return v
    human = fmt_escalation(t, d)
    package = {"version": 1, "source": "auto-review", "summary": d.get("summary") or "",
               "options": d.get("options") or [], "recommend": d.get("recommend") or "",
               "checked": d.get("checked") or [], "reason": d.get("reason") or "",
               "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
               "model": MODEL}
    call("POST", f"/api/tasks/{tid}/autoreview", {"note": human, "decision_package": package})
    n_opt = len(d.get("options") or [])
    rec = d.get('recommend') or '无'
    head = (d.get('summary') or d.get('reason') or '')[:60]
    log(f"  #{tid} → 待确认(方案 {n_opt} 个, 推荐 {rec}):{head}")
    return "escalate"


def digest_selftest():
    """超长证据的截断路径检收:头部逐字保留 + 响亮标记(不许沉默截断)。"""
    fake = {"result": "头部逐字段。" * 3000}
    out1 = result_for_prompt(fake)
    ok1 = out1.startswith("头部逐字段。") and "此处截断" in out1 and str(len(fake["result"])) in out1
    print(("PASS" if ok1 else "FAIL") + " ① 超长证据 → 头部逐字 + 响亮截断标记(报原文字数)")
    short = {"result": "短证据原样。"}
    ok2 = result_for_prompt(short) == "短证据原样。"
    print(("PASS" if ok2 else "FAIL") + " ② 短证据逐字直通")
    sys.exit(0 if (ok1 and ok2) else 1)


def main():
    if "--digest-selftest" in sys.argv:
        digest_selftest()
    if RUNTIME not in ("claude", "codex"):
        print(f"[reviewer] 未知运行时 {RUNTIME} —— 拒绝启动", flush=True); sys.exit(gates_lib.EXIT_REFUSED)
    if RUNTIME == "codex" and not CODEX_RELEASED:
        print("[reviewer] Codex 未解禁 —— 拒绝启动", flush=True); sys.exit(gates_lib.EXIT_REFUSED)
    if RUNTIME == "codex":
        cg = codex_runtime.gate(CODEX_CLI)
        if cg: print(cg, flush=True); sys.exit(gates_lib.EXIT_REFUSED)
    cgate = context_lib.context_gate(REPO, None, RUNTIME)
    if cgate:
        print(cgate, flush=True)
        sys.exit(gates_lib.EXIT_REFUSED)
    # ⭐revision 绑定门: 审阅也是自动进程 —— 未验收版一律不起(loud)。锚=看板自身代码。
    sgate = gates_lib.source_gate(CODE_ROOT, DATA, log=log, loaded_tree=LOADED_TREE)
    if sgate:
        print(sgate, flush=True)
        sys.exit(gates_lib.EXIT_REFUSED)
    interval = int(sys.argv[sys.argv.index("--interval") + 1]) if "--interval" in sys.argv else 90
    once, dry = "--once" in sys.argv, "--dry-run" in sys.argv
    # 每轮默认最多 6 件;要不限,显式传 --limit 0。argv 显式给的优先于 env。
    limit = (int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv
             else int(os.environ.get("REVIEWER_LIMIT", "6")))
    # 无人で回す時は審阅も燃料を食う。締切は worker と同じ形で持たせる。
    until = None
    if "--until" in sys.argv:
        import datetime as _dt
        _v = sys.argv[sys.argv.index("--until") + 1]
        if "T" in _v:            # 絶対時刻(server の標準形)。過去=即時到期、順延しない
            until = _dt.datetime.fromisoformat(_v)
            if until.tzinfo is not None: until = until.astimezone().replace(tzinfo=None)
        else:                    # 旧形 HH:MM は順延(人の手打ち用)
            hh, mm = (int(x) for x in _v.split(":"))
            now = _dt.datetime.now()
            until = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
            if until <= now: until += _dt.timedelta(days=1)
    log(f"自动审阅 runtime={RUNTIME} model={MODEL} effort={EFFORT} interval={interval}s base={BASE} dry={dry}"
        + (f" 締切={until:%m-%d %H:%M}" if until else " 締切=無し"))
    while True:
        cgate = context_lib.context_gate(REPO, None, RUNTIME)
        sgate = gates_lib.source_gate(CODE_ROOT, DATA, log=log, loaded_tree=LOADED_TREE)
        if cgate or sgate:
            print(cgate or sgate, flush=True)
            return
        if until:
            import datetime as _dt2
            if _dt2.datetime.now() >= until:
                log(f"締切 {until:%H:%M} を過ぎた —— 審阅を終了する(未審の卡は残るだけで壊れない)")
                return
        try:
            st, r = call("GET", "/api/review/pending")
        except RuntimeError as e:
            log(str(e)); time.sleep(min(interval, 30)); continue
        if st != 200:
            # ⚠ 失败不许伪装成"没活"。旧版看板没有这个端点时会 404,
            #    静默当成空列表的话,自动审阅会永远显示岁月静好。
            log(f"取待审列表失败 {st}:{r.get('error','(无正文)')} —— 看板可能是旧版,请重启服务")
            if once or dry: return
            time.sleep(min(interval, 30)); continue
        todo = r.get("tasks", [])
        if not todo:
            log("没有待验收的等待中卡" + ("(退出)" if once or dry else f",睡 {interval}s"))
            if once or dry: return
            time.sleep(interval); continue
        if dry:
            log(f"dry-run:{len(todo)} 件待验收 → " + ", ".join(f"#{t['id']}({t.get('waiting_for')})" for t in todo))
            return
        batch = todo[:limit] if limit else todo
        log(f"{len(todo)} 件待验收" + (f",本轮取 {len(batch)} 件(--limit {limit})" if limit else ""))
        # ⭐并行审: 判读在线程里并行,落盘(resolve/autoreview)回主线程串行
        #   —— 模型判读是慢段(1-3 分),落盘是快段;串行落盘保住日志与事件顺序的可读性。
        results = {}
        def _judge(t):
            log(f"  审 #{t['id']}: {t['subject'][:52]}")
            results[t["id"]] = judge_one(t)
        per_cap = float(REVIEWER_BUDGET) if str(REVIEWER_BUDGET) not in ("0", "") else 0.0
        i0 = 0
        while i0 < len(batch):
            width = REVIEWER_PARALLEL
            if per_cap > 0:
                rem, spent, _n, cap = gates_lib.remaining_today(DATA)
                width = (REVIEWER_PARALLEL if rem == float("inf")
                         else min(REVIEWER_PARALLEL, int(rem // per_cap)))
                if width < 1:
                    log(f"⛔ 全局预算余 ${rem:.2f} < 单卡帽 ${per_cap:.2f}"
                        f"(今日已花 ${spent:.2f}/${cap:.2f})—— 停审收队,余 {len(batch) - i0} 件待预算窗口")
                    break
            wave = batch[i0:i0 + width]
            ths = [threading.Thread(target=_judge, args=(t,), daemon=True) for t in wave]
            for th in ths: th.start()
            for th in ths: th.join()
            i0 += len(wave)
        for t in batch:
            if t["id"] not in results: continue   # 预算收队没审到的卡: 原样留在队列,下轮再来
            kind, d, err, vr = results.get(t["id"], ("model", None, "(线程没回话)", None))
            if kind == "mech_reject":
                vr0 = d
                note0 = ("【自动审阅·机械】卡指名的验证未通过 —— 不经模型直接打回。"
                         + chr(10) + fmt_verify(vr0))
                s0, r0 = call("POST", f"/api/tasks/{t['id']}/resolve",
                              {"verdict": "reject", "note": note0, "resolved_by": "auto",
                               "verify_ok": False})
                log(f"  #{t['id']} → 机械打回(验证 {vr0.get('key')} rc={vr0.get('rc')})"
                    if s0 < 400 else f"  #{t['id']} 机械打回落盘失败 {s0}")
                continue
            if err:
                # 审阅自身が落ちた卡にも「見た」印を付ける —— 次周期には拾われない
                # (壊れた卡で金を燃やし続けない)。卡が動けば自動的に再審対象へ戻る。
                call("POST", f"/api/tasks/{t['id']}/autoreview",
                     {"note": f"【自动审阅】本次未能出判决:{err[:400]}"})
                log(f"  #{t['id']} 审阅失败:{err.splitlines()[0][:80]}")
                continue
            apply_verdict(t, d, vr=vr)
        if once: return
        # ⭐积压自适应: 本轮没审完队列 → 短睡 30s 连轴排空;排空了才按 interval 省着睡。
        time.sleep(30 if len(todo) > len(batch) else interval)


# ⭐素の `main()` だと **import した瞬間に板を叩き始める**ので、判据の門
#   (gate_verdict / judge_one)だけを試験する事が出来ない。守りを付けても
#   `python reviewer_loop.py --once` も server.mjs の起動も一切変わらない。
if __name__ == "__main__":
    main()
