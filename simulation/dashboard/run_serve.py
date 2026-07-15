#!/usr/bin/env python3
import argparse
import json
import mimetypes
import re
from dataclasses import asdict, dataclass
from datetime import datetime
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse
from typing import Optional

USERSPACE_POST_EVENT_LIMIT = 500

CC_NAMES = {
    1: "DCQCN",
    3: "HPCC",
    7: "TIMELY",
    8: "DCTCP",
    10: "HPCC-PINT",
}

SCRIPT_DIR = Path(__file__).resolve().parent
SIM_DIR_DEFAULT = SCRIPT_DIR.parent


@dataclass
class Link:
    src: int
    dst: int
    src_port: Optional[int]
    dst_port: Optional[int]
    rate: str
    delay: str
    error: str


@dataclass
class Flow:
    index: int
    src: int
    dst: int
    pg: int
    dport: int
    size_bytes: int
    start_s: float
    start_ns: int


@dataclass
class FctRecord:
    index: int
    src: int
    dst: int
    sport: int
    dport: int
    size_bytes: int
    start_ns: int
    fct_ns: int
    standalone_delay_ns: int
    finish_ns: int
    avg_throughput_gbps: float


def read_lines(path: Path):
    if not path.exists():
        return []
    out = []
    for raw in path.read_text(errors="ignore").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        out.append(line)
    return out


def safe_int(s, default=None):
    try:
        return int(s)
    except Exception:
        return default


def parse_config(path: Path):
    cfg = {}
    for line in read_lines(path):
        parts = line.split()
        if len(parts) >= 2:
            cfg[parts[0]] = parts[1]

    cc_code = safe_int(cfg.get("CC_MODE"), None)
    schedule_enable = safe_int(cfg.get("OCS_SCHEDULE_ENABLE"), None)
    rnic_gate_enable = safe_int(cfg.get("RNIC_GATE_ENABLE"), 1)

    injection_mode_names = {
        0: "Default RDMA",
        1: "RNIC Gate",
        2: "Userspace Admission",
    }

    injection_layer_names = {
        0: "default",
        1: "rnic",
        2: "userspace",
    }

    return {
        "raw": cfg,
        "ccMode": cc_code,
        "ccName": CC_NAMES.get(cc_code, f"UNKNOWN({cc_code})" if cc_code is not None else "-"),
        "ocsMode": "schedule" if schedule_enable == 1 else ("map" if schedule_enable == 0 else "-"),
        "rnicGateEnable": rnic_gate_enable,
        "rnicGateMode": "enabled" if rnic_gate_enable == 1 else "disabled",
        "injectionMode": rnic_gate_enable,
        "injectionModeName": injection_mode_names.get(rnic_gate_enable, f"UNKNOWN({rnic_gate_enable})"),
        "injectionLayer": injection_layer_names.get(rnic_gate_enable, "unknown"),
    }


def parse_topology(path: Path):
    lines = read_lines(path)

    if not lines:
        return {
            "nodes": [],
            "links": [],
            "switches": [],
            "ocs": [],
            "rnics": [],
            "totalNodes": 0,
            "switchCount": 0,
            "ocsCount": 0,
            "linkCount": 0,
            "ocsPortToNeighbor": {},
        }

    first = lines[0].split()

    if len(first) == 3:
        # Legacy format:
        # total_node_num switch_node_num link_num
        total_nodes = int(first[0])
        switch_count = int(first[1])
        ocs_count = 0
        link_count = int(first[2])
        header_mode = "legacy"
    elif len(first) == 4:
        # OCS-aware format:
        # total_node_num switch_node_num ocs_node_num link_num
        total_nodes = int(first[0])
        switch_count = int(first[1])
        ocs_count = int(first[2])
        link_count = int(first[3])
        header_mode = "ocs"
    else:
        return {
            "nodes": [],
            "links": [],
            "switches": [],
            "ocs": [],
            "rnics": [],
            "totalNodes": 0,
            "switchCount": 0,
            "ocsCount": 0,
            "linkCount": 0,
            "ocsPortToNeighbor": {},
            "error": f"invalid topology header: {lines[0]}",
        }

    idx = 1

    switches = []
    if switch_count > 0:
        if idx < len(lines):
            switches = [int(x) for x in lines[idx].split()]
        idx += 1

    ocs_nodes = []
    if ocs_count > 0:
        if idx < len(lines):
            ocs_nodes = [int(x) for x in lines[idx].split()]
        idx += 1

    switch_set = set(switches)
    ocs_set = set(ocs_nodes)

    nodes = []
    for nid in range(total_nodes):
        if nid in ocs_set:
            ntype = "ocs"
        elif nid in switch_set:
            ntype = "eps"
        else:
            ntype = "rnic"

        nodes.append({
            "id": nid,
            "type": ntype,
        })

    links = []
    port_to_neighbor = {}

    for line in lines[idx:idx + link_count]:
        parts = line.split()

        if len(parts) < 5:
            continue

        try:
            src = int(parts[0])
            dst = int(parts[1])
        except Exception:
            continue

        src_port = None
        dst_port = None

        try:
            if src in ocs_set and dst in ocs_set:
                # compact_ocs_ports / with_ocs_ports:
                # src dst src_ocs_port dst_ocs_port rate delay error
                if len(parts) < 7:
                    continue

                src_port = int(parts[2])
                dst_port = int(parts[3])
                rate, delay, err = parts[4], parts[5], parts[6]

            elif src in ocs_set:
                # compact_ocs_ports:
                # src dst src_ocs_port rate delay error
                #
                # with_ocs_ports, if used:
                # src dst src_port dst_port rate delay error
                if len(parts) >= 7:
                    src_port = int(parts[2])
                    # dst is not OCS, so dst_port is not needed by dashboard.
                    rate, delay, err = parts[4], parts[5], parts[6]
                elif len(parts) >= 6:
                    src_port = int(parts[2])
                    rate, delay, err = parts[3], parts[4], parts[5]
                else:
                    continue

            elif dst in ocs_set:
                # compact_ocs_ports:
                # src dst dst_ocs_port rate delay error
                #
                # with_ocs_ports, if used:
                # src dst src_port dst_port rate delay error
                if len(parts) >= 7:
                    # src is not OCS, so src_port is not needed by dashboard.
                    dst_port = int(parts[3])
                    rate, delay, err = parts[4], parts[5], parts[6]
                elif len(parts) >= 6:
                    dst_port = int(parts[2])
                    rate, delay, err = parts[3], parts[4], parts[5]
                else:
                    continue

            else:
                # Legacy / normal EPS link:
                # src dst rate delay error
                #
                # If a with_ocs_ports-style non-OCS link appears:
                # src dst src_port dst_port rate delay error
                if len(parts) >= 7:
                    rate, delay, err = parts[4], parts[5], parts[6]
                else:
                    rate, delay, err = parts[2], parts[3], parts[4]

        except Exception:
            continue

        link = Link(src, dst, src_port, dst_port, rate, delay, err)
        links.append(asdict(link))

        if src in ocs_set and src_port is not None:
            port_to_neighbor[f"{src}:{src_port}"] = {
                "node": dst,
                "peer_port": dst_port if dst_port is not None else 0,
            }

        if dst in ocs_set and dst_port is not None:
            port_to_neighbor[f"{dst}:{dst_port}"] = {
                "node": src,
                "peer_port": src_port if src_port is not None else 0,
            }

    return {
        "totalNodes": total_nodes,
        "switchCount": switch_count,
        "ocsCount": ocs_count,
        "linkCount": link_count,
        "headerMode": header_mode,
        "switches": switches,
        "ocs": ocs_nodes,
        "rnics": [n["id"] for n in nodes if n["type"] == "rnic"],
        "nodes": nodes,
        "links": links,
        "ocsPortToNeighbor": port_to_neighbor,
    }


