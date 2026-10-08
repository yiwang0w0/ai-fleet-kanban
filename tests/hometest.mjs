// Home view harness. The landing page answers "what needs me, what is running" — which card
// lands in which list, with which words, lives in a marked pure block inside core/panel.html
// (home-model) so it can be sliced out and run here, the same way tests/tltest.mjs runs the
// timeline geometry. The structural pins at the end hold the layout decisions that block
// cannot see: home is the default view, ids sit folded under 技术信息, hidden columns never
// animate.
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const src = readFileSync(new URL("../core/panel.html", import.meta.url), "utf8");
const b0 = src.indexOf("// ── home-model(pure;tests/hometest.mjs)──"), b1 = src.indexOf("// ── /home-model ──");
assert.ok(b0 > 0 && b1 > b0, "home-model block not found in core/panel.html");
const M = new Function(src.slice(src.indexOf("\n", b0) + 1, b1) +
  ";return {homeName,homeStep,homeLists,homeStatus,homeHealthWhat};")();
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const NODE_B = "83d5fb7d-b622-44fc-a230-252f8f767824";
const at = (h) => `2026-10-08T${String(h).padStart(2, "0")}:00:00Z`;
const card = (id, extra) => ({ id, task_uid: "u" + id, subject: "卡 " + id, kind: "task", status: "waiting", updated_at: at(id), hb: "", ...extra });
const ids = (rows) => rows.map((r) => r.localId ?? r.key);

test("decisions and answers wait for me; a delivery waits for me only when no reviewer will take it", () => {
  const tasks = [
    card(4, { waiting_for: "review" }), card(3, { waiting_for: "review", review_hold: "same_family" }),
    card(2, { waiting_for: "decision" }), card(1, { waiting_for: "confirm" }),
    card(5, { waiting_for: "dep" }), card(6, { waiting_for: "rearm" }),
  ];
  const plain = M.homeLists({ tasks, localName: "台式机 A" });
  assert.deepEqual(ids(plain.mine), [1, 2, 3, 4], "confirm, then decision, then deliveries oldest first");
  assert.deepEqual(plain.mine.map((r) => r.next), ["选择方案", "给出决定", "确认验收", "确认验收"]);
  assert.equal(plain.running.length, 0, "dependency and re-review waits are machine-tended, not on the home lists");
  const reviewed = M.homeLists({ tasks, localName: "台式机 A", autoReview: true });
  assert.deepEqual(ids(reviewed.mine), [1, 2, 3], "a running reviewer takes deliveries — except one it may not judge");
  assert.deepEqual(reviewed.running.map((r) => [r.localId, r.state, r.next]), [[4, "等待自动审阅", "无需操作"]]);
  assert.ok(plain.mine.every((r) => r.computer === "台式机 A"));
});

test("a card the machine will not move is mine even with the reviewer running", () => {
  const why = (code, next_action) => ({ code, message: code, next_action });
  const tasks = [
    card(1, { waiting_for: "review", human_gate: 1, progress_blockers: [why("HUMAN_GATE", "由操作者裁定或显式解除人工闸")] }),
    card(2, { waiting_for: "review", progress_blockers: [why("DELIVERY_ALREADY_REVIEWED", "按既有审阅意见处理或补充新证据")] }),
    card(3, { waiting_for: "review", progress_blockers: [why("DELEGATION_FINISH_HELD", "按对应协议完成结算或人工恢复")] }),
    card(4, { waiting_for: "review" }),
    card(5, { waiting_for: "rearm", progress_blockers: [why("CHILDREN_UNFINISHED", "先推进未完成子任务")] }),
    card(6, { waiting_for: "rearm", progress_blockers: [why("NO_NEW_CHILD_RESULT", "核对审阅记录及子任务结果")] }),
    card(7, { waiting_for: "dep", progress_blockers: [why("DELIVERY_ALREADY_REVIEWED", "按既有审阅意见处理或补充新证据")] }),
    card(8, { waiting_for: "dep", human_gate: 1, progress_blockers: [why("HUMAN_GATE", "由操作者裁定或显式解除人工闸")] }),
    card(9, { status: "not_started", human_gate: 1, progress_blockers: [why("HUMAN_GATE", "由操作者裁定或显式解除人工闸")] }),
    card(10, { status: "not_started", released: 0, progress_blockers: [why("NOT_RELEASED", "核对任务后显式放行")] }),
  ];
  const { mine, running } = M.homeLists({ tasks, autoReview: true });
  assert.deepEqual(running.map((r) => [r.localId, r.state]), [[4, "等待自动审阅"]], "only an unheld, unjudged delivery is the reviewer's");
  assert.deepEqual(mine.map((r) => [r.localId, r.state, r.next]), [
    [1, "待你验收", "确认验收"], [2, "待你验收", "确认验收"], [3, "待你验收", "按对应协议完成结算或人工恢复"],
    [6, "重审受阻", "核对审阅记录及子任务结果"], [8, "待人工裁定", "由操作者裁定或显式解除人工闸"],
    [9, "待人工裁定", "由操作者裁定或显式解除人工闸"],
  ], "unfinished children and a judged dependency wait are the machine's; an unreleased card stays in 全部任务");
});

