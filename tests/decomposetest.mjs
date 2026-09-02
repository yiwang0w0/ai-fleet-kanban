// Pure-function regression for the goal-decomposition prompt.
// Touches no board, no database, no CLI: the prompt builder is a pure function
// precisely so this surface can be measured at all (see core/decompose_lib.js).

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const { buildDecomposePrompt, lineMenu } = require_(join(__dirname, "..", "core", "decompose_lib.js"));

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
};

const GOAL = { id: 7, kind: "goal", subject: "把工单处理搬上看板", description: "背景说明一行", status: "not_started" };
const LINES = ["alpha", "coord"];
const HINTS = { alpha: "实装", coord: "协调/裁定/跑命令" };
const OUT = "C:/tmp/decompose/goal-7.json";
const base = (over = {}) =>
  buildDecomposePrompt({ goal: GOAL, outPath: OUT, lines: LINES, hints: HINTS, ...over });

console.log("[① the generated-content language is a fleet property]");
{
  const off = base();
  const on = base({ language: "English" });
  // ⚠ Both directions. Asserting only the "on" side stays green if the knob is
  //   hardwired ON; asserting only "off" stays green if it never works at all.
  ok("⭐unset ⇒ the prompt says nothing about language (the model mirrors it)",
     !/一律用/.test(off), (off.match(/一律用[^\n]*/) || ["(absent, as expected)"])[0]);
  ok("⭐set ⇒ one instruction line naming the language",
     /- \*\*卡片正文\(subject\/description\/acceptance\)一律用 English 书写\*\*。/.test(on),
     (on.match(/一律用[^\n]*/) || ["(missing)"])[0]);
  ok("the instruction sits INSIDE the rules block, not after the output contract",
     on.indexOf("一律用 English") > on.indexOf("拆解规则:") &&
     on.indexOf("一律用 English") < on.indexOf("只做一件事"));
  ok("whitespace-only language counts as unset (a knob set to \" \" must not emit a blank rule)",
     !/一律用/.test(base({ language: "   " })));
  ok("the language name is carried VERBATIM (not mapped through a table of known languages)",
     /一律用 日本語 书写/.test(base({ language: "日本語" })));
  ok("setting the language changes NOTHING else in the prompt",
     off.split("\n").filter((l) => !/一律用/.test(l)).join("\n") ===
     on.split("\n").filter((l) => !/一律用/.test(l)).join("\n"));
}

console.log("\n[② the line menu is built from config, never copied into prose]");
{
  const p = base();
  ok("every configured line appears in the menu with its hint",
     /- line 从这些里选:alpha \(实装\), coord \(协调\/裁定\/跑命令\);/.test(p),
     (p.match(/- line 从这些里选[^\n]*/) || ["(missing)"])[0]);
  ok("a line with no hint degrades to the bare id",
     lineMenu(["a", "b"], { a: "x" }) === "a (x), b", lineMenu(["a", "b"], { a: "x" }));
  ok("the JSON shape offered to the model lists the same lines plus null",
     p.includes('"line":"alpha|coord|null"'),
     (p.match(/\{"tasks".*/) || ["(missing)"])[0].slice(0, 80));
  // ⚠ The measured failure this guards: a hand-copied list dropped one line in two
  //   places at once, and the decomposer cannot pick a line missing from its menu —
  //   that line silently starved. Adding a line to config must reach BOTH sites.
  const three = buildDecomposePrompt({ goal: GOAL, outPath: OUT, lines: ["alpha", "coord", "docs"], hints: HINTS });
  ok("⭐adding a line reaches the menu AND the JSON shape (both sites, by construction)",
     /coord \(协调\/裁定\/跑命令\), docs;/.test(three) && three.includes('"line":"alpha|coord|docs|null"'));
}

console.log("\n[③ a goal that continues an earlier goal decomposes WITH its record]");
{
  const prev = { id: 3, kind: "goal", subject: "前作目标", status: "done", result: "前作完成记录正文" };
  const cont = base({ prev });
  ok("⭐the predecessor is named, with its status in words",
     /⭐本目标衔接既往目标 #3「前作目标」\(已完成\)。/.test(cont),
     (cont.match(/⭐本目标衔接[^\n]*/) || ["(missing)"])[0]);
  ok("its completion record is carried (so finished work is not re-planned)",
     cont.includes("前作完成记录正文"));
  ok("an unfinished predecessor shows its raw status instead of 已完成",
     /\(waiting\)。/.test(base({ prev: { ...prev, status: "waiting" } })));
  ok("a predecessor with no record says so instead of going blank",
     /\(无完成记录\)/.test(base({ prev: { ...prev, result: "" } })));
  // ⚠ Parents are not always goals: an ordinary card can be a parent. Only a goal
  //   is a continuation, or every child card would drag its parent's text along.
  ok("⭐a non-goal parent is NOT treated as a continuation",
     !/衔接既往目标/.test(base({ prev: { id: 9, kind: "task", subject: "普通卡", status: "done" } })));
  ok("no predecessor ⇒ no continuation block at all", !/衔接既往目标/.test(base()));
  ok("a very long record is truncated (the prompt travels as one argv element)",
     base({ prev: { ...prev, result: "x".repeat(5000) } }).includes("x".repeat(1200)) &&
     !base({ prev: { ...prev, result: "x".repeat(5000) } }).includes("x".repeat(1201)));
}

console.log("\n[④ the output contract the server depends on]");
{
  const p = base();
  // The server reads exactly this path afterwards; if the prompt ever stops naming
  // it, the decomposer writes somewhere else and the server reports "no result file".
  ok("⭐the output path appears verbatim, indented on its own line",
     p.includes(String.fromCharCode(10) + "  " + OUT + String.fromCharCode(10)));
  ok("the model is told to write the file and touch nothing else",
     /只做一件事:用 Write 工具把结果写进这个文件,别的什么都不要动。/.test(p));
  ok("it is told not to wrap the JSON in a code block (the server parses the raw file)",
     /不要包代码块/.test(p));
  ok("the goal's own subject and background are present",
     p.includes("目标 #7:把工单处理搬上看板") && p.includes("背景说明一行"));
  ok("a goal with an empty description simply omits the background line, no empty label",
     !/背景\/要求:/.test(buildDecomposePrompt(
       { goal: { ...GOAL, description: "" }, outPath: OUT, lines: LINES, hints: HINTS })));
  ok("the decomposer is told it does NOT do the work",
     /你\*\*不做这些活\*\*,只做拆解。/.test(p));
}

console.log(`\n${"─".repeat(56)}\nresult: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
