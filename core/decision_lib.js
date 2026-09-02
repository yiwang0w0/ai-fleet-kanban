// Structured contract for final rulings + the attachment download/handoff guard chain.
// The UI reads only the normalized structure produced here; verdict_note stays as
// the immutable human-readable history.
//
// Handoff generalization (operator ruling 2026-09-01): hand-executed deliverables
// are NOT necessarily SQL. The operator AUTHORIZES local directories as classified
// handoff destinations — `targets` below. Authorization is the declaration:
// only declared directories are ever written (allowlist polarity), each with its
// own extension allowlist and admission name pattern.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// no attachment action needed vs. files a human must take away and apply.
// Legacy values from the first generation ("no_sql" / "sql_apply") are normalized.
const KIND = new Set(["none", "apply"]);
const LEGACY_KIND = { no_sql: "none", sql_apply: "apply" };
const ROLE = new Set(["apply", "rollback", "companion"]);
const isExecutableRole = (role) => role === "apply" || role === "rollback";

const text = (v) => String(v == null ? "" : v).trim();
const sha256 = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
// Containment check for the allowlist gates. ⚠ Case-folding is a WINDOWS property:
// folding on a case-sensitive filesystem makes /x/Dir count as inside /x/dir — the
// allowlist widens, i.e. the error lands on the permitting side. Fold only where
// the filesystem itself does.
const foldCase = process.platform === "win32" ? (s) => s.toLowerCase() : (s) => s;
const within = (child, root) => {
  const c = foldCase(path.resolve(child));
  const r = foldCase(path.resolve(root));
  return c === r || c.startsWith(r + path.sep);
};

// ── Configurable attachment roots ─────────────────────────────────────────────
// Where ruling attachments may COME FROM (inside the repo). Relative entries
// resolve against repoRoot; absolute entries pass through. Separator ";" or ","
// (fixed, so one config string works on every OS).
const DEFAULT_ROOTS = (process.env.BOARD_ATTACHMENT_ROOTS || "migrations;tools;docs")
  .split(/[;,]/).map((s) => s.trim()).filter(Boolean);
// The subset of roots whose files count as APPLY material in the PROSE fallback
// (default role=apply and the "this option applies something" signal).
const APPLY_ROOTS = (process.env.BOARD_ATTACHMENT_APPLY_ROOTS || "migrations")
  .split(/[;,]/).map((s) => s.trim()).filter(Boolean);
// Extensions the PROSE sniffer picks up. Deliberately conservative (default: sql) —
// the structured package is the primary road and is not limited by this; sniffing
// arbitrary extensions out of prose would drown the fallback in false paths.
const SNIFF_EXTS = (process.env.BOARD_ATTACHMENT_EXTS || "sql")
  .split(/[;,]/).map((s) => s.trim().replace(/^\./, "").toLowerCase()).filter(Boolean);

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const rootAlt = (roots) => roots
  .filter((r) => !path.isAbsolute(r))
  .map((r) => escRe(r).replaceAll("/", "[\\\\/]"))
  .join("|");
const APPLY_ROOT_RE = new RegExp(`^(?:${rootAlt(APPLY_ROOTS) || "(?!)"})[\\\\/]`, "i");

function attachmentPathsFrom(s) {
  const out = [];
  const seen = new Set();
  const extAlt = SNIFF_EXTS.map(escRe).join("|") || "(?!)";
  const patterns = [
    new RegExp(`(?:\`|\\b)((?:${rootAlt(DEFAULT_ROOTS) || "(?!)"})[\\\\/][^\`\\s"'<>]+?\\.(?:${extAlt}))(?:\`|\\b)`, "gi"),
    new RegExp(`(?:\`|\\b)([A-Za-z]:[\\\\/][^\`\\r\\n"'<>]+?\\.(?:${extAlt}))(?:\`|\\b)`, "gi"),
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(String(s || "")))) {
      const p = m[1].replaceAll("\\", "/");
      // ⚠ Measured: a command-line GLOB in prose was picked up as a path and the
      //   ruling package listed an impossible row ("0119_*.sql · does not exist").
      //   A glob is not a file; its existence is not a question to ask.
      if (/[*?\[\]]/.test(p)) continue;
      if (!seen.has(p)) { seen.add(p); out.push(p); }
    }
  }
  return out;
}

// ── Handoff targets ───────────────────────────────────────────────────────────
// The operator's authorized destinations. Each target:
//   { id, label, dir, exts (array|null=any), namePattern (RegExp) }
// Default admission pattern keeps the SERIAL shape (traceability, no-overwrite
// ordering) while opening the file TYPE — exactly the ruling's direction.
const DEFAULT_NAME_PATTERN = /^\d{4}(?:[_-].+)?\.[a-z0-9]+$/i;
function normalizeTargets(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const t of raw) {
    const id = text(t && t.id);
    const dir = text(t && t.dir);
    if (!id || !dir) continue;                       // unusable rows are dropped loudly by the server's config gate
    if (seen.has(id)) continue;
    seen.add(id);
    let namePattern = DEFAULT_NAME_PATTERN;
    if (t.name_pattern) {
      try { namePattern = new RegExp(t.name_pattern, "i"); }
      catch (e) {
        // Loud fallback — a silently dead pattern would either admit everything or
        // nothing depending on how it broke.
        console.error(`⚠ handoff 目标 "${id}": name_pattern 不可用(${e.message})—— 退回默认序号名形`);
      }
    }
    const exts = Array.isArray(t.exts) && t.exts.length
      ? t.exts.map((x) => String(x).replace(/^\./, "").toLowerCase())
      : null;                                        // null = any extension
    out.push({ id, label: text(t.label) || id, dir, exts, namePattern });
  }
  return out;
}
function targetOf(targets, id) {
  const list = Array.isArray(targets) ? targets : [];
  if (id == null || id === "") return list[0] || null;   // unspecified = the first declared target
  return list.find((t) => t.id === String(id)) || null;
}

