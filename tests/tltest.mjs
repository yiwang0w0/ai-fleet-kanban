#!/usr/bin/env node
// tltest — the timeline's drawing primitives (docs/style-guide.md §5) and the source shape of
// the renderer. The renderer itself needs a DOM and the board's globals; its pure geometry
// lives in a marked block inside core/panel.html so it can be sliced out and run here — the
// same technique tests/decisiontest.mjs uses for the decision panel.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NL = "\n";
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};
const src = readFileSync(join(ROOT, "core", "panel.html"), "utf8");
const b0 = src.indexOf("// ── tl-geometry"), b1 = src.indexOf("// ── /tl-geometry ──");
if (b0 < 0 || b1 < 0) { console.log("FAIL  tl-geometry block not found in core/panel.html"); process.exit(1); }
const block = src.slice(src.indexOf(NL, b0) + 1, b1);
const G = new Function(block + "; return { tlTextWidth, tlLabelBox, tlOrthoPath, tlSpanState };")();

console.log(NL + "[① 正交连线:只有 M/H/V/A,起止点正确,圆角随短边夹紧]");
{
  const p = G.tlOrthoPath(0, 0, 9, 20, 5);
  ok("右下:M 0 0 → H 4 → A(顺时针) → V 20", /^M 0 0 H 4 A 5 5 0 0 1 9 5 V 20$/.test(p), p);
  const q = G.tlOrthoPath(9, 20, 0, 0, 5);
  ok("左上(合流反向):同一路线,顺时针", /^M 9 20 H 5 A 5 5 0 0 1 0 15 V 0$/.test(q), q);
  const r = G.tlOrthoPath(0, 0, 9, -20, 5);
  ok("右上:逆时针弧", /A 5 5 0 0 0 9 -5 V -20$/.test(r), r);
  ok("竖边比 r 短 → r 夹到竖边(不画超过终点的弧)", /A 2 2 0 0 1 9 2 V 2$/.test(G.tlOrthoPath(0, 0, 9, 2, 5)), G.tlOrthoPath(0, 0, 9, 2, 5));
  ok("横边比 r 短 → r 夹到横边", /^M 0 0 H 0 A 2 2 0 0 1 2 2 V 20$/.test(G.tlOrthoPath(0, 0, 2, 20, 5)), G.tlOrthoPath(0, 0, 2, 20, 5));
  ok("同一水平 → 直线 H;同一竖直 → 直线 V", G.tlOrthoPath(0, 0, 30, 0) === "M 0 0 H 30" && G.tlOrthoPath(0, 0, 0, 30) === "M 0 0 V 30");
  const all = [p, q, r, G.tlOrthoPath(3, 3, -40, 17)];
  ok("命令集只含 M/H/V/A(没有 Q/C 曲线)", all.every((d) => /^[MHVA0-9 .-]+$/.test(d)), all.join(" | "));
}

console.log(NL + "[② 标签底垫:盖住文字,永不压线]");
{
  const wC = G.tlTextWidth("目标看板", 10), wA = G.tlTextWidth("abcd", 10);
  ok("同长度下 CJK 估宽 > ASCII 估宽(CJK ≈ 1em)", wC > wA && Math.abs(wC - 40) < 1e-9, `cjk=${wC} ascii=${wA}`);
  const b = G.tlLabelBox("#12", 100, 50, 10.5, "start", 3);
  ok("start 锚:盒左沿在 x 左侧 pad 处,宽 = 文字 + 2·pad", Math.abs(b.x - 97) < 1e-9 && Math.abs(b.w - (G.tlTextWidth("#12", 10.5) + 6)) < 1e-9, JSON.stringify(b));
  ok("盒在竖直方向盖住基线上下(基线 y 落在盒内)", b.y < 50 && b.y + b.h > 50, JSON.stringify(b));
  const e = G.tlLabelBox("#12", 100, 50, 10.5, "end", 3);
  ok("end 锚:盒右沿在 x 右侧 pad 处", Math.abs(e.x + e.w - 103) < 1e-9, JSON.stringify(e));
  const m = G.tlLabelBox("7", 100, 50, 10, "middle", 3);
  ok("middle 锚:盒以 x 为中心", Math.abs((m.x + m.w / 2) - 100) < 1e-9, JSON.stringify(m));
}

console.log(NL + "[③ 处理段的状态 → 唯一强调色只给「等你」]");
{
  ok("正在处理(span 未收) → active", G.tlSpanState("in_progress", true, true) === "active");
  ok("最后一段收了且卡在等待中 → focal(强调色)", G.tlSpanState("waiting", false, true) === "focal");
  ok("卡已完成的最后一段 → done", G.tlSpanState("done", false, true) === "done");
  ok("历史段(不是最后一段)/其他 → past", G.tlSpanState("waiting", false, false) === "past" && G.tlSpanState("not_started", false, true) === "past");
  ok("等待中但不是最后一段 → 不是 focal(一张卡只亮一处)", G.tlSpanState("waiting", false, false) !== "focal");
}

console.log(NL + "[④ 源码形:画法按规范,死代码已清]");
{
  const cssStart = src.indexOf("/* ── Timeline"), cssEnd = src.indexOf(".ctx{background:var(--panel)", cssStart);
  const css = src.slice(cssStart, cssEnd);
  ok("时间轴 CSS 段里没有字面颜色(全 token)", cssStart > 0 && !/#[0-9a-fA-F]{3,6}\b/.test(css), (css.match(/#[0-9a-fA-F]{3,6}\b/g) || []).join(","));
  ok("底垫 .tl-mask / 条 .tl-bar / 药丸 .tl-pill / 正交边 有 CSS 与产出者",
     /\.tl-mask\{/.test(css) && /class="tl-mask"/.test(src) && /\.tl-bar\{/.test(css) && /class="tl-bar /.test(src) &&
     /\.tl-pill\{/.test(css) && /class="tl-pill"/.test(src) && /tlOrthoPath\(/.test(src.slice(b1)));
  ok("旧画法已退场:没有二次贝塞尔边、没有 5px 粗线段、簇字不再硬编码白色",
     !/class="tl-edge(?: merge)?" d="M [^"]* Q /.test(src) && !/stroke-width="4\.5"/.test(src) && !/\.tl-cluster text\{[^}]*#fff/.test(css));
  ok("死 CSS 已删(.tl-lab / .tl-head / .tl-seg.not_started / .tl-seg.goal)", !/\.tl-lab\{|\.tl-head\{|\.tl-seg\.not_started|\.tl-seg\.goal/.test(css));
  ok("引导里 cmd/focus 两个无产出者的动作分支已删(P3-5)", !/a\.type === "cmd"/.test(src) && !/a\.type === "focus"/.test(src) && !/data-guide-copy/.test(src));
  ok("等待中的强调只在 focal 条与等待节点上(全图只此一色)", (src.match(/var\(--accent\)/g) || []).length >= 2);
}

console.log(`${NL}${"─".repeat(56)}${NL}result: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
