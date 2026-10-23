import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../core/panel.html", import.meta.url), "utf8");

function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `未找到面板测试边界：${start}`);
  return source.slice(a, b);
}

function declaration(name) {
  const a = source.indexOf(`function ${name}(`), b = source.indexOf("\n}", a);
  assert.ok(a >= 0 && b > a, `未找到面板函数：${name}`);
  return source.slice(a, b + 2);
}

// 只模拟侧栏实际用到的节点操作，不安装浏览器或另建一套界面实现。
function fixture(extra = {}) {
  let clock = 1_800_000_000_000;
  const document = { activeElement: null, addEventListener() {} };
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {};
      this.hidden = false; this.value = ""; this.className = ""; this.id = "";
      this.selectionStart = 0; this.selectionEnd = 0; this.text = ""; this.replacements = 0;
      this.style = { setProperty() {} };
      this.classList = {
        add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
        remove: (...names) => { this.className = this.className.split(/\s+/).filter((n) => !names.includes(n)).join(" "); },
        contains: (name) => this.className.split(/\s+/).includes(name),
      };
    }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text + this.children.map((e) => e.textContent ?? String(e)).join(""); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.replacements++; this.text = ""; this.children = nodes; }
    addEventListener() {}
    setAttribute(name, value) {
      if (name === "id") this.id = String(value);
      else if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
      else this[name] = String(value);
    }
    focus() { document.activeElement = this; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    matches(selector) {
      if (selector.startsWith("#")) return this.id === selector.slice(1);
      const tag = selector.match(/^[a-z][\w-]*/i)?.[0];
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(name)) return false;
      for (const [, name, value] of selector.matchAll(/\[data-([\w-]+)(?:="([^"]*)")?\]/g)) {
        const key = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        if (!(key in this.dataset) || (value !== undefined && this.dataset[key] !== value)) return false;
      }
      return true;
    }
    querySelectorAll(selector) {
      const found = [];
      for (const child of this.children) if (child instanceof Element) {
        if (child.matches(selector)) found.push(child);
        found.push(...child.querySelectorAll(selector));
      }
      return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }
  document.createElement = (tag) => new Element(tag);
  const root = new Element("aside"); root.id = "task-side";
  for (const [tag, id] of [["h2", "task-side-title"], ["button", "task-side-close"], ["div", "task-side-body"]]) {
    const node = new Element(tag); node.id = id; root.append(node);
  }
  document.getElementById = (id) => root.id === id ? root : root.querySelector("#" + id);
  document.querySelector = (selector) => root.querySelector(selector);
  document.querySelectorAll = (selector) => root.querySelectorAll(selector);
  const task = { id: 7, task_uid: "fixture-node/task-7", subject: "侧栏任务", line: "engine", kind: "task",
    status: "in_progress", aggregate_version: 3, heartbeat_at: clock, lease_until: clock + 600_000,
    last_runtime: "codex", parent_id: null, blocked_by: [], ...extra };
  const context = vm.createContext({
    document, now: () => clock, tasks: [task], byId: new Map([[task.id, task]]),
    sideRef: { id: task.id, uid: task.task_uid, item: null }, sideSig: "", workers: [],
    meta: { wf_labels: { review: "审阅" } }, verdictDraft: new Map(), fleetApi: null,
    homeMulti: () => false, homeLocalName: () => "本机", lineLabel: (line) => line,
    history: { replaceState() {} }, location: { hash: "", pathname: "/", search: "" }, URLSearchParams,
    homeEl: (tag, text, cls) => {
      const node = new Element(tag);
      if (text !== undefined) node.textContent = text;
      if (cls) node.className = cls;
      return node;
    },
  });
  const pure = section("// ── home-model(pure;tests/hometest.mjs)──", "// ── /home-model ──");
  const side = section("function sideCard(){", "function sideFromHash(){");
  vm.runInContext(pure + "\n" + declaration("localTime") + "\n" + declaration("hbClass") + "\n" + declaration("tick") + "\n" + side, context);
  return { context, task, root, document, setTime: (value) => { clock = value; }, time: () => clock,
    body: document.getElementById("task-side-body"), state: () => document.getElementById("task-side-state") };
}

test("同一任务版本下，侧栏随时钟和心跳恢复更新而不重建内容", () => {
  const f = fixture(); f.context.renderSide();
  const state = f.state(), next = f.document.getElementById("task-side-next"), changes = f.body.replacements;
  assert.ok(state && next, "侧栏提供可独立更新的状态与下一步节点");
  assert.doesNotMatch(state.textContent, /心跳中断/);
  f.setTime(f.time() + 181_000); f.context.tick();
  assert.match(state.textContent, /心跳中断/);
  assert.equal(state.dataset.tone, "warn");
  assert.equal(f.body.replacements, changes, "每秒刷新不能重建侧栏");
  f.task.heartbeat_at = f.time(); f.context.renderSide();
  assert.doesNotMatch(state.textContent, /心跳中断/);
  assert.notEqual(state.dataset.tone, "warn");
  assert.equal(f.state(), state); assert.equal(f.document.getElementById("task-side-next"), next);
  assert.equal(f.body.replacements, changes, "相同结构签名的刷新仍原位更新");
  assert.equal(f.task.aggregate_version, 3);
});

test("局部状态刷新保留实际留言、焦点、选区和已按一次的确认按钮", () => {
  const f = fixture({ status: "waiting", waiting_for: "review" }); f.context.renderSide();
  const input = f.body.querySelector("textarea"), button = f.body.querySelectorAll("button").find((b) => b.dataset.a === "approve");
  assert.ok(input && button, "使用实际侧栏操作节点，而非额外添加的占位控件");
  input.value = "请保留这段未提交的意见"; input.focus(); input.setSelectionRange(2, 8);
  button.dataset.armed = "1"; button.classList.add("armed");
  const changes = f.body.replacements;
  f.context.updateSideLive(); f.context.renderSide(); f.context.tick();
  assert.equal(f.body.querySelector("textarea"), input);
  assert.equal(f.body.querySelectorAll("button").find((b) => b.dataset.a === "approve"), button);
  assert.equal(input.value, "请保留这段未提交的意见"); assert.equal(f.document.activeElement, input);
  assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 8);
  assert.equal(button.dataset.armed, "1"); assert.equal(button.classList.contains("armed"), true);
  assert.equal(f.body.replacements, changes);
});

test("侧栏关闭或没有任务时，实时刷新不触碰已有节点", () => {
  const f = fixture(); f.context.renderSide();
  const state = f.state(), content = state.textContent, changes = f.body.replacements;
  f.root.hidden = true; f.setTime(f.time() + 181_000); f.context.updateSideLive(); f.context.tick();
  assert.equal(state.textContent, content); assert.equal(f.body.replacements, changes);
  f.root.hidden = false; f.context.sideRef = null; f.context.updateSideLive();
  assert.equal(state.textContent, content); assert.equal(f.body.replacements, changes);
});

test("关联任务变化只刷新关联区域，保留留言、焦点和待确认按钮", () => {
  const f = fixture({ status: "waiting", waiting_for: "review", blocked_by: [9] });
  const dependency = { id: 9, subject: "待完成的前置任务", status: "not_started", parent_id: null, blocked_by: [] };
  f.context.tasks.push(dependency); f.context.byId.set(dependency.id, dependency); f.context.renderSide();
  const relations = f.document.getElementById("task-side-relations");
  assert.ok(relations, "关联任务拥有可独立更新的区域");
  assert.match(relations.textContent, /待完成的前置任务.*未开始/);
  const input = f.body.querySelector("textarea"), button = f.body.querySelectorAll("button").find((b) => b.dataset.a === "approve");
  input.value = "依赖更新时也不能丢掉这句话"; input.focus(); input.setSelectionRange(3, 9);
  button.dataset.armed = "1"; button.classList.add("armed");
  const changes = f.body.replacements;
  dependency.status = "done"; f.context.renderSide();
  assert.equal(f.document.getElementById("task-side-relations"), relations);
  assert.match(relations.textContent, /待完成的前置任务.*已完成/);
  assert.equal(f.body.replacements, changes, "关联状态变化不能重建整个侧栏");
  assert.equal(f.body.querySelector("textarea"), input);
  assert.equal(input.value, "依赖更新时也不能丢掉这句话"); assert.equal(f.document.activeElement, input);
  assert.equal(input.selectionStart, 3); assert.equal(input.selectionEnd, 9);
  assert.equal(f.body.querySelectorAll("button").find((b) => b.dataset.a === "approve"), button);
  assert.equal(button.dataset.armed, "1"); assert.equal(button.classList.contains("armed"), true);
});

test("派发与领取显示本地日期和时刻，不使用旧运行的进程时间", () => {
  const f = fixture({ run_id: "current", released: true, execution_trace: {
    run_id: "current", released_at: "2026-10-21T08:00:00.000Z", claimed_at: "2026-10-21T09:08:07.000Z",
    process_state: "unverified", work_state: "unverified",
  } });
  f.context.renderSide();
  const trace = f.document.getElementById("task-side-execution");
  assert.match(trace.textContent, /本轮领取\d{2}-\d{2} \d{2}:\d{2}/);
  f.task.execution_trace = { run_id: "previous", process_state: "observed", process_started_at: "2025-01-01T00:00:00.000Z" };
  f.context.renderSide();
  assert.ok(!trace.textContent.includes("01-01"));
  assert.match(trace.textContent, /进程观察待核实/);
});