// ── Legacy prose fallback ─────────────────────────────────────────────────────
// Parses a reviewer-written PROSE ruling into the structured shape. This grammar
// is the contract for any reviewer's prose fallback:
//   ## needs your confirmation
//   <summary>
//   ### options
//   **A. Title** [← **recommended**]
//   - what: ...
//   - cost: ...
//   (option blocks end at the next **X. **, the next ### heading, or an appended
//    "—— auto review" ruling record)
function legacyDecisionPackage(note) {
  const src = String(note || "");
  if (!/##\s*需要你确认/.test(src) || !/###\s*方案/.test(src)) return null;
  const head = src.split(/###\s*方案/)[0].replace(/^.*?##\s*需要你确认\s*/s, "").trim();
  const area = (src.split(/###\s*方案/)[1] || "").split(/\n###\s+/)[0];
  const options = [];
  const re = /\*\*([A-Z])\.\s*([^*\r\n]+?)\*\*([^]*?)(?=\n\*\*[A-Z]\.\s|\n###\s|\n——\s*自动审阅|$)/g;
  let m;
  while ((m = re.exec(area))) {
    const block = m[3] || "";
    const detail = (block.match(/-\s*做什么\s*[:：]\s*([^]*?)(?=\n-\s*代价\s*[:：]|$)/) || [])[1] || "";
    const cost = (block.match(/-\s*代价\s*[:：]\s*([^]*?)$/) || [])[1] || "";
    const paths = attachmentPathsFrom(block);
    const applyWords = /\b(?:apply|migration|DDL|DML)\b|迁移|本番\s*DB|生产\s*DB|production\s+DB|SQL\s*Editor[^\n]*(?:run|execute|apply|手跑|执行|运行)/i;
    const applyLike = paths.some((p) => APPLY_ROOT_RE.test(p)) || applyWords.test(block);
    const files = paths.map((p) => ({
      path: p,
      label: path.basename(p.replaceAll("/", path.sep)),
      role: APPLY_ROOT_RE.test(p) ? "apply" : "companion",
      archive_name: path.basename(p.replaceAll("/", path.sep)),
      target: null,
    }));
    options.push({
      key: m[1].toUpperCase(), title: text(m[2]), detail: text(detail), cost: text(cost),
      kind: applyLike ? "apply" : "none", files,
    });
  }
  if (!options.length) return null;
  const rec = (area.match(/\*\*([A-Z])\.[^\n]*\*\*\s*←\s*\*\*推荐\*\*/) || [])[1] || "";
  return { version: 1, source: "legacy", summary: head, options, recommend: rec.toUpperCase(),
           checked: [], reason: "", generated_at: null, model: null };
}

function normalizeAttachment(f) {
  if (!f || typeof f !== "object") return null;
  const role = ROLE.has(f.role) ? f.role : "companion";
  const p = text(f.path);
  if (!p) return null;
  return { path: p, label: text(f.label) || path.basename(p), role,
           archive_name: text(f.archive_name) || path.basename(p),
           target: text(f.target) || null };
}

function normalizeDecisionPackage(raw, fallbackNote = "") {
  let p = raw;
  if (typeof p === "string" && p.trim()) {
    try { p = JSON.parse(p); } catch { p = null; }
  }
  if (!p || typeof p !== "object") return legacyDecisionPackage(fallbackNote);
  const options = Array.isArray(p.options) ? p.options.map((o) => {
    const rawKind = o && o.kind;
    const kind = KIND.has(rawKind) ? rawKind
      : (LEGACY_KIND[rawKind] || "none");            // legacy wire values normalize, unknown falls to "none"
    // `files` is the current wire key; `sql_files` is accepted as the legacy alias.
    const rawFiles = Array.isArray(o && o.files) ? o.files
      : Array.isArray(o && o.sql_files) ? o.sql_files : [];
    return {
      key: text(o && o.key).toUpperCase(), title: text(o && o.title),
      detail: text(o && o.detail), cost: text(o && o.cost),
      kind,
      files: rawFiles.map(normalizeAttachment).filter(Boolean),
    };
  }).filter((o) => o.key && o.title) : [];
  if (!options.length) return legacyDecisionPackage(fallbackNote);
  return {
    version: 1, source: text(p.source) || "structured", summary: text(p.summary), options,
    recommend: text(p.recommend).toUpperCase(), checked: Array.isArray(p.checked) ? p.checked.map(text).filter(Boolean) : [],
    reason: text(p.reason), generated_at: text(p.generated_at) || null, model: text(p.model) || null,
  };
}

// ctx contract: { repoRoot, targets, attachmentRoots? }.
// targets = normalized handoff targets (the server assembles them from
// fleet.config handoff_targets / BOARD_HANDOFF_DIR).
function resolveAttachment(spec, { repoRoot, targets, attachmentRoots = DEFAULT_ROOTS }, { forTarget = null } = {}) {
  const raw = text(spec && spec.path);
  if (!raw) throw new Error("附件没有 path");
  const ext = path.extname(raw).replace(/^\./, "").toLowerCase();
  // Per-target extension allowlist (null = any). This replaces the old global
  // ".sql only" rule — the TYPE is the target's business now.
  if (forTarget && forTarget.exts && !forTarget.exts.includes(ext))
    throw new Error(`目标 "${forTarget.id}" 只接受 .${forTarget.exts.join("/.")} —— 收到 .${ext || "(无)"}`);
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(repoRoot, raw);
  const allowedRoots = attachmentRoots
    .map((r) => (path.isAbsolute(r) ? r : path.join(repoRoot, r)))
    .concat((targets || []).map((t) => t.dir));
  if (!allowedRoots.some((root) => within(candidate, root))) throw new Error("附件路径不在允许目录内");
  const low = candidate.replaceAll("\\", "/").toLowerCase();
  // Deny-list INSIDE the allowlist: secrets and runtime state that may legitimately
  // sit under an allowed root but must never ride out as a ruling attachment.
  if (/(?:^|\/)\.env(?:\.|$)|\/\.data\//.test(low))
    throw new Error("附件路径落在受保护目录");
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) throw new Error("附件文件不存在");
  const real = fs.realpathSync(candidate);
  if (!allowedRoots.some((root) => fs.existsSync(root) && within(real, fs.realpathSync(root))))
    throw new Error("附件经链接跳出了允许目录");
  return { path: real, name: path.basename(real), bytes: fs.statSync(real).size, sha256: sha256(real) };
}

/** Directory part of a path only — the minimum a screen needs to tell "the apply
 *  body" from "a verification fragment". */
const dirOf = (p) => {
  const d = String(p || "").split(String.fromCharCode(92)).join("/").split("/").slice(0, -1).join("/");
  return d || ".";
};

/** dirOf for the PUBLIC surface. A relative declaration passes through; an
 *  absolute one relativizes against repoRoot or collapses to "…" — the LAYER is
 *  what the screen needs, the machine's real layout is not. ⭐ Before this,
 *  a card declaring an in-allowlist absolute path put the drive letter, user
 *  name and repo directory on /api/tasks (flagged by an outside review), while
 *  the comment below promised "the full path is NOT". Unresolvable paths take
 *  the same route: the error branch leaks just as well as the happy one. */
const publicDirOf = (p, repoRoot) => {
  const norm = String(p || "").split(String.fromCharCode(92)).join("/");
  if (!path.isAbsolute(norm)) return dirOf(norm);
  try {
    const rel = path.relative(repoRoot, path.resolve(norm));
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel))
      return dirOf(rel.split(String.fromCharCode(92)).join("/"));
  } catch {}
  return "…";
};

function publicDecisionPackage(task, ctx) {
  const p = normalizeDecisionPackage(task && task.decision_package, task && task.verdict_note);
  if (!p) return null;
  return { ...p, options: p.options.map((o) => {
    const files = o.files.map((f, i) => {
      const executable = isExecutableRole(f.role);
      const tgt = executable ? targetOf(ctx.targets, f.target) : null;
      const fileUrl = `/api/tasks/${Number(task.id)}/decision-attachment/${encodeURIComponent(o.key)}/${i}`;
      try {
        if (executable && f.target && !tgt) throw new Error(`未知的 handoff 目标 "${f.target}"`);
        const x = resolveAttachment(f, ctx, { forTarget: tgt });
        // ⭐ The dir IS disclosed (an apply body and a same-numbered verification
        //   fragment once collapsed to the same name on screen — the LAYER tells
        //   them apart). The full path is NOT. Targets surface as id+label only —
        //   never their directories.
        const publicFile = { label: f.label || x.name, name: x.name, dir: publicDirOf(f.path, ctx.repoRoot), role: f.role,
                             archive_name: f.archive_name, bytes: x.bytes, sha256: x.sha256,
                             available: true, executable,
                             ...(tgt ? { target: tgt.id, target_label: tgt.label } : {}) };
        // companion = generator input, verification fragment or reference spec;
        // viewable, but it must not impersonate an executable attachment.
        return executable ? { ...publicFile, download_url: fileUrl } : { ...publicFile, view_url: fileUrl };
      } catch (e) {
        return { label: f.label || path.basename(f.path), name: path.basename(f.path), dir: publicDirOf(f.path, ctx.repoRoot),
                 role: f.role, archive_name: f.archive_name, available: false, executable,
                 ...(tgt ? { target: tgt.id, target_label: tgt.label } : {}),
                 error: String(e.message || e) };
      }
    });
    const executionFiles = files.filter((f) => f.executable);
    const ready = o.kind !== "apply" ||
      (executionFiles.length > 0 && files.every((f) => f.available));
    return { ...o, files, ready };
  }) };
}

function decisionAttachmentSource(task, optionKey, fileIndex, ctx) {
  const p = normalizeDecisionPackage(task && task.decision_package, task && task.verdict_note);
  const o = p && p.options.find((x) => x.key === String(optionKey || "").toUpperCase());
  const f = o && o.files[Number(fileIndex)];
  if (!f) throw new Error("裁定附件不存在");
  const tgt = isExecutableRole(f.role) ? targetOf(ctx.targets, f.target) : null;
  return { ...resolveAttachment(f, ctx, { forTarget: tgt }), label: f.label, role: f.role, archive_name: f.archive_name };
}

// Note for readers coming from the store: store.resolve's parameter names
// (sqlReceipt/sqlArchive) and the DB columns (decision_sql_archive,
// decision_receipt) keep their HISTORIC names — the content is generalized, the
// pipes were not renamed (the closed 288-assert suite stays closed).
function archiveOptionFiles(task, optionKey, ctx) {
  const targets = ctx.targets || [];
  const p = normalizeDecisionPackage(task && task.decision_package, task && task.verdict_note);
  const o = p && p.options.find((x) => x.key === String(optionKey || "").toUpperCase());
  if (!o) throw new Error("选择的方案不存在");
  if (o.kind !== "apply") return [];
  if (!o.files.length) throw new Error("该方案需要人手应用的文件,但卡片没有附件");
  if (!o.files.some((f) => isExecutableRole(f.role)))
    throw new Error("该方案只有非执行用 companion,没有 apply / rollback 文件");
  if (!targets.length)
    throw new Error("没有配置任何 handoff 目标 —— 在 fleet.config.json 声明 handoff_targets(或设 BOARD_HANDOFF_DIR)");
  const resolved = o.files.filter((f) => isExecutableRole(f.role) || f.target).map((f) => {
    const tgt = targetOf(targets, f.target);
    if (!tgt) throw new Error(`未知的 handoff 目标 "${f.target}" —— 已声明: ${targets.map((t) => t.id).join("/")}`);
    return { spec: f, tgt };
  });
  // Companions without an explicit target stay in the repo (viewable), they are
  // not handed off. Executable files ALWAYS hand off.
  const toArchive = resolved.filter((x) => isExecutableRole(x.spec.role) || x.spec.target);
  for (const x of toArchive) {
    const name = path.basename(text(x.spec.archive_name) || path.basename(x.spec.path));
    if (!x.tgt.namePattern.test(name))
      throw new Error(`文件 ${name} 不符合目标 "${x.tgt.id}" 的准入名形 ${x.tgt.namePattern} —— 拒绝归档`);
  }
  const files = toArchive.map((x) => ({ ...x, file: resolveAttachment(x.spec, ctx, { forTarget: x.tgt }) }));
  for (const x of files) {
    if (!fs.existsSync(x.tgt.dir) || !fs.statSync(x.tgt.dir).isDirectory())
      throw new Error(`handoff 目标 "${x.tgt.id}" 的目录不存在:已声明但本机没有`);
  }
  // Pre-check EVERY destination before copying ANY file: a name conflict on a later
  // file must not leave earlier files half-landed.
  const plan = [];
  const seen = new Map();
  for (const x of files) {
    const name = path.basename(text(x.spec.archive_name) || x.file.name);
    const dest = path.join(x.tgt.dir, name);
    const key = dest.toLowerCase();
    const prior = seen.get(key);
    if (prior && prior !== x.file.sha256) throw new Error(`该方案含同名异内容文件: ${name}`);
    if (prior) continue;
    seen.set(key, x.file.sha256);
    if (path.resolve(dest).toLowerCase() === path.resolve(x.file.path).toLowerCase()) {
      plan.push({ name, dest, target: x.tgt.id, source: x.file.path, sha256: x.file.sha256, status: "already_present" });
      continue;
    }
    if (fs.existsSync(dest)) {
      const there = sha256(dest);
      if (there !== x.file.sha256) throw new Error(`handoff 目标 "${x.tgt.id}" 已有同名异内容文件: ${name}`);
      plan.push({ name, dest, target: x.tgt.id, source: x.file.path, sha256: there, status: "already_present" });
      continue;
    }
    plan.push({ name, dest, target: x.tgt.id, source: x.file.path, sha256: x.file.sha256, status: "copied" });
  }
  // Test seam ONLY: lets the harness rewrite a source between admission and copy
  // to prove the landed-bytes verification below goes red without it. Logs on use.
  if (ctx && typeof ctx.testOnly_beforeCopy === "function") {
    console.error("⚠ testOnly_beforeCopy seam active(仅供测试)");
    ctx.testOnly_beforeCopy(plan);
  }
  for (const x of plan) if (x.status === "copied") {
    fs.copyFileSync(x.source, x.dest, fs.constants.COPYFILE_EXCL);
    // ⭐ The receipt vouches for the LANDED bytes, not the admitted ones. Admission
    //   (sha256 at package time) and apply (this copy) can be hours apart, and the
    //   source path stays live in between — a worker, an editor, anything can
    //   rewrite it (TOCTOU, flagged by an outside review). The already_present
    //   branch above always re-hashed; the copied branch must too: verify the
    //   destination against the admitted hash, and on mismatch remove what just
    //   landed and refuse — a receipt for unchecked bytes is worse than none.
    const landed = sha256(x.dest);
    if (landed !== x.sha256) {
      try { fs.unlinkSync(x.dest); } catch {}
      throw new Error(`附件 "${x.name}" 在准入后被修改(落盘哈希 ≠ 准入哈希)—— 本次归档中止,请重新过目该方案`);
    }
  }
  return plan.map(({ name, sha256, status, target }) => ({ name, sha256, status, target }));
}

module.exports = {
  legacyDecisionPackage, normalizeDecisionPackage, publicDecisionPackage,
  decisionAttachmentSource, archiveOptionFiles, resolveAttachment,
  normalizeTargets, targetOf, DEFAULT_NAME_PATTERN, publicDirOf,
};