def parse_schedule(path: Path):
    configs = {}
    entries = []

    for line in read_lines(path):
        parts = line.split()
        if not parts:
            continue

        if parts[0] == "CONFIG" and len(parts) >= 6:
            ocs = int(parts[1])
            epoch_us = int(parts[2])
            slice_us = int(parts[3])
            switching_us = int(parts[4])
            num_slices = int(parts[5])

            configs[ocs] = {
                "ocs": ocs,
                "epochStartUs": epoch_us,
                "epochStartNs": epoch_us * 1000,
                "sliceDurationUs": slice_us,
                "sliceDurationNs": slice_us * 1000,
                "switchingTimeUs": switching_us,
                "switchingTimeNs": switching_us * 1000,
                "numSlices": num_slices,
                "periodUs": slice_us * num_slices,
                "periodNs": slice_us * num_slices * 1000,
            }

        elif len(parts) >= 4:
            try:
                entries.append({
                    "ocs": int(parts[0]),
                    "slice": int(parts[1]),
                    "a": int(parts[2]),
                    "b": int(parts[3]),
                })
            except Exception:
                pass

    return {
        "configs": list(configs.values()),
        "entries": entries,
    }

def parse_ocs_map(path: Path):
    entries = []

    for line in read_lines(path):
        parts = line.split()

        if len(parts) < 3:
            continue

        try:
            ocs = int(parts[0])
            a = int(parts[1])
            b = int(parts[2])
        except Exception:
            continue

        entries.append({
            "ocs": ocs,
            "slice": 0,
            "a": a,
            "b": b,
        })

    return entries


def parse_flows(path: Path):
    lines = read_lines(path)
    if not lines:
        return []

    flow_count = None
    start_idx = 0

    first = lines[0].split()
    if len(first) == 1 and safe_int(first[0]) is not None:
        flow_count = int(first[0])
        start_idx = 1

    flows = []

    for line in lines[start_idx:]:
        if flow_count is not None and len(flows) >= flow_count:
            break

        parts = line.split()
        if len(parts) < 6:
            continue

        try:
            src = int(parts[0])
            dst = int(parts[1])
            pg = int(parts[2])
            dport = int(parts[3])
            size = int(parts[4])
            start_s = float(parts[5])
        except Exception:
            continue

        flows.append(Flow(
            index=len(flows),
            src=src,
            dst=dst,
            pg=pg,
            dport=dport,
            size_bytes=size,
            start_s=start_s,
            start_ns=int(round(start_s * 1_000_000_000)),
        ))

    return flows


def decode_fct_endpoint(token: str):
    token = token.strip()

    if token.startswith("0b") and len(token) >= 8:
        return int(token[2:6], 16)

    if token.startswith("0x"):
        val = int(token, 16)
        return (val >> 8) & 0xFFFF

    return int(token)


