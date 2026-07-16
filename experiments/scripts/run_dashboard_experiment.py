#!/usr/bin/env python3
import argparse
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
SIM_DIR_DEFAULT = REPO_ROOT / "simulation"
EXPERIMENTS_DIR_DEFAULT = REPO_ROOT / "experiments" / "runs"


RUNLOG_PATH_KEYS = {
    "TOPOLOGY_FILE": ("input", "01-ocs_test_topology.txt"),
    "OCS_SCHEDULE_FILE": ("input", "05-ocs_test_schedule.txt"),
    "OCS_MAP_FILE": ("input", "04-ocs_map.txt"),
    "FLOW_FILE": ("input", "03-flow.txt"),

    "FCT_OUTPUT_FILE": ("output", "ocs_fct.txt"),
    "TRACE_OUTPUT_FILE": ("output", "ocs.tr"),
    "PFC_OUTPUT_FILE": ("output", "pfc.txt"),
    "QLEN_MON_FILE": ("output", "qlen.txt"),
}


def make_exp_id(name: str):
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in name.strip())
    safe = safe.strip("_") or "ocs_experiment"
    return f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{safe}"


def copy_if_exists(src: Path, dst: Path, required: bool = False):
    if src.exists():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        # print(f"[COPY] {src} -> {dst}")
        return True

    if required:
        print(f"[ERROR] missing required file: {src}", file=sys.stderr)
    else:
        print(f"[WARN] missing file: {src}", file=sys.stderr)

    return False


def run_streaming(cmd: str, cwd: Path, log_path: Path):
    print(f"[INFO] running command in {cwd}: {cmd}")

    log_path.parent.mkdir(parents=True, exist_ok=True)

    with log_path.open("w", encoding="utf-8", errors="ignore") as log:
        proc = subprocess.Popen(
            cmd,
            cwd=str(cwd),
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

        assert proc.stdout is not None

        for line in proc.stdout:
            print(line, end="")
            log.write(line)

        rc = proc.wait()

        print(f"[INFO] command exit code: {rc}")
        log.write(f"\n[dashboard wrapper] command exit code: {rc}\n")

    return rc


def parse_paths_from_run_log(log_path: Path):
    """
    Parse real input/output file paths from simulator stdout.

    Example lines:
      TOPOLOGY_FILE          mix/01-ocs_topology.txt
      FLOW_FILE              mix/03-flow.txt
      FCT_OUTPUT_FILE        mix/ocs_fct.txt
      OCS_SCHEDULE_FILE      mix/05-ocs_schedule.txt
    """
    paths = {}

    if not log_path.exists():
        return paths

    key_re = re.compile(r"^([A-Z0-9_]+)\s+(.+?)\s*$")

    for raw in log_path.read_text(errors="ignore").splitlines():
        line = raw.strip()

        if not line:
            continue

        m = key_re.match(line)
        if not m:
            continue

        key = m.group(1)
        value = m.group(2).strip()

        if key in RUNLOG_PATH_KEYS:
            # 只取第一个 token，避免某些配置项后面带额外内容。
            paths[key] = value.split()[0]

    return paths


def archive_files_from_run_log(sim_dir: Path, exp_dir: Path, config_rel: str):
    input_dir = exp_dir / "input"
    output_dir = exp_dir / "output"
    run_log_path = output_dir / "run.log"

    paths = parse_paths_from_run_log(run_log_path)

    print("[INFO] paths parsed from run.log:")
    for key in RUNLOG_PATH_KEYS:
        if key in paths:
            print(f"       {key} = {paths[key]}")

    # config 本身不一定在 run.log 里，所以从 wrapper 参数复制。
    copy_if_exists(sim_dir / config_rel, input_dir / "config_ocs.txt", required=True)

    # 根据 run.log 里真实使用的路径复制文件。
    for key, rel_path in paths.items():
        target_dir_name, standard_name = RUNLOG_PATH_KEYS[key]
        target_dir = input_dir if target_dir_name == "input" else output_dir
        copy_if_exists(sim_dir / rel_path, target_dir / standard_name)

    # 最低限度检查：dashboard 必须要有 topo / flow / config。
    required_inputs = [
        input_dir / "config_ocs.txt",
        input_dir / "01-ocs_test_topology.txt",
        input_dir / "03-flow.txt",
    ]

    missing = [p for p in required_inputs if not p.exists()]
    if missing:
        print("[WARN] some required dashboard input files are missing:", file=sys.stderr)
        for p in missing:
            print(f"       {p}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(
        description="Run one OCS/RDMA experiment and archive its actual inputs/outputs under experiments/."
    )

    ap.add_argument("--name", default="exp")
    ap.add_argument("--sim-dir", default=str(SIM_DIR_DEFAULT))
    ap.add_argument("--config", default="mix/config_ocs.txt")
    ap.add_argument("--run-cmd", default=None)
    ap.add_argument("--configure", action="store_true")
    ap.add_argument("--no-run", action="store_true")
    ap.add_argument("--experiments-dir", default=str(EXPERIMENTS_DIR_DEFAULT))

    args = ap.parse_args()

    sim_dir = Path(args.sim_dir).resolve()

    if not sim_dir.exists():
        print(f"[ERROR] simulation directory not found: {sim_dir}", file=sys.stderr)
        return 2

    exp_root = Path(args.experiments_dir)
    if not exp_root.is_absolute():
        exp_root = REPO_ROOT / exp_root
    exp_root = exp_root.resolve()

    exp_id = make_exp_id(args.name)
    exp_dir = exp_root / exp_id
    input_dir = exp_dir / "input"
    output_dir = exp_dir / "output"

    input_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)

    run_cmd = args.run_cmd
    if run_cmd is None:
        run_cmd = f'./waf --run "scratch/ocs-rdma-simulator {args.config}"'

    if not args.no_run:
        if args.configure:
            rc = run_streaming("./waf configure", sim_dir, output_dir / "configure.log")
            if rc != 0:
                print(f"[ERROR] configure failed; archived at {exp_dir}", file=sys.stderr)
                return rc

        rc = run_streaming(run_cmd, sim_dir, output_dir / "run.log")

    else:
        rc = 0

        latest_log = sim_dir / "mix/latest_run.log"
        if latest_log.exists():
            copy_if_exists(latest_log, output_dir / "run.log")
        else:
            (output_dir / "run.log").write_text(
                "[dashboard wrapper] no-run mode; no run.log was captured.\n",
                encoding="utf-8",
            )

    archive_files_from_run_log(sim_dir, exp_dir, args.config)

    print(f"[INFO] experiment archived: {exp_dir}")
    print("[INFO] start dashboard server with:")
    print("       python3 dashboard/run_serve.py --host 0.0.0.0 --port 8000")

    return rc


if __name__ == "__main__":
    raise SystemExit(main())