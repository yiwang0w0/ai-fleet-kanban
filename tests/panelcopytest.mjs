import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../core/panel.html", import.meta.url), "utf8");
const start = source.indexOf("// ── display-copy(pure;tests/panelcopytest.mjs)──");
const end = source.indexOf("// ── /display-copy ──", start);
assert.ok(start >= 0 && end > start, "未找到纯展示文案测试边界");
const copy = new Function(source.slice(source.indexOf("\n", start) + 1, end) +
  "\nreturn { copyLabel, routeLabel, copyError, formatCount };")();

test("枚举按调用者语义域显示，未知值和原型键只使用中文兜底", () => {
  const delivery = Object.freeze({ accepted: "已接收", ready: "接收准备就绪" });
  const acceptance = Object.freeze({ accepted: "已验收", ready: "可提交验收" });
  assert.equal(copy.copyLabel(delivery, "accepted"), "已接收");
  assert.equal(copy.copyLabel(acceptance, "accepted"), "已验收");
  assert.equal(copy.copyLabel(delivery, "ready"), "接收准备就绪");
  assert.equal(copy.copyLabel(acceptance, "ready"), "可提交验收");
  for (const value of ["future_state", "constructor", "toString", "hasOwnProperty", "__proto__"])
    assert.equal(copy.copyLabel(delivery, value), "状态待核实", value);
  assert.equal(copy.copyLabel(delivery, "future_state", "其他操作"), "其他操作");
  assert.equal(copy.copyLabel(Object.create({ ready: "继承值不应显示" }), "ready"), "状态待核实");
});

test("路由显示与协议值分离，自定义配置和用户原文不改写", () => {
  assert.equal(copy.routeLabel("default"), "默认");
  for (const name of ["claude", "codex", "zcode"])
    assert.match(copy.routeLabel(name), new RegExp(name, "i"));
  const input = Object.freeze({ route: "Team-A / 自定义执行线", state: "future_state", note: "User text：保留原文" });
  const before = JSON.stringify(input);
  assert.equal(copy.routeLabel(input.route), input.route);
  assert.equal(copy.copyLabel({ ready: "已准备" }, input.state), "状态待核实");
  assert.equal(JSON.stringify(input), before);
});

test("用量显示使用中文计数单位，不改变计数值", () => {
  for (const [number, label] of [[0, "0"], [999, "999"], [1250, "1.3千"], [25000, "2.5万"], [2500000, "250.0万"], [200000000, "2.0亿"]]) {
    assert.equal(copy.formatCount(number), label);
    assert.equal(typeof number, "number");
  }
  assert.match(source, /aria-valuetext="\$\{esc\(effortName\(a\.effort\)\)\}"/);
  assert.ok(source.includes('el.setAttribute("aria-valuetext", effortName(a.effort))'));
});

test("浏览器错误使用中文说明，中文消息及未知原始错误完整保留", () => {
  for (const error of [new TypeError("Failed to fetch"),
    Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }),
    new SyntaxError("Unexpected token '<', invalid JSON")]) {
    const message = copy.copyError(error);
    assert.match(message, /[\u3400-\u9fff]/, error.message);
    assert.notEqual(message, error.message);
  }
  const chinese = "任务版本已改变，请刷新后重新核对。";
  assert.equal(copy.copyError(new Error(chinese)), chinese);
  const original = "backend policy denied custom action";
  const error = new Error(original), displayed = copy.copyError(error);
  assert.match(displayed, /[\u3400-\u9fff]/);
  assert.ok(displayed.includes(original), "未知错误的原始信息必须保留，不能用泛化中文掩盖原因");
  assert.equal(error.message, original);
});

test("业务错误中的超时字样不是浏览器异常，不能掩盖原始原因", () => {
  const message = '未知的 handoff 目标 "timeout"';
  assert.equal(copy.copyError(message), message);
  assert.equal(copy.copyError(new Error(message)), message);
  for (const original of ['unknown target "timeout"', 'file network request failed.txt missing', 'backend: unexpected token in source'])
    assert.equal(copy.copyError(new Error(original)), "操作未完成。原始信息：" + original);
});

test("内置界面不再混用旧英文提示，不误判注释、样式类或机器字段", () => {
  // 仅检查已知内置展示位置；recommended 类名、worker 标识等不属于漏译。
  const display = source.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(display, />\s*Final ruling\s*</);
  assert.doesNotMatch(display, /ev\("ev",\s*"evidence\s*\/\s*reason"/);
  assert.doesNotMatch(display, />\s*recommended(?:\s*:|\s*<)/i);
  assert.doesNotMatch(display, /(?:title|placeholder|aria-label)="[^"\n]*原 Agent[^"\n]*"/);
  assert.doesNotMatch(display, />[^<>\n]*worker 守则[^<>\n]*</);
  assert.doesNotMatch(display, /["`][^"`\n]*(?:交回原 Agent|装 worker 守则)[^"`\n]*["`]/);
});

test("新建任务、加线与时间轴控件具有明确中文无障碍名称", () => {
  const labels = {
    "home-new-title": "任务标题", "home-new-desc": "任务说明",
    "line-add-label": "执行线显示名称", "line-add-id": "执行线标识", "line-add-hint": "执行线用途",
    "tl-date": "时间轴日期", "tl-prev": "上一天", "tl-next": "下一天",
  };
  for (const [id, name] of Object.entries(labels)) {
    const tag = [...source.matchAll(/<(?:input|textarea|button)\b[^>]*>/g)]
      .map((match) => match[0]).find((value) => value.includes(`id="${id}"`));
    assert.ok(tag, id);
    assert.ok(tag.includes(`aria-label="${name}"`) || tag.includes(`aria-label='${name}'`), id);
  }
});

test("本批文案调整保留 ef2ad8f 的原 Kanban 暖色变量", () => {
  const palettes = [...source.matchAll(/:root\s*\{([^}]+)\}/g)]
    .map((match) => Object.fromEntries([...match[1].matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\b/gi)]
      .map((entry) => [entry[1], entry[2].toLowerCase()])));
  assert.deepEqual(palettes, [
    { bg: "#f7f2e8", panel: "#fffcf6", panel2: "#f1e9dc", line: "#ddcfbb", fg: "#332b23",
      dim: "#756652", dim2: "#726451", accent: "#9b530b", cc: "#80572c", l0: "#936544",
      ok: "#396a4c", warn: "#7f5d0e", bad: "#b74332" },
    { bg: "#1e1a16", panel: "#27211c", panel2: "#312920", line: "#574737", fg: "#f4eadb",
      dim: "#c2b19a", dim2: "#a7957d", accent: "#e7ab5c", cc: "#c99760", l0: "#cfb18b",
      ok: "#8db394", warn: "#d7b765", bad: "#f08a77" },
  ]);
});
