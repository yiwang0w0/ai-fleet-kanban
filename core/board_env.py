# -*- coding: utf-8 -*-
"""board_env —— fleet.config.json 的部署键(port / repo / gated_subtree)对 python
客户端的**唯一**接线点(cli/board.py、两哨、两 loop 共用;写五份必有一份腐烂)。

机制=「读配置→回填 os.environ 缺省」:env 已设的键一个不碰(env 永远赢),
之后每个客户端**既有的 env 读取代码零改动**。这替代的是把同一个端口在 server
和每个客户端 shell 里各设一遍的编排——盲装实测里,漏设的那一侧会去敲默认
端口上别人的活板。

调用形:import board_env; board_env.apply()  ——必须在读 BOARD_* env 之前。
配置文件坏了:警告后按纯 env 继续(server 侧才是拒启的地方;客户端拒启会把
一个坏文件变成连 `board.py ls` 都做不了的全瘫)。"""
import io
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
CODE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
CONFIG_FILE = os.environ.get("BOARD_CONFIG") or os.path.join(CODE_ROOT, "fleet.config.json")

_KEYS = (("port", "BOARD_PORT"), ("repo", "BOARD_REPO"), ("gated_subtree", "BOARD_GATED_SUBTREE"))


def load():
    """配置字典;缺文件={},坏文件=警告+{}。"""
    try:
        with io.open(CONFIG_FILE, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}
    except Exception as e:
        print(f"⚠ {CONFIG_FILE} 读不了({e})—— 忽略配置,按环境变量继续", flush=True)
        return {}


def apply():
    """把配置里的部署键回填进 os.environ **缺省**(已设的 env 不动)。返回配置字典。"""
    cfg = load()
    for ck, ek in _KEYS:
        if cfg.get(ck) is not None and not os.environ.get(ek):
            os.environ[ek] = str(cfg[ck])
    return cfg
