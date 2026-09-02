# -*- coding: utf-8 -*-
"""临时 worker 的持久上下文载体(可选,按 env 配置)。

两类材料,两种待遇:
· **安全基线**(BOARD_BASELINE_DOCS,逗号分隔的仓库相对 .md)——
  已确认不含敏感内容、可安全逐字内联的作业契约。配置了就逐字进每次
  codex prompt,并用哈希清单(BOARD_CONTEXT_MANIFEST)钉住内容;
  清单与代码同受 revision 闸保护,基线被改而未验收即 fail-closed。
· **线路锚点**(WORKER_ANCHOR)—— 可能含业务示例的历史文档,
  只给路径 + hash,让 worker 按需只读技术段,不整篇自动外发。

一份都没配置 = 此门不存在(不给任何舰队强加"必须有基线"的形状);
配置了就是 allowlist:验不过 = 拒绝领卡,不能用失忆会话继续。
"""
import hashlib
import io
import json
import os


def baseline_docs():
    """仓库相对路径列表,来自 env(空 = 未启用基线)。"""
    raw = os.environ.get("BOARD_BASELINE_DOCS", "")
    return tuple(x.strip().replace("\\", "/") for x in raw.split(",") if x.strip())


MAX_BASELINE_CHARS = int(os.environ.get("BOARD_BASELINE_MAX_CHARS", "24000"))
# 哈希清单(仓库相对路径)。启用基线时必须同时提供 —— 没有钉住的"基线"
# 谁改了都没人知道,等于没有。
MANIFEST_REL = os.environ.get("BOARD_CONTEXT_MANIFEST", "")


class ContextError(RuntimeError):
    pass


def _inside(path, root):
    try:
        return os.path.commonpath((os.path.realpath(path), os.path.realpath(root))) == os.path.realpath(root)
    except (ValueError, OSError):
        return False


def doc_info(repo, rel):
    rel = str(rel or "").strip().replace("\\", "/")
    if not rel or os.path.isabs(rel):
        raise ContextError("上下文文件必须是仓库相对路径")
    candidate = os.path.join(repo, *rel.split("/"))
    if not _inside(candidate, repo):
        raise ContextError("上下文文件跳出了仓库")
    if not rel.lower().endswith(".md"):
        raise ContextError("上下文文件只接受 .md")
    if not os.path.isfile(candidate):
        raise ContextError("上下文文件不存在: " + rel)
    real = os.path.realpath(candidate)
    if not _inside(real, repo):
        raise ContextError("上下文文件经链接跳出了仓库: " + rel)
    raw = io.open(real, "rb").read()
    return {"rel": rel, "path": real, "bytes": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
            "text": raw.decode("utf-8", "replace")}


def manifest(repo, docs):
    """读取哈希清单;必须且只能列出配置的基线(多列少列都拒)。"""
    if not MANIFEST_REL:
        raise ContextError(
            "配置了 BOARD_BASELINE_DOCS 却没配 BOARD_CONTEXT_MANIFEST —— "
            "没钉哈希的基线不算基线")
    path = os.path.join(repo, *MANIFEST_REL.replace("\\", "/").split("/"))
    if not _inside(path, repo) or not os.path.isfile(path):
        raise ContextError("上下文哈希清单不存在: " + MANIFEST_REL)
    try:
        data = json.loads(io.open(path, encoding="utf-8").read())
    except Exception as e:
        raise ContextError("上下文哈希清单读不了: %s" % e)
    pins = data.get("docs") if isinstance(data, dict) else None
    if not isinstance(pins, dict) or set(pins) != set(docs):
        raise ContextError("上下文哈希清单必须且只能列出 BOARD_BASELINE_DOCS 声明的基线")
    return pins


def context_gate(repo, anchor=None, runtime="codex"):
    """通过返 None;配置了基线/锚点但验不过时返 loud 理由,供领卡前 fail-closed。
    什么都没配置 = 直接通过(此门未启用)。"""
    try:
        docs = baseline_docs()
        if runtime == "codex" and docs:
            pins = manifest(repo, docs)
            for rel in docs:
                info = doc_info(repo, rel)
                if len(info["text"]) > MAX_BASELINE_CHARS:
                    raise ContextError("可内联基线过长,需人工压缩: " + rel)
                if info["sha256"] != str(pins.get(rel) or "").lower():
                    raise ContextError("可内联基线与已验收哈希不一致: " + rel)
        if anchor:
            doc_info(repo, anchor)
    except ContextError as e:
        return "[context] ⛔ " + str(e) + " —— 拒绝领卡;先修复基线/锚点,不能用失忆会话继续。"
    return None


def prompt_block(repo, anchor=None, runtime="codex"):
    """返回 prompt 段。原始锚点不自动内联,避免无差别发送历史业务示例。"""
    if runtime != "codex":
        return []
    gate = context_gate(repo, anchor, runtime)
    if gate:
        raise ContextError(gate)
    docs = baseline_docs()
    if not docs and not anchor:
        return []
    out = []
    if docs:
        out += ["", "【每次新会话的持久上下文 —— 下面的基线由 loop 读盘后逐字内联】",
                "你是临时会话,不能假设自己记得上一张卡或此前的讨论。"
                "以下内容是本轮必须遵守的导航与作业契约。"]
        for rel in docs:
            info = doc_info(repo, rel)
            out += ["", "--- %s · sha256=%s ---" % (rel, info["sha256"]), info["text"].strip()]
    if anchor:
        info = doc_info(repo, anchor)
        out += ["", "【本线路历史锚点】%s · sha256=%s · %d bytes" %
                (info["rel"], info["sha256"], info["bytes"]),
                "这份历史可能含业务示例,所以不整篇自动内联。当前卡碰到其中已裁定的技术概念时,"
                "必须用 Read/Grep 只读相关技术段,并在证据写明采用的章节或关键词;"
                "跳过业务示例,禁止复制或输出真实业务数据。"]
    return out