def parse_fct(path: Path):
    records = []

    for line in read_lines(path):
        parts = line.split()
        if len(parts) < 8:
            continue

        try:
            src = decode_fct_endpoint(parts[0])
            dst = decode_fct_endpoint(parts[1])
            sport = int(parts[2])
            dport = int(parts[3])
            size = int(parts[4])
            start_ns = int(parts[5])
            fct_ns = int(parts[6])
            standalone = int(parts[7])
        except Exception:
            continue

        finish_ns = start_ns + fct_ns
        avg = 0.0 if fct_ns <= 0 else (size * 8.0) / fct_ns

        records.append(FctRecord(
            index=len(records),
            src=src,
            dst=dst,
            sport=sport,
            dport=dport,
            size_bytes=size,
            start_ns=start_ns,
            fct_ns=fct_ns,
            standalone_delay_ns=standalone,
            finish_ns=finish_ns,
            avg_throughput_gbps=avg,
        ))

    return records


def filter_fct_by_flows(fct_records, flows):
    remaining = {}

    for f in flows:
        key = (f.src, f.dst, f.dport, f.size_bytes, f.start_ns)
        remaining[key] = remaining.get(key, 0) + 1

    out = []

    for r in fct_records:
        key = (r.src, r.dst, r.dport, r.size_bytes, r.start_ns)

        if remaining.get(key, 0) > 0:
            rr = asdict(r)
            rr["index"] = len(out)
            out.append(rr)
            remaining[key] -= 1

    return out

def join_flow_fct_results(fct_records, flows):
    used = set()
    rows = []

    for f in flows:
        best_idx = None
        best_delta = None

        for i, r in enumerate(fct_records):
            if i in used:
                continue

            if r.src != f.src:
                continue
            if r.dst != f.dst:
                continue
            if r.dport != f.dport:
                continue
            if r.size_bytes != f.size_bytes:
                continue

            delta = abs(r.start_ns - f.start_ns)

            # flow start 间隔通常是 20us，这里只允许 1us 以内的时间误差，避免错误匹配相邻 flow。
            if delta <= 1000:
                if best_delta is None or delta < best_delta:
                    best_idx = i
                    best_delta = delta

        if best_idx is not None:
            used.add(best_idx)
            r = fct_records[best_idx]

            rows.append({
                "index": f.index,
                "src": f.src,
                "dst": f.dst,
                "pg": f.pg,
                "dport": f.dport,
                "size_bytes": f.size_bytes,
                "start_ns": f.start_ns,
                "status": "completed",
                "fct_ns": r.fct_ns,
                "finish_ns": r.finish_ns,
                "avg_throughput_gbps": r.avg_throughput_gbps,
                "standalone_delay_ns": r.standalone_delay_ns,
                "sport": r.sport,
                "fct_index": r.index,
                "fct_start_ns": r.start_ns,
                "match_delta_ns": abs(r.start_ns - f.start_ns),
            })
        else:
            rows.append({
                "index": f.index,
                "src": f.src,
                "dst": f.dst,
                "pg": f.pg,
                "dport": f.dport,
                "size_bytes": f.size_bytes,
                "start_ns": f.start_ns,
                "status": "missing",
                "fct_ns": None,
                "finish_ns": None,
                "avg_throughput_gbps": None,
                "standalone_delay_ns": None,
                "sport": None,
                "fct_index": None,
                "fct_start_ns": None,
                "match_delta_ns": None,
            })

    return rows