test("running cards name their executor and a silent one comes first with a warning", () => {
  const { running } = M.homeLists({ tasks: [
    card(1, { status: "in_progress", last_runtime: "codex", hb: "fresh" }),
    card(2, { status: "in_progress", last_runtime: "claude", hb: "dead" }),
    card(3, { status: "in_progress", last_runtime: "zcode", hb: "stale" }),
  ] });
  assert.deepEqual(running.map((r) => [r.localId, r.state, r.tone, r.next]), [
    [2, "Claude 执行中 · 心跳中断", "warn", "检查执行线"],
    [1, "Codex 执行中", "", "等待完成"],
    [3, "Zcode 执行中", "", "等待完成"],
  ]);
});

test("goals, queued and archived cards stay off the home lists; finished work goes to history, newest first", () => {
  const lists = M.homeLists({ tasks: [
    card(1, { kind: "goal", status: "in_progress" }), card(2, { status: "not_started" }),
    card(3, { waiting_for: "confirm", archived_at: at(9) }),
    card(4, { status: "done", resolved_by: "human" }), card(6, { status: "done", resolved_by: "auto" }),
    card(5, { status: "done", kind: "goal" }), card(7, { status: "done", resolved_by: "cascade" }),
  ] });
  assert.equal(lists.mine.length + lists.running.length, 0);
  assert.deepEqual(lists.history.map((r) => [r.localId, r.state]),
    [[7, "联动关闭"], [6, "自动通过"], [5, "目标完成"], [4, "手动通过"]]);
});

test("other computers: cached copies are handled where they live, and never show an id for a name", () => {
  const remote = [
    { read_only: true, task_uid: NODE_B + ":1", owner_name: "笔记本 B", subject: "回放压测", status: "in_progress", updated_at: at(1) },
    { read_only: true, task_uid: NODE_B + ":2", owner_name: NODE_B, subject: "端口冲突", status: "waiting", waiting_for: "decision", updated_at: at(2) },
    { read_only: true, task_uid: NODE_B + ":3", owner_name: "笔记本 B", subject: "B 的交付", status: "waiting", waiting_for: "review", updated_at: at(3) },
    { read_only: true, task_uid: NODE_B + ":4", owner_name: "笔记本 B", subject: "B 的预检", status: "done", updated_at: at(4) },
    { read_only: false, task_uid: "u9", owner_name: "台式机 A", subject: "本机副本", status: "waiting", waiting_for: "confirm", updated_at: at(5) },
  ];
  const lists = M.homeLists({ tasks: [], localName: "台式机 A", remote });
  assert.deepEqual(lists.running.map((r) => [r.title, r.computer, r.state]), [["回放压测", "笔记本 B", "执行中"]]);
  assert.deepEqual(lists.mine.map((r) => [r.title, r.computer, r.next]), [["端口冲突", "另一台电脑", "到「另一台电脑」上处理"]],
    "a decision there is shown here but done there; its own reviewer may take a delivery; this board's rows come from its own list");
  assert.deepEqual(lists.history.map((r) => r.title), ["B 的预检"]);
  const words = [...lists.mine, ...lists.running, ...lists.history].map((r) => [r.computer, r.state, r.next].join(" ")).join("\n");
  assert.equal(UUID.test(words), false, "a computer whose name is unknown never shows its id instead");
  assert.equal(M.homeName("  "), "另一台电脑");
});

test("cross-computer requests that wait for me open the global view, where they are handled", () => {
  // Shapes as core/fleet-actions.mjs catalog() sends them: delegations and proposals carry a
  // subject and a boolean identity_current; a result row carries ids and a 0/1 identity_current
  // only, its title and executing computer live on the binding with the same relation_id.
  const actions = { enabled: true,
    incoming: [{ delegation_id: "d1", subject: "跑一次压测", state: "received", source_node_id: NODE_B, identity_current: true },
               { delegation_id: "d2", subject: "已接收的", state: "accepted_unconfirmed", source_node_id: NODE_B, identity_current: true },
               { delegation_id: "d3", subject: "旧代次", state: "received", source_node_id: NODE_B, identity_current: false }],
    proposals: [{ relation_id: "r1", subject: "绑定", state: "pending", relation: { source_node_id: NODE_B }, identity_current: true }],
    bindings: [{ relation_id: "r2", subject: "交付回来了", source_node_id: "a", target_node_id: NODE_B, identity_current: 1 }],
    results: [{ result_id: "x1", relation_id: "r2", side: "source", state: "received", identity_current: 1 },
              { result_id: "x2", relation_id: "r2", side: "target", state: "received", identity_current: 1 },
              { result_id: "x3", relation_id: "r2", side: "source", state: "received", identity_current: 0 }] };
  const { mine } = M.homeLists({ tasks: [], actions, nodeNames: { [NODE_B]: "笔记本 B" } });
  assert.deepEqual(mine.map((r) => [r.title, r.computer, r.state, r.next, r.action]), [
    ["跑一次压测", "来自「笔记本 B」", "收到委派", "接收或拒绝", "fleet"],
    ["绑定", "来自「笔记本 B」", "待确认绑定", "核对后确认", "fleet"],
    ["交付回来了", "来自「笔记本 B」", "交付已回传", "查看交付", "fleet"],
  ]);
  assert.equal(M.homeLists({ actions: { enabled: false, incoming: actions.incoming } }).mine.length, 0);
});

