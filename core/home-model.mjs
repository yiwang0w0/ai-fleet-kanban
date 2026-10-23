// 终端直接读取 panel.html 的 home-model 纯逻辑区，与首页共享告警、合并规则和下一步文案。
// 此区不依赖 DOM、外部状态或时钟；hometest 使用同样的切片方式，不维护第二份展示规则。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CODE_ROOT } from "./env.mjs";

const B0 = "// ── home-model(pure;tests/hometest.mjs)──", B1 = "// ── /home-model ──";
export function loadHomeModel(file = join(CODE_ROOT, "core", "panel.html")) {
  const src = readFileSync(file, "utf8"), a = src.indexOf(B0), b = src.indexOf(B1);
  if (a < 0 || b < a) throw new Error(`${file} 里找不到首页模型(home-model 标记)`);
  return new Function(src.slice(src.indexOf("\n", a) + 1, b) + ";return { homeStatus, homeName };")();
}