def parse_run_log(path: Path):
    stats = []
    port_stats = []
    drops = []
    injection_tables = []
    current_table = None
    flow_bytes = []
    rnic_retx = []
    userspace_posts = []
    userspace_summaries = []
    gate_mode_events = []

    if not path.exists():
        return {
            "ocsStats": stats,
            "ocsPortStats": port_stats,
            "drops": drops,
            "injectionTables": injection_tables,
            "flowBytes": flow_bytes,
        }

    re_ocs_stats = re.compile(
        r"\[OCS STATS\] node=(\d+).*?"
        r"forwarded_packets=(\d+).*?"
        r"forwarded_bytes=(\d+).*?"
        r"drop_no_circuit=(\d+).*?"
        r"drop_switching=(\d+).*?"
        r"drop_bad_port=(\d+).*?"
        r"drop_bad_device=(\d+)"
    )

    re_port = re.compile(
        r"\[OCS PORT STATS\] node=(\d+) outPort=(\d+) packets=(\d+) bytes=(\d+)"
    )

    re_drop = re.compile(
        r"\[OCS DROP SWITCHING\] t=(\d+) node=(\d+) inPort=(\d+) slice=(\d+) drop_switching=(\d+)"
    )

    re_tbl_begin = re.compile(
        r"\[(?:RNIC QP .*INJECTION TABLE|INJECTION WINDOW TABLE) BEGIN\] "
        r"rnic=(\d+).*?epochNs=(\d+).*?periodNs=(\d+)"
    )

    re_win = re.compile(
        r"window=(\d+) injectNs=\[(\d+),(\d+)\).*?dstRnics=\{([^}]*)\}"
    )

    # Old format:
    #   [FLOW_RX_BYTES] t=... flow_id=... bytes=...
    # New tuple format:
    #   [FLOW_RX_BYTES] t=... src=... dst=... sport=... dport=... pg=... bytes=...
    re_flow_bytes = re.compile(
        r"\[FLOW_RX_BYTES\].*?t=(\d+).*?flow_id=(\d+).*?(?:payload_bytes|bytes)=(\d+)"
    )

    re_flow_bytes_tuple = re.compile(
        r"\[FLOW_RX_BYTES\].*?t=(\d+)"
        r".*?src=(\d+)"
        r".*?dst=(\d+)"
        r".*?sport=(\d+)"
        r".*?dport=(\d+)"
        r".*?pg=(\d+)"
        r".*?(?:payload_bytes|bytes)=(\d+)"
    )

    re_rnic_retx_summary = re.compile(
        r"\[RNIC RETX SUMMARY\].*?"
        r"t=(\d+).*?"
        r"rnic=(\d+).*?"
        r"src=(\d+).*?"
        r"dst=(\d+).*?"
        r"sport=(\d+).*?"
        r"dport=(\d+).*?"
        r"pg=(\d+).*?"
        r"recover_events=(\d+).*?"
        r"retx_packets=(\d+).*?"
        r"retx_bytes=(\d+)"
    )

    re_userspace_post = re.compile(
        r"\[USERSPACE WR POST\].*?"
        r"t=(\d+).*?"
        r"src=(\d+).*?"
        r"dip=([0-9]+)\.([0-9]+).*?"
        r"sport=(\d+).*?"
        r"dport=(\d+).*?"
        r"bytes=(\d+).*?"
        r"postedLimit=(\d+).*?"
        r"outstanding=(\d+)"
        r"(?:.*?safeBudget=(\d+))?"
        r"(?:.*?windowEnd=(\d+))?"
    )

    re_userspace_post_sample_node = re.compile(
        r"\[USERSPACE WR POST(?: SAMPLE)?\].*?"
        r"t=(\d+).*?"
        r"src=(\d+).*?"
        r"dst=(\d+).*?"
        r"sport=(\d+).*?"
        r"dport=(\d+).*?"
        r"bytes=(\d+).*?"
        r"postedLimit=(\d+).*?"
        r"outstanding=(\d+)"
        r"(?:.*?safeBudget=(\d+))?"
        r"(?:.*?windowEnd=(\d+))?"
    )

    re_userspace_summary = re.compile(
        r"\[USERSPACE WR SUMMARY\].*?"
        r"t=(\d+).*?"
        r"src=(\d+).*?"
        r"dst=(\d+).*?"
        r"sport=(\d+).*?"
        r"dport=(\d+).*?"
        r"pg=(\d+).*?"
        r"posts=(\d+).*?"
        r"total_bytes=(\d+).*?"
        r"min_bytes=(\d+).*?"
        r"max_bytes=(\d+).*?"
        r"avg_bytes=(\d+).*?"
        r"first_post=(\d+).*?"
        r"last_post=(\d+).*?"
        r"safe_budget_limited=(\d+)"
    )

    re_gate_mode = re.compile(
        r"\[RDMA GATE MODE\]\s+mode=(\d+)\s+layer=([A-Za-z0-9_\-]+)"
    )

    for line in path.read_text(errors="ignore").splitlines():
        m = re_ocs_stats.search(line)
        if m:
            stats.append({
                "node": int(m.group(1)),
                "forwardedPackets": int(m.group(2)),
                "forwardedBytes": int(m.group(3)),
                "dropNoCircuit": int(m.group(4)),
                "dropSwitching": int(m.group(5)),
                "dropBadPort": int(m.group(6)),
                "dropBadDevice": int(m.group(7)),
            })
            continue

        m = re_port.search(line)
        if m:
            port_stats.append({
                "node": int(m.group(1)),
                "outPort": int(m.group(2)),
                "packets": int(m.group(3)),
                "bytes": int(m.group(4)),
            })
            continue

        m = re_drop.search(line)
        if m:
            drops.append({
                "timeNs": int(m.group(1)),
                "node": int(m.group(2)),
                "inPort": int(m.group(3)),
                "slice": int(m.group(4)),
                "dropSwitching": int(m.group(5)),
            })
            continue

        m = re_tbl_begin.search(line)
        if m:
            current_table = {
                "rnic": int(m.group(1)),
                "epochNs": int(m.group(2)),
                "periodNs": int(m.group(3)),
                "windows": [],
            }
            injection_tables.append(current_table)
            continue

        if ("INJECTION TABLE END" in line or
            "INJECTION WINDOW TABLE END" in line):
            current_table = None
            continue

        if current_table is not None:
            m = re_win.search(line)
            if m:
                dsts = [int(x.strip()) for x in m.group(4).split(",") if x.strip()]
                current_table["windows"].append({
                    "window": int(m.group(1)),
                    "startNs": int(m.group(2)),
                    "endNs": int(m.group(3)),
                    "dstRnics": dsts,
                })
            continue

        m = re_flow_bytes_tuple.search(line)
        if m:
            flow_bytes.append({
                "timeNs": int(m.group(1)),
                "src": int(m.group(2)),
                "dst": int(m.group(3)),
                "sport": int(m.group(4)),
                "dport": int(m.group(5)),
                "pg": int(m.group(6)),
                "bytes": int(m.group(7)),
            })
            continue

        m = re_flow_bytes.search(line)
        if m:
            flow_bytes.append({
                "timeNs": int(m.group(1)),
                "flowId": int(m.group(2)),
                "bytes": int(m.group(3)),
            })
            continue

        m = re_rnic_retx_summary.search(line)
        if m:
            rnic_retx.append({
                "timeNs": int(m.group(1)),
                "rnic": int(m.group(2)),
                "src": int(m.group(3)),
                "dst": int(m.group(4)),
                "sport": int(m.group(5)),
                "dport": int(m.group(6)),
                "pg": int(m.group(7)),
                "recoverEvents": int(m.group(8)),
                "retxPackets": int(m.group(9)),
                "retxBytes": int(m.group(10)),
            })
            continue

        m = re_userspace_summary.search(line)
        if m:
            userspace_summaries.append({
                "timeNs": int(m.group(1)),
                "src": int(m.group(2)),
                "dst": int(m.group(3)),
                "sport": int(m.group(4)),
                "dport": int(m.group(5)),
                "pg": int(m.group(6)),
                "postCount": int(m.group(7)),
                "totalBytes": int(m.group(8)),
                "minBytes": int(m.group(9)),
                "maxBytes": int(m.group(10)),
                "avgBytes": int(m.group(11)),
                "firstPostTimeNs": int(m.group(12)),
                "lastPostTimeNs": int(m.group(13)),
                "safeBudgetLimitedCount": int(m.group(14)),
            })
            continue

        m = re_userspace_post_sample_node.search(line)
        if m:
            userspace_posts.append({
                "timeNs": int(m.group(1)),
                "src": int(m.group(2)),
                "dst": int(m.group(3)),
                "sport": int(m.group(4)),
                "dport": int(m.group(5)),
                "bytes": int(m.group(6)),
                "postedLimit": int(m.group(7)),
                "outstanding": int(m.group(8)),
                "safeBudget": int(m.group(9)) if m.group(9) is not None else None,
                "windowEnd": int(m.group(10)) if m.group(10) is not None else None,
            })
            continue

        m = re_userspace_post.search(line)
        if m:
            userspace_posts.append({
                "timeNs": int(m.group(1)),
                "src": int(m.group(2)),
                "dst": int(m.group(4)),
                "sport": int(m.group(5)),
                "dport": int(m.group(6)),
                "bytes": int(m.group(7)),
                "postedLimit": int(m.group(8)),
                "outstanding": int(m.group(9)),
                "safeBudget": int(m.group(10)) if m.group(10) is not None else None,
                "windowEnd": int(m.group(11)) if m.group(11) is not None else None,
            })
            continue

        m = re_gate_mode.search(line)
        if m:
            gate_mode_events.append({
                "mode": int(m.group(1)),
                "layer": m.group(2),
            })
            continue

    return {
        "ocsStats": stats,
        "ocsPortStats": port_stats,
        "drops": drops,
        "injectionTables": injection_tables,
        "flowBytes": flow_bytes,
        "rnicRetx": rnic_retx,
        "rnicRetxByRnic": aggregate_rnic_retx(rnic_retx),
        "userspacePosts": userspace_posts[:USERSPACE_POST_EVENT_LIMIT],
        "userspacePostSummary": aggregate_userspace_summary_rows(userspace_summaries) if userspace_summaries else aggregate_userspace_posts(userspace_posts),
        "userspacePostByFlow": userspace_summaries if userspace_summaries else aggregate_userspace_posts_by_flow(userspace_posts),
        "userspacePostEventLimit": USERSPACE_POST_EVENT_LIMIT,
        "userspacePostTotalEvents": sum(x.get("postCount", 0) for x in userspace_summaries) if userspace_summaries else len(userspace_posts),
        "userspacePostSampleCount": len(userspace_posts),
        "gateModeEvents": gate_mode_events,
    }

