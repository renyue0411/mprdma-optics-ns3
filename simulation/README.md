# MP-RDMA NS-3 simulator with Reconfigurable Optical Network Support

This is an MP-RDMA NS-3 simulator based on the [HPCC](https://hpcc-group.github.io/) implementation for simulating the performance of MP-RDMA (Multi-Path RDMA).

This repository extends the original MP-RDMA simulator with support for **reconfigurable optical circuit switching (OCS)** and **OCS/EPS hybrid data-center topologies**. The extended simulator can model dynamic optical circuits, OCS switching intervals, EPS fallback paths, and RNIC-side injection control based on OCS time windows.

## Build

```bash
./waf configure
```

Please note that if the gcc version is greater than 5, compilation may fail due to some ns-3 code style issues. If this is what you encounter, please use:

```bash
CC='gcc-5' CXX='g++-5' ./waf configure
```

## Experiment config

### Original MP-RDMA configuration

Please see:

```text
mix/config.txt
```

for the original MP-RDMA example.

```text
mix/config_doc.txt
```

explains the original example configuration. Texts in `{...}` are explanations.

```text
mix/fat.txt
```

is the topology used in the HPCC paper evaluation, and also in the PINT paper's HPCC-PINT evaluation.

### OCS/RDMA configuration

For OCS-enabled experiments, please use:

```text
mix/config_ocs.txt
```

A typical OCS/RDMA experiment configuration contains the following important fields:

```text
TOPOLOGY_FILE          mix/01-ocs_test_topology.txt
TOPOLOGY_FORMAT_CONFIG compact_ocs_ports
FLOW_FILE              mix/03-flow.txt
FCT_OUTPUT_FILE        mix/ocs_fct.txt
TRACE_OUTPUT_FILE      mix/ocs.tr
PFC_OUTPUT_FILE        mix/pfc.txt
QLEN_MON_FILE          mix/qlen.txt

OCS_SCHEDULE_ENABLE    1
OCS_MAP_FILE           mix/04-ocs_map.txt
OCS_SCHEDULE_FILE      mix/05-ocs_test_schedule.txt

CC_MODE                1
```

The congestion control mode is selected by `CC_MODE`:

```text
1  -> DCQCN
3  -> HPCC
7  -> TIMELY
8  -> DCTCP
10 -> HPCC-PINT
```

`OCS_SCHEDULE_ENABLE` controls how OCS forwarding is configured:

```text
0 -> fixed OCS map mode
1 -> time-sliced OCS schedule mode
```

### OCS topology format

The OCS topology file uses the following compact format:

```text
total_node_num switch_node_num ocs_node_num link_num
switch_node_ids...
ocs_node_ids...
src dst [src_ocs_port_if_src_is_ocs] [dst_ocs_port_if_dst_is_ocs] rate delay error
...
```

Example:

```text
18 3 3 17
0 1 2
3 4 5
6 3 0 50Gbps 0.001ms 0
7 3 1 50Gbps 0.001ms 0
8 3 2 50Gbps 0.001ms 0
9 0 50Gbps 0.001ms 0
10 0 50Gbps 0.001ms 0
11 0 50Gbps 0.001ms 0
12 1 50Gbps 0.001ms 0
13 1 50Gbps 0.001ms 0
14 1 50Gbps 0.001ms 0
15 2 50Gbps 0.001ms 0
16 2 50Gbps 0.001ms 0
17 2 50Gbps 0.001ms 0
0 4 0 50Gbps 0.001ms 0
1 4 1 50Gbps 0.001ms 0
2 4 2 50Gbps 0.001ms 0
3 5 3 0 50Gbps 0.001ms 0
4 5 3 1 50Gbps 0.001ms 0
```

In the first line:

```text
total node #, EPS switch node #, OCS node #, link #
```

The second line lists EPS switch node IDs.

The third line lists OCS node IDs.

For each link line:

- If neither endpoint is an OCS node:

```text
src dst rate delay error
```

- If only the destination is an OCS node:

```text
src dst dst_ocs_port rate delay error
```

- If only the source is an OCS node:

```text
src dst src_ocs_port rate delay error
```

- If both endpoints are OCS nodes:

```text
src dst src_ocs_port dst_ocs_port rate delay error
```

### OCS schedule format

When `OCS_SCHEDULE_ENABLE` is set to `1`, the simulator reads the OCS schedule file:

```text
mix/05-ocs_test_schedule.txt
```

The schedule file uses the following format:

```text
CONFIG ocs_id epoch_start_us slice_duration_us switching_time_us num_slices
ocs_id slice_id port_a port_b
ocs_id slice_id port_a port_b
...
```

Example:

```text
CONFIG 3 0 10000 10 3
CONFIG 4 0 10000 10 3
CONFIG 5 0 30000 0 1

3 0 0 1
3 0 2 3
3 1 0 2
3 1 1 3
3 2 0 3
3 2 1 2

4 0 0 1
4 0 2 3
4 1 0 2
4 1 1 3
4 2 0 3
4 2 1 2

5 0 0 1
```

Each `CONFIG` line defines one OCS schedule cycle:

```text
ocs_id
epoch_start_us
slice_duration_us
switching_time_us
num_slices
```

Each schedule entry defines an active OCS port pair in a specific slice:

```text
ocs_id slice_id port_a port_b
```

During the switching interval, the OCS does not forward packets for the affected circuit.

### OCS fixed map format

When `OCS_SCHEDULE_ENABLE` is set to `0`, the simulator reads the fixed OCS map file:

```text
mix/04-ocs_map.txt
```

The fixed map format is:

```text
ocs_id port_a port_b
```

Example:

```text
4 0 1
4 2 3
5 0 1
5 2 3
```

This means the listed OCS port pairs are statically connected throughout the simulation.

### Flow file format

The flow file is specified by:

```text
FLOW_FILE mix/03-flow.txt
```

Format:

```text
flow_count
src dst pg dport size_bytes start_time_s
src dst pg dport size_bytes start_time_s
...
```

Example:

```text
4
6 9 3 100 200000 0.029880
6 9 3 100 200000 0.029900
6 9 3 100 200000 0.029920
6 9 3 100 200000 0.029940
```

Only the first `flow_count` valid flow entries are used.

## Run

### Original MP-RDMA simulator

The direct command to run the original MP-RDMA simulator is:

```bash
./waf --run 'scratch/mp-rdma-simulator mix/config.txt'
```

### OCS/RDMA simulator

The direct command to run the OCS/RDMA simulator is:

```bash
./waf --run "scratch/ocs-rdma-simulator mix/config_ocs.txt"
```

A dashboard-compatible experiment can be run and archived with:

```bash
python3 scripts/run_dashboard_experiment.py --name exp_1
```

## Dashboard
![OCS/RDMA dashboard overview](/dashboard/assets/dashboard-overview.png)

This repository includes a lightweight web dashboard for visualizing OCS/RDMA experiments.

```bash
python3 dashboard/run_serve.py --host 0.0.0.0 --port 8000
```

Then open:

```text
http://<server-ip>:8000
```

The dashboard dynamically scans:

```text
simulation/experiments/
```

and visualizes archived experiments.

The dashboard currently provides:

- experiment index
- topology by OCS time window
- OCS schedule / fixed map visualization
- flow and FCT result table
- per-flow throughput timeline support
- OCS forwarding/drop statistics
- RNIC injection window table
- CC mode / OCS mode / host count / EPS count / OCS count summary

The dashboard does not require a manually maintained JSON index. Experiment metadata is generated dynamically by `dashboard/run_serve.py`.

## Debug

1. The direct command to debug the original MP-RDMA simulator is:

```bash
./waf --run scratch/mp-rdma-simulator --command-template="gdb --args %s mix/config.txt"
```

2. The direct command to debug the OCS/RDMA simulator is:

```bash
./waf --run scratch/ocs-rdma-simulator --command-template="gdb --args %s mix/config_ocs.txt"
```

3. At the GDB prompt, enter the `run` command to start the program.

4. Analyzing errors:

   - When the program crashes, GDB stops and you can use a command such as `bt` to view the call stack.
   - The backtrace shows the order in which functions were called when the crash occurred.
   - Viewing the specific line of code and call stack can help determine the cause of the crash.

## Files added/edited based on NS3

Original MP-RDMA files added/edited based on NS3:

- `internet/model/rocev2-data-header.cc/h`: the header of RDMA data packet
- `internet/model/rocev2-ack-header.cc/h`: the header of RDMA ACK packet
- `point-to-point/helper/mp-qbb-helper.cc/h`: the helper class for MP-QBB
- `point-to-point/model/mp-qbb-channel.cc/h`: the channel of MP-QBB
- `point-to-point/model/mp-qbb-net-device.cc/h`: the net-device of MP-RDMA
- `point-to-point/model/mp-qbb-remote-channel.cc/h`: the remote channel of MP-QBB
- `point-to-point/model/mp-rdma-driver.cc/h`: layer of assigning QP and managing multiple NICs
- `point-to-point/model/mp-rdma-hw.cc/h`: the core logic of MP-RDMA
- `point-to-point/model/mp-rdma-queue-pair.cc/h`: the queue pair for MP-RDMA
- `applications/helper/mp-rdma-client-helper.cc/h`: the helper class for MP-RDMA client
- `applications/model/mp-rdma-client.cc/h`: the client of MP-RDMA
- `network/utils/custom-header.cc/h`: a customized header class for speeding up header parsing
- `point-to-point/model/mp-switch-node.cc/h`: the node class for switch

Additional files added/edited for OCS/RDMA support:

- `scratch/ocs-rdma-simulator.cc`: the main OCS/RDMA experiment runner. It reads OCS topology, OCS schedule/map, flow configuration, and writes FCT/trace/statistics outputs.
- `point-to-point/model/ocs-node.cc/h`: OCS node abstraction and optical circuit forwarding logic.
- `point-to-point/model/ocs-controller.cc/h`: OCS control logic for installing fixed maps or time-sliced schedules.
- `point-to-point/model/rdma-ocs-controller.cc/h`: controller for deriving RNIC-side injection windows from OCS schedules and EPS/OCS topology.
- `point-to-point/model/rdma-hw.cc/h`: extended RDMA hardware logic with RNIC-side injection gating and OCS-aware transmission control.
- `point-to-point/model/rdma-queue-pair.cc/h`: queue pair logic extended for OCS/RNIC gating interaction.
- `point-to-point/model/rdma-transport-control.cc/h`: transport control logic used by RDMA/OCS experiments.
- `point-to-point/model/rdma-driver.cc/h`: RDMA driver logic used for QP creation and experiment flow setup.
- `point-to-point/model/qbb-net-device.cc/h`: QBB net device logic extended for OCS/EPS hybrid forwarding behavior.

Dashboard and experiment management files:

- `dashboard/index.html`: dashboard page layout.
- `dashboard/app.js`: dashboard visualization logic.
- `dashboard/style.css`: dashboard styling.
- `dashboard/run_serve.py`: lightweight HTTP server that scans archived experiments and serves dashboard data.
- `dashboard/assets/`: dashboard logo and static assets.
- `scripts/run_dashboard_experiment.py`: wrapper script for running and archiving dashboard-compatible OCS/RDMA experiments.