test("the device line is one sentence when all is well and lists what needs attention when not", () => {
  const local = { node_id: "a", display_name: "台式机 A", local: true, connection_state: "local" };
  const b = (state, name = "笔记本 B") => ({ node_id: NODE_B, display_name: name, local: false, connection_state: state });
  const ok = M.homeStatus({ localName: "台式机 A", nodes: [local, b("recent")], health: { issues: [] }, setup: { complete: true, steps: [] } });
  assert.deepEqual([ok.tone, ok.alerts.length, ok.line], ["ok", 0, "2 台电脑正常：台式机 A（本机）、笔记本 B 最近已同步"]);
  assert.equal(M.homeStatus({ localName: "台式机 A", nodes: [local] }).line, "本机「台式机 A」正常 · 没有连接其他电脑");
  assert.equal(M.homeStatus({ nodes: [local, b("syncing")] }).tone, "ok", "catching up is not a fault");
  const bad = M.homeStatus({ localName: "台式机 A", nodes: [local, b("failed", NODE_B)], fleetError: "x",
    health: { issues: [{ code: "STORAGE_LOW", level: "problem", next_action: "inspect_storage_before_new_work", count: 2 },
                       { code: "SCHEDULER_LOCK_ORPHAN", level: "notice", next_action: "no_such_action", count: 1 }] },
    setup: { complete: false, done: 3, total: 4, steps: [{ state: "done", title: "起来" }, { state: "todo", title: "接受当前代码" }] } });
  assert.equal(bad.tone, "bad");
  assert.equal(bad.line, "2 台电脑 · 5 项需要注意");
  assert.deepEqual(bad.alerts.map((a) => [a.tone, a.where, a.what, a.go]), [
    ["bad", "另一台电脑", "同步失败", "fleet"],
    ["warn", "多机视图", "暂时读不到", null],
    ["bad", "台式机 A", "磁盘空间不足（2 项）", null],
    ["warn", "台式机 A", "调度器运行锁异常", null],
    ["warn", "看板设置", "还差 1 步：接受当前代码", "board"],
  ]);
  assert.equal(bad.alerts[2].next, "先腾出磁盘空间再派新任务");
  assert.equal(M.homeHealthWhat("SOMETHING_NEW"), "运行检查报告了问题", "an unknown code still says something, never the code");
  assert.equal(UUID.test(JSON.stringify(bad)), false);
});

test("layout pins: home is the landing view, ids fold under 技术信息, hidden columns never animate", () => {
  assert.match(src, /HOME_VIEWS\.includes\(v\) \? v : "home"/, "an unknown or missing saved view lands on home");
  assert.match(src, /<main class="home" id="home-view" data-view-panel="home">/);
  assert.match(src, /<main class="home" id="history-view" data-view-panel="history" hidden>/);
  assert.match(src, /<div id="board-view" data-view-panel="board" hidden>/);
  const show = src.slice(src.indexOf(" async function showTask(uid){"), src.indexOf(" function nextStep("));
  assert.ok(show.length > 0);
  for (const label of ["终端身份", "任务 UID", "运行"])
    assert.equal(show.split(`["${label}"`).length - 1, 1, `${label} appears once in the detail, inside 技术信息`);
  assert.ok(show.includes('techIds([["终端身份",t.owner_node_id]'), "the detail's ids are built by techIds");
  assert.ok(show.includes("evidence(t.evidence,tech)"), "receipts and delegation history render inside 技术信息");
  assert.ok(!src.includes('el("p",n.node_id,"fleet-id")') && src.includes('techIds([["终端身份",n.node_id]])'),
    "the global view folds a computer's id too");
  assert.ok(show.includes("evidence(t.evidence,tech);body.append(tech);"), "the folded block is appended to the detail");
  assert.ok(src.includes('const boardShown = () => !document.getElementById("board-view").hidden;'),
    "visibility is read from the 全部任务 panel itself");
  assert.ok(src.includes("if (!REDUCED.matches && boardShown())") && src.includes("!document.hidden && boardShown()"),
    "FLIP measures and plays only while the columns are visible");
  assert.ok(src.includes("if (v === \"board\") { if (homeReady) render(); }"),
    "the columns' shell is never built before meta arrives");
});