def aggregate_rnic_retx(rnic_retx):
    agg = {}

    for x in rnic_retx:
        rnic = x.get("rnic")

        if rnic not in agg:
            agg[rnic] = {
                "rnic": rnic,
                "recoverEvents": 0,
                "retxPackets": 0,
                "retxBytes": 0,
                "flows": 0,
            }

        agg[rnic]["recoverEvents"] += x.get("recoverEvents", 0)
        agg[rnic]["retxPackets"] += x.get("retxPackets", 0)
        agg[rnic]["retxBytes"] += x.get("retxBytes", 0)
        agg[rnic]["flows"] += 1

    return sorted(agg.values(), key=lambda x: x["rnic"])

def aggregate_userspace_posts(posts):
    if not posts:
        return {
            "count": 0,
            "totalBytes": 0,
            "minBytes": None,
            "maxBytes": None,
            "avgBytes": None,
            "firstPostTimeNs": None,
            "lastPostTimeNs": None,
            "safeBudgetLimitedCount": 0,
        }

    sizes = [p.get("bytes", 0) for p in posts]
    safe_limited = 0

    for p in posts:
        safe_budget = p.get("safeBudget")
        size = p.get("bytes")

        if safe_budget is not None and size is not None and size >= safe_budget:
            safe_limited += 1

    return {
        "count": len(posts),
        "totalBytes": sum(sizes),
        "minBytes": min(sizes),
        "maxBytes": max(sizes),
        "avgBytes": sum(sizes) / len(sizes),
        "firstPostTimeNs": min(p.get("timeNs", 0) for p in posts),
        "lastPostTimeNs": max(p.get("timeNs", 0) for p in posts),
        "safeBudgetLimitedCount": safe_limited,
    }


