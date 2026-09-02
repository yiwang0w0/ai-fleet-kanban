// The goal-decomposition prompt, as a pure function.
//
// Why it lives in its own module: server.mjs starts listening the moment it is
// imported, so anything built inside it can only be observed by spawning a real CLI
// — and a .cmd stub cannot be spawned at all (Node refuses .bat/.cmd without a
// shell, measured), while a Node stub never sees the arguments (Node rejects the
// unknown flags before any preload runs, also measured). The result was a whole
// generated surface with NO machine coverage: the line menu, the "continues an
// earlier goal" block and the output language could each break silently.
// Pulling the string-building out makes it a pure function with a test, following
// the same shape as decision_lib.js.
//
// The board's own display language is Chinese; the language the GENERATED CARDS are
// written in is a fleet property (`language` in fleet.config.json). Absent = say
// nothing, and the model mirrors the prompt's language, which is what every
// existing deployment already gets.
"use strict";

const NL = String.fromCharCode(10);

/** The line menu shown to the decomposer. BUILT from config — a hand-copied list
 *  once silently dropped a line, and nothing could tell. */
function lineMenu(lines, hints = {}) {
  return lines.map((l) => (hints[l] ? `${l} (${hints[l]})` : l)).join(", ");
}

/**
 * @param goal     the goal card (subject/description/id required)
 * @param prev     the goal this one continues, or null. Only a card whose kind is
 *                 "goal" counts; anything else is ignored.
 * @param outPath  absolute path the decomposer must write its JSON to
 * @param lines    line ids from config
 * @param hints    line id -> hint text
 * @param language natural language for generated card text ("" = say nothing)
 */
function buildDecomposePrompt({ goal, prev = null, outPath, lines, hints = {}, language = "" }) {
  const lang = String(language || "").trim();
  return [
    "把下面这个目标拆成可以独立交付的子任务。你**不做这些活**,只做拆解。",
    "",
    `目标 #${goal.id}:${goal.subject}`,
    goal.description ? "背景/要求:" + NL + goal.description : "",
    // ⭐ Goals may CONTINUE earlier goals: when hung under a completed goal, the
    //   decomposition thinks WITH the predecessor's completion record — continue,
    //   don't re-plan or redo what is done.
    ...(prev && prev.kind === "goal"
      ? ["",
         `⭐本目标衔接既往目标 #${prev.id}「${prev.subject}」(${prev.status === "done" ? "已完成" : prev.status})。`,
         "拆解时接着它的成果想:已完成的事不要重做,新子任务要说清与前作产出的衔接点。",
         "前作完成记录:",
         String(prev.result || "(无完成记录)").slice(0, 1200)]
      : []),
    "",
    "拆解规则:",
    "- **一张卡 = 一个可独立验收的产出**。复合的要切开。",
    "- 顺序有依赖就用 after 指出前置(填同一批里的序号,从 1 开始);没有就不填。",
    "- 每张卡要写清 acceptance:怎么判这活干没干成,能给可执行命令就给。",
    `- line 从这些里选:${lineMenu(lines, hints)};拿不准就填 null,谁都能领。`,
    "- 要跑命令的卡把 needs_bash 设成 true;只读写文件的不要设。",
    "- 涉及生产数据、DB migration、删除、push、花钱的,**在 description 里显式写明需要人确认**。",
    "- 别拆太碎:3〜8 张为宜。拆不动就只出 1 张。",
    ...(lang ? [`- **卡片正文(subject/description/acceptance)一律用 ${lang} 书写**。`] : []),
    "",
    "只做一件事:用 Write 工具把结果写进这个文件,别的什么都不要动。",
    `  ${outPath}`,
    "",
    "内容是 JSON,不要包代码块:",
    '{"tasks":[{"subject":"...","description":"...","acceptance":"...","line":"' +
      lines.join("|") + '|null","needs_bash":false,"after":[]}]}',
  ].filter(Boolean).join(NL);
}

module.exports = { buildDecomposePrompt, lineMenu };
