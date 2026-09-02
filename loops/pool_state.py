"""订阅池失效信号的纯判定与 loop 上报辅助。

额度不是美元/token 预测问题(见 INCIDENT-8):只有 CLI 实际失败且输出命中
限额文字时才产生信号。共享 ``pool_state.json`` 由 server 单写;
loop 不直接改同一 JSON,避免并发覆盖另一池。
"""

import datetime
import re


POOL_HOLD_SECONDS = 5 * 60 * 60
POOLS = ("claude", "codex")
RATE_LIMIT_PAT = re.compile(
    r"rate.?limit|usage limit|session limit|quota|too many requests|\b429\b|"
    r"limit (?:reached|exceeded)|resets? (?:in|at)|you(?:'|’)ve hit (?:your|the) limit|"
    r"利用上限|使用量の上限|レート制限|限流|超出.{0,6}限制",
    re.I,
)


def exhaustion_notice(runtime, text, now=None, hold_seconds=POOL_HOLD_SECONDS):
    """命中限流则返回带时刻的 notice(交给 server),否则 None(纯函数)。"""
    if runtime not in POOLS or not RATE_LIMIT_PAT.search(str(text or "")):
        return None
    at = now or datetime.datetime.now(datetime.timezone.utc)
    if at.tzinfo is None:
        at = at.replace(tzinfo=datetime.timezone.utc)
    at = at.astimezone(datetime.timezone.utc)
    until = at + datetime.timedelta(seconds=float(hold_seconds))
    iso = lambda d: d.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return {"runtime": runtime, "exhausted_at": iso(at), "until": iso(until)}


def report_exhausted(call, runtime, text, log=None):
    """命中时只向本地 server 上报;共享档仍由 server 单写。"""
    notice = exhaustion_notice(runtime, text)
    if not notice:
        return None
    try:
        status, body = call("POST", "/api/pools/exhausted", notice)
        if status != 200:
            if log:
                log(f"  ⚠池失效上报被拒 HTTP {status}:{(body or {}).get('error', '')}")
            return None
        return body
    except Exception as exc:
        if log:
            log(f"  ⚠池失效上报失败:{exc}")
        return None