def aggregate_userspace_summary_rows(rows):
    if not rows:
        return {
            "count": 0,
            "totalBytes": 0,
            "minBytes": None,
            "maxBytes": None,
            "avgBytes": None,
            "firstPostTimeNs": None,
            "lastPostTimeNs": None,
            "safeBudgetLimitedCount": 0,
        }

    total_posts = sum(r.get("postCount", 0) for r in rows)
    total_bytes = sum(r.get("totalBytes", 0) for r in rows)
    min_values = [r.get("minBytes") for r in rows if r.get("minBytes") is not None]
    max_values = [r.get("maxBytes") for r in rows if r.get("maxBytes") is not None]
    first_values = [r.get("firstPostTimeNs") for r in rows if r.get("firstPostTimeNs") is not None]
    last_values = [r.get("lastPostTimeNs") for r in rows if r.get("lastPostTimeNs") is not None]

    return {
        "count": total_posts,
        "totalBytes": total_bytes,
        "minBytes": min(min_values) if min_values else None,
        "maxBytes": max(max_values) if max_values else None,
        "avgBytes": total_bytes / total_posts if total_posts else None,
        "firstPostTimeNs": min(first_values) if first_values else None,
        "lastPostTimeNs": max(last_values) if last_values else None,
        "safeBudgetLimitedCount": sum(r.get("safeBudgetLimitedCount", 0) for r in rows),
    }


def aggregate_userspace_posts_by_flow(posts):
    agg = {}

    for p in posts:
        key = (
            p.get("src"),
            p.get("dst"),
            p.get("sport"),
            p.get("dport"),
        )

        if key not in agg:
            agg[key] = {
                "src": p.get("src"),
                "dst": p.get("dst"),
                "sport": p.get("sport"),
                "dport": p.get("dport"),
                "postCount": 0,
                "totalBytes": 0,
                "minBytes": None,
                "maxBytes": None,
                "firstPostTimeNs": None,
                "lastPostTimeNs": None,
                "safeBudgetLimitedCount": 0,
            }

        row = agg[key]
        size = p.get("bytes", 0)
        t = p.get("timeNs", 0)

        row["postCount"] += 1
        row["totalBytes"] += size
        row["minBytes"] = size if row["minBytes"] is None else min(row["minBytes"], size)
        row["maxBytes"] = size if row["maxBytes"] is None else max(row["maxBytes"], size)
        row["firstPostTimeNs"] = t if row["firstPostTimeNs"] is None else min(row["firstPostTimeNs"], t)
        row["lastPostTimeNs"] = t if row["lastPostTimeNs"] is None else max(row["lastPostTimeNs"], t)

        safe_budget = p.get("safeBudget")
        if safe_budget is not None and size >= safe_budget:
            row["safeBudgetLimitedCount"] += 1

    out = []

    for row in agg.values():
        row["avgBytes"] = row["totalBytes"] / row["postCount"] if row["postCount"] else None
        out.append(row)

    return sorted(out, key=lambda x: (
        x.get("src") if x.get("src") is not None else 1 << 30,
        x.get("dst") if x.get("dst") is not None else 1 << 30,
        x.get("sport") if x.get("sport") is not None else -1,
        x.get("dport") if x.get("dport") is not None else -1,
    ))


def _flow_tuple_key(src, dst, sport, dport, pg):
    return (int(src), int(dst), int(sport), int(dport), int(pg))


def _bucket_floor(t_ns, bucket_ns):
    return (int(t_ns) // bucket_ns) * bucket_ns


def _bucket_ceil(t_ns, bucket_ns):
    t_ns = int(t_ns)
    return ((t_ns + bucket_ns - 1) // bucket_ns) * bucket_ns


def build_throughput_from_flow_bytes(flow_bytes, flows, flow_results, bucket_ns):
    """
    Build per-flow throughput timelines from [FLOW_RX_BYTES] records.

    The dashboard intentionally fills missing buckets with zero so that OCS-gated
    flows are shown as on/off intervals instead of misleading diagonal lines
    between sparse non-zero samples.
    """
    if not flow_bytes:
        return []

    grouped = {}
    meta = {}

    for ev in flow_bytes:
        bucket = _bucket_floor(ev["timeNs"], bucket_ns)

        if "flowId" in ev:
            key = ("flowId", int(ev["flowId"]))
            fid = int(ev["flowId"])
            f = flows[fid] if 0 <= fid < len(flows) else None
            if key not in meta:
                meta[key] = {
                    "flowId": fid,
                    "label": f"flow{fid}" if f is None else f"{f.src}→{f.dst}",
                    "src": f.src if f else None,
                    "dst": f.dst if f else None,
                    "sport": None,
                    "dport": f.dport if f else None,
                    "pg": f.pg if f else None,
                    "startNs": f.start_ns if f else bucket,
                    "finishNs": None,
                    "fctAvgThroughputGbps": None,
                    "sizeBytes": f.size_bytes if f else None,
                }
        else:
            key = ("tuple", _flow_tuple_key(ev["src"], ev["dst"], ev["sport"], ev["dport"], ev["pg"]))
            if key not in meta:
                meta[key] = {
                    "flowId": None,
                    "label": f"{ev['src']}→{ev['dst']}",
                    "src": ev["src"],
                    "dst": ev["dst"],
                    "sport": ev["sport"],
                    "dport": ev["dport"],
                    "pg": ev["pg"],
                    "startNs": bucket,
                    "finishNs": None,
                    "fctAvgThroughputGbps": None,
                    "sizeBytes": None,
                }

        grouped.setdefault(key, {})
        grouped[key][bucket] = grouped[key].get(bucket, 0) + ev["bytes"]

    completed = [r for r in flow_results if r.get("status") == "completed"]

    # Attach FCT metadata when possible. This makes legend averages represent
    # flow-size/FCT rather than the mean of active non-zero buckets.
    for key, info in meta.items():
        matched = None

        for r in completed:
            if info.get("src") is not None and r.get("src") != info.get("src"):
                continue
            if info.get("dst") is not None and r.get("dst") != info.get("dst"):
                continue
            if info.get("dport") is not None and r.get("dport") != info.get("dport"):
                continue
            if info.get("pg") is not None and r.get("pg") != info.get("pg"):
                continue
            if info.get("sport") is not None and r.get("sport") is not None and r.get("sport") != info.get("sport"):
                continue

            matched = r
            break

        if matched:
            info["startNs"] = matched.get("start_ns") if matched.get("start_ns") is not None else info.get("startNs")
            info["finishNs"] = matched.get("finish_ns")
            info["fctAvgThroughputGbps"] = matched.get("avg_throughput_gbps")
            info["sizeBytes"] = matched.get("size_bytes")

    series = []

    def sort_key(item):
        key, info = item
        return (
            info.get("src") if info.get("src") is not None else 1 << 30,
            info.get("dst") if info.get("dst") is not None else 1 << 30,
            info.get("sport") if info.get("sport") is not None else -1,
            info.get("dport") if info.get("dport") is not None else -1,
            str(key),
        )

    for key, info in sorted(meta.items(), key=sort_key):
        buckets = grouped.get(key, {})
        if not buckets:
            continue

        first_event_bucket = min(buckets)
        last_event_bucket = max(buckets)

        start_ns = info.get("startNs")
        if start_ns is None:
            start_ns = first_event_bucket

        finish_ns = info.get("finishNs")
        if finish_ns is None:
            # Include the last non-empty bucket interval when FCT is unavailable.
            finish_ns = last_event_bucket + bucket_ns

        start_bucket = min(_bucket_floor(start_ns, bucket_ns), first_event_bucket)
        end_bucket = max(_bucket_ceil(finish_ns, bucket_ns), last_event_bucket + bucket_ns)

        points = []
        active_values = []
        total_bytes = 0

        t = start_bucket
        while t < end_bucket:
            b = buckets.get(t, 0)
            total_bytes += b
            gbps = b * 8.0 / bucket_ns
            if b > 0:
                active_values.append(gbps)
            points.append({
                "timeNs": t,
                "throughputGbps": gbps,
                "bytes": b,
            })
            t += bucket_ns

        active_avg = sum(active_values) / len(active_values) if active_values else 0.0

        fct_avg = info.get("fctAvgThroughputGbps")
        if fct_avg is None:
            duration = max(1, end_bucket - start_bucket)
            fct_avg = total_bytes * 8.0 / duration

        label = info.get("label") or str(key)

        series.append({
            "flowId": info.get("flowId"),
            "src": info.get("src"),
            "dst": info.get("dst"),
            "sport": info.get("sport"),
            "dport": info.get("dport"),
            "pg": info.get("pg"),
            "label": label,
            "avgThroughputGbps": fct_avg,
            "fctAvgThroughputGbps": fct_avg,
            "activeAvgThroughputGbps": active_avg,
            "totalRxBytes": total_bytes,
            "bucketNs": bucket_ns,
            "points": points,
        })

    return series


def find_file(exp_dir: Path, names):
    for sub in ["input", "output", "."]:
        for name in names:
            p = exp_dir / sub / name
            if p.exists():
                return p
    return exp_dir / names[0]


def build_experiment(exp_dir: Path, bucket_ns: int):
    topology_path = find_file(exp_dir, ["01-ocs_test_topology.txt", "02-topology.txt", "topology.txt"])
    schedule_path = find_file(exp_dir, ["05-ocs_test_schedule.txt", "05-ocs_schedule.txt", "schedule.txt"])
    map_path = find_file(exp_dir, ["04-ocs_map.txt", "ocs_map.txt", "map.txt"])
    flow_path = find_file(exp_dir, ["03-flow.txt", "flow.txt"])
    config_path = find_file(exp_dir, ["config_ocs.txt", "config.txt"])
    fct_path = find_file(exp_dir, ["ocs_fct.txt", "fct.txt"])
    run_log_path = find_file(exp_dir, ["run.log", "latest_run.log"])

    topology = parse_topology(topology_path)
    config = parse_config(config_path)
    flows = parse_flows(flow_path)
    all_fct = parse_fct(fct_path)
    flow_results = join_flow_fct_results(all_fct, flows)
    fct = [r for r in flow_results if r.get("status") == "completed"]
    log = parse_run_log(run_log_path)
    throughput = build_throughput_from_flow_bytes(log.get("flowBytes", []), flows, flow_results, bucket_ns)
    
    schedule = parse_schedule(schedule_path)
    map_entries = parse_ocs_map(map_path)

    # OCS_SCHEDULE_ENABLE 0 -> fixed map mode
    # OCS_SCHEDULE_ENABLE 1 -> schedule mode
    # If config is missing but map exists and schedule config does not exist, fall back to map.
    if config.get("ocsMode") == "map" or (map_entries and not schedule.get("configs")):
        schedule = {
            "mode": "map",
            "configs": [],
            "entries": map_entries,
        }
    else:
        schedule["mode"] = "schedule"

    created = datetime.fromtimestamp(exp_dir.stat().st_mtime).isoformat(timespec="seconds")

    rnic_count = len(topology.get("rnics", []))

    rnic_retx_by_rnic = log.get("rnicRetxByRnic", [])

    total_retx_packets = sum(x.get("retxPackets", 0) for x in rnic_retx_by_rnic)
    total_retx_bytes = sum(x.get("retxBytes", 0) for x in rnic_retx_by_rnic)
    total_recover_events = sum(x.get("recoverEvents", 0) for x in rnic_retx_by_rnic)

    userspace_post_summary = log.get("userspacePostSummary", {})

    observed_gate_mode = None
    if log.get("gateModeEvents"):
        observed_gate_mode = log["gateModeEvents"][-1]

    summary = {
        "nodeCount": rnic_count,
        "totalNodeCount": topology.get("totalNodes", 0),
        "ocsCount": topology.get("ocsCount", 0),
        "epsCount": topology.get("switchCount", 0),
        "flowCount": len(flows),
        "ocsMode": config.get("ocsMode", "-"),
        "ccMode": config.get("ccMode"),
        "ccName": config.get("ccName", "-"),
        "totalDropSwitching": sum(x.get("dropSwitching", 0) for x in log.get("ocsStats", [])),
        "fctCount": len(fct),
        "maxFctNs": max([x.get("fct_ns", 0) for x in fct], default=0),
        "rnicGateMode": config.get("rnicGateMode", "-"),
        "injectionMode": config.get("injectionMode"),
        "injectionModeName": config.get("injectionModeName", "-"),
        "injectionLayer": config.get("injectionLayer", "-"),
        "observedInjectionMode": observed_gate_mode.get("mode") if observed_gate_mode else None,
        "observedInjectionLayer": observed_gate_mode.get("layer") if observed_gate_mode else None,
        "totalRecoverEvents": total_recover_events,
        "totalRetxPackets": total_retx_packets,
        "totalRetxBytes": total_retx_bytes,
        "userspacePostCount": userspace_post_summary.get("count", 0),
        "userspacePostBytes": userspace_post_summary.get("totalBytes", 0),
        "userspaceAvgPostBytes": userspace_post_summary.get("avgBytes"),
        "userspaceMinPostBytes": userspace_post_summary.get("minBytes"),
        "userspaceMaxPostBytes": userspace_post_summary.get("maxBytes"),
        "userspaceFirstPostTimeNs": userspace_post_summary.get("firstPostTimeNs"),
        "userspaceLastPostTimeNs": userspace_post_summary.get("lastPostTimeNs"),
        "userspaceSafeBudgetLimitedCount": userspace_post_summary.get("safeBudgetLimitedCount", 0),
    }

    if schedule.get("mode") == "map":
        summary["ocsMode"] = "map"

    return {
        "id": exp_dir.name,
        "title": exp_dir.name,
        "createdAt": created,
        "directory": str(exp_dir),
        "topology": topology,
        "schedule": schedule,
        "config": config,
        "flows": [asdict(f) for f in flows],
        "flowResults": flow_results,
        "fct": fct,
        "throughput": throughput,
        "log": log,
        "summary": summary,
    }


def make_handler(sim_dir: Path, experiments_dir: Path, bucket_ns: int):
    dashboard_dir = sim_dir / "dashboard"

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            print("[HTTP]", fmt % args)

        def send_json(self, obj):
            data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            parsed = urlparse(self.path)

            if parsed.path == "/api/experiments":
                experiments = []

                dirs = []
                if experiments_dir.exists():
                    dirs = [p for p in experiments_dir.iterdir() if p.is_dir()]
                    dirs.sort(key=lambda p: p.stat().st_mtime)

                for exp_dir in dirs:
                    try:
                        experiments.append(build_experiment(exp_dir, bucket_ns))
                    except Exception as exc:
                        experiments.append({
                            "id": exp_dir.name,
                            "title": exp_dir.name,
                            "error": str(exc),
                            "summary": {},
                        })

                self.send_json({"experiments": experiments})
                return

            rel = parsed.path.lstrip("/") or "index.html"

            if rel.startswith("api/") or ".." in Path(rel).parts:
                self.send_error(404)
                return

            file_path = dashboard_dir / rel

            if not file_path.exists() or not file_path.is_file():
                self.send_error(404)
                return

            data = file_path.read_bytes()
            ctype = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"

            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    return Handler


def main():
    ap = argparse.ArgumentParser(
        description="Serve OCS/RDMA dashboard by dynamically scanning experiments/."
    )
    ap.add_argument("--sim-dir", default=str(SIM_DIR_DEFAULT))
    ap.add_argument("--experiments-dir", default="experiments")
    ap.add_argument("--bucket-ns", type=int, default=100_000)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()

    sim_dir = Path(args.sim_dir).resolve()

    exp_dir = Path(args.experiments_dir)
    if not exp_dir.is_absolute():
        exp_dir = sim_dir / exp_dir

    handler = make_handler(sim_dir, exp_dir, args.bucket_ns)

    class DashboardHTTPServer(ThreadingHTTPServer):
        allow_reuse_address = True
        daemon_threads = True

    httpd = DashboardHTTPServer((args.host, args.port), handler)

    print(f"[INFO] dashboard: http://{args.host}:{args.port}")
    print(f"[INFO] simulation dir: {sim_dir}")
    print(f"[INFO] experiments dir: {exp_dir}")
    print("[INFO] press Ctrl+C to stop the dashboard server")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[INFO] received Ctrl+C; stopping dashboard server...")
    finally:
        httpd.server_close()
        print("[INFO] dashboard server stopped")

    return 0


if __name__ == "__main__":
    main()
