/* -*- Mode:C++; c-file-style:"gnu"; indent-tabs-mode:nil; -*- */
/*
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 2 as
 * published by the Free Software Foundation;
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, write to the Free Software
 * Foundation, Inc., 59 Temple Place, Suite 330, Boston, MA  02111-1307  USA
 */

#undef PGO_TRAINING
#define PATH_TO_PGO_CONFIG "path_to_pgo_config"

#include <iostream>
#include <fstream>
#include <sstream>
#include <unordered_map>
#include <map>
#include <vector>
#include <string>
#include <time.h>
#include "ns3/core-module.h"
#include "ns3/qbb-helper.h"
#include "ns3/point-to-point-helper.h"
#include "ns3/application-container.h"
#include "ocs-rdma-simulation.h"
#include "ns3/internet-module.h"
#include "ns3/global-route-manager.h"
#include "ns3/ipv4-static-routing-helper.h"
#include "ns3/packet.h"
#include "ns3/error-model.h"
#include <ns3/rdma.h>
#include <ns3/rdma-hw.h>
#include <ns3/rdma-client.h>
#include <ns3/rdma-client-helper.h>
#include <ns3/rdma-driver.h>
#include <ns3/switch-node.h>
#include <ns3/sim-setting.h>
#include <ns3/rdma-multipath-transport.h>

// OCS node
#include "ns3/ocs-node.h"
#include "ns3/rdma-ocs-controller.h"
#include <set>
#include <limits>
#include <cstdlib>
#include <algorithm>

using namespace ns3;
using namespace std;

NS_LOG_COMPONENT_DEFINE("OcsRdmaSimulation");

namespace ns3 {
namespace {

uint32_t cc_mode = 1;
bool enable_qcn = true, use_dynamic_pfc_threshold = true;
uint32_t packet_payload_size = 1000, l2_chunk_size = 0, l2_ack_interval = 0;
double pause_time = 5, simulator_stop_time = 3.01;
std::string data_rate, link_delay, topology_file, flow_file, trace_file, trace_output_file;
std::string fct_output_file = "fct.txt";
std::string pfc_output_file = "pfc.txt";

// OCS node
std::set<uint32_t> ocs_node_ids;
std::string ocs_map_file = "";

// Phase-2 local time-sliced OCS schedule.
// When ocs_schedule_enable == 0, the simulator uses OCS_MAP_FILE
// and installs a static bufferless OCS map.
// When ocs_schedule_enable == 1, the simulator uses OCS_SCHEDULE_FILE
// and installs a periodic time-sliced OCS schedule with switching blackout.
uint32_t ocs_schedule_enable = 0;
std::string ocs_schedule_file = "";
uint32_t rnic_gate_enable = 1;

uint64_t userspace_wr_chunk_bytes = 16 * 1024;
uint64_t userspace_max_outstanding_bytes = 64 * 1024;

// Topology link format.
//   auto: 3-field header uses legacy links; 4-field header auto-detects
//         full with_ocs_ports vs compact_ocs_ports per link line.
//   legacy: src dst rate delay error
//   with_ocs_ports: src dst src_port dst_port rate delay error
//   compact_ocs_ports: src dst [only OCS endpoint logical ports] rate delay error
std::string topology_format = "auto";

Ptr<RdmaOcsController> rdmaOcsController;

double alpha_resume_interval = 55, rp_timer, ewma_gain = 1 / 16;
double rate_decrease_interval = 4;
uint32_t fast_recovery_times = 5;
std::string rate_ai, rate_hai, min_rate = "100Mb/s";
std::string dctcp_rate_ai = "1000Mb/s";

bool clamp_target_rate = false, l2_back_to_zero = false;
double error_rate_per_link = 0.0;
uint32_t has_win = 1;
uint32_t global_t = 1;
uint32_t mi_thresh = 5;
bool var_win = false, fast_react = true;
bool multi_rate = true;
bool sample_feedback = false;
double pint_log_base = 1.05;
double pint_prob = 1.0;
double u_target = 0.95;
uint32_t int_multi = 1;
bool rate_bound = true;

uint32_t ack_high_prio = 0;
uint64_t link_down_time = 0;
uint32_t link_down_A = 0, link_down_B = 0;

uint32_t enable_trace = 1;

uint32_t buffer_size = 16;

uint32_t qlen_dump_interval = 100000000, qlen_mon_interval = 100;
uint64_t qlen_mon_start = 2000000000, qlen_mon_end = 2100000000;
string qlen_mon_file;

unordered_map<uint64_t, uint32_t> rate2kmax, rate2kmin;
unordered_map<uint64_t, double> rate2pmax;

/************************************************
 * Runtime varibles
 ***********************************************/
std::ifstream topof, flowf, tracef;

NodeContainer n;
RdmaMultipathTransport rdmaMultipathTransport;

uint64_t nic_rate;

uint64_t maxRtt, maxBdp;

struct Interface
{
	uint32_t idx;
	bool up;
	uint64_t delay;
	uint64_t bw;

	Interface() : idx(0), up(false) {}
};
map<Ptr<Node>, map<Ptr<Node>, Interface>> nbr2if;
// Mapping destination to next hop for each node: <node, <dest, <nexthop0, ...> > >
map<Ptr<Node>, map<Ptr<Node>, vector<Ptr<Node>>>> nextHop;
map<Ptr<Node>, map<Ptr<Node>, uint64_t>> pairDelay;
map<Ptr<Node>, map<Ptr<Node>, uint64_t>> pairTxDelay;
map<uint32_t, map<uint32_t, uint64_t>> pairBw;
map<Ptr<Node>, map<Ptr<Node>, uint64_t>> pairBdp;
map<uint32_t, map<uint32_t, uint64_t>> pairRtt;

std::vector<Ipv4Address> serverAddress;

// maintain port number for each host pair
std::unordered_map<uint32_t, unordered_map<uint32_t, uint16_t>> portNumder;

typedef std::pair<uint16_t, std::pair<uint32_t, uint32_t>> FlowCompletionKey;

struct FlowCompletionRegistration
{
  FlowCompletionRegistration()
      : tag(0)
  {
  }

  FlowCompletionRegistration(
      uint32_t flowTag,
      OcsRdmaSimulation::FlowCompletionCallback flowCompletion)
      : tag(flowTag),
        completion(flowCompletion)
  {
  }

  uint32_t tag;
  OcsRdmaSimulation::FlowCompletionCallback completion;
};

std::map<FlowCompletionKey, FlowCompletionRegistration> flowCompletionCallbacks;

uint16_t
StartResolvedFlow(uint32_t src,
                  uint32_t dst,
                  uint32_t priorityGroup,
                  uint32_t destinationPort,
                  uint64_t bytes,
                  uint32_t tag,
                  OcsRdmaSimulation::FlowCompletionCallback completion)
{
  NS_ASSERT_MSG(src < n.GetN(), "flow src carrier node id out of range");
  NS_ASSERT_MSG(dst < n.GetN(), "flow dst carrier node id out of range");
  NS_ASSERT_MSG(n.Get(src)->GetNodeType() == 0, "flow src is not host");
  NS_ASSERT_MSG(n.Get(dst)->GetNodeType() == 0, "flow dst is not host");
  NS_ASSERT_MSG(bytes > 0, "RDMA flow size must be greater than zero");
  NS_ASSERT_MSG(
      bytes <= std::numeric_limits<uint32_t>::max(),
      "current RdmaClientHelper supports at most UINT32_MAX bytes per flow");

  uint16_t port = portNumder[src][dst]++;
  if (!completion.IsNull())
  {
    FlowCompletionKey key =
        std::make_pair(port, std::make_pair(src, dst));
    flowCompletionCallbacks[key] =
        FlowCompletionRegistration(tag, completion);
  }

  RdmaClientHelper clientHelper(
      priorityGroup,
      serverAddress[src],
      serverAddress[dst],
      port,
      destinationPort,
      static_cast<uint32_t>(bytes),
      has_win
          ? (global_t == 1 ? maxBdp : pairBdp[n.Get(src)][n.Get(dst)])
          : 0,
      global_t == 1 ? maxRtt : pairRtt[src][dst]);
  ApplicationContainer appCon = clientHelper.Install(n.Get(src));
  appCon.Start(Time(0));
  return port;
}

struct FlowInput
{
    FlowInput()
        : srcToken(""),
          dstToken(""),
          src(0),
          dst(0),
          pg(0),
          maxPacketCount(0),
          port(0),
          dport(0),
          start_time(0.0),
          idx(0)
    {
    }

    std::string srcToken;
    std::string dstToken;

    uint32_t src;
    uint32_t dst;
    uint32_t pg;
    uint32_t maxPacketCount;
    uint32_t port;
    uint32_t dport;

    double start_time;
    uint32_t idx;
};

FlowInput flow_input;
uint32_t flow_num;

void ReadFlowInput()
{
	if (flow_input.idx < flow_num)
	{
		flowf >> flow_input.srcToken >> flow_input.dstToken >> flow_input.pg
		      >> flow_input.dport >> flow_input.maxPacketCount
		      >> flow_input.start_time;
		RdmaMultipathTransport::ScheduledFlow scheduled =
			rdmaMultipathTransport.ScheduleFlow(flow_input.srcToken, flow_input.dstToken);
		flow_input.src = scheduled.srcCarrierNodeId;
		flow_input.dst = scheduled.dstCarrierNodeId;
		NS_ASSERT_MSG(flow_input.src < n.GetN(), "scheduled flow src carrier node id out of range");
		NS_ASSERT_MSG(flow_input.dst < n.GetN(), "scheduled flow dst carrier node id out of range");
		NS_ASSERT_MSG(n.Get(flow_input.src)->GetNodeType() == 0, "scheduled flow src is not host");
		NS_ASSERT_MSG(n.Get(flow_input.dst)->GetNodeType() == 0, "scheduled flow dst is not host");
	}
}
void ScheduleFlowInputs()
{
	while (flow_input.idx < flow_num && Seconds(flow_input.start_time) == Simulator::Now())
	{
		StartResolvedFlow(
			flow_input.src,
			flow_input.dst,
			flow_input.pg,
			flow_input.dport,
			flow_input.maxPacketCount,
			0,
			OcsRdmaSimulation::FlowCompletionCallback());

		// get the next flow input
		flow_input.idx++;
		ReadFlowInput();
	}

	// schedule the next time to run this function
	if (flow_input.idx < flow_num)
	{
		Simulator::Schedule(Seconds(flow_input.start_time) - Simulator::Now(), ScheduleFlowInputs);
	}
	else
	{ // no more flows, close the file
		flowf.close();
	}
}

Ipv4Address node_id_to_ip(uint32_t id)
{
	return Ipv4Address(0x0b000001 + ((id / 256) * 0x00010000) + ((id % 256) * 0x00000100));
}

uint32_t ip_to_node_id(Ipv4Address ip)
{
	return (ip.Get() >> 8) & 0xffff;
}

void qp_finish(FILE *fout, Ptr<RdmaQueuePair> q)
{
	uint32_t sid = ip_to_node_id(q->sip), did = ip_to_node_id(q->dip);
	uint64_t base_rtt = pairRtt[sid][did], b = pairBw[sid][did];
	uint32_t total_bytes = q->m_size + ((q->m_size - 1) / packet_payload_size + 1) * (CustomHeader::GetStaticWholeHeaderSize() - IntHeader::GetStaticSize()); // translate to the minimum bytes required (with header but no INT)
	uint64_t standalone_fct = base_rtt + total_bytes * 8000000000lu / b;
	std::cout << "Writing into fct file......" << endl;
	// sip, dip, sport, dport, size (B), start_time, fct (ns), standalone_fct (ns)
	fprintf(fout, "%08x %08x %u %u %lu %lu %lu %lu\n", q->sip.Get(), q->dip.Get(), q->sport, q->dport, q->m_size, q->startTime.GetTimeStep(), (Simulator::Now() - q->startTime).GetTimeStep(), standalone_fct);
	fflush(fout);

	// remove rxQp from the receiver
	Ptr<Node> dstNode = n.Get(did);
	Ptr<RdmaDriver> rdma = dstNode->GetObject<RdmaDriver>();
	rdma->m_rdma->DeleteRxQp(q->sip.Get(), q->m_pg, q->sport);

	FlowCompletionKey completionKey =
		std::make_pair(
			static_cast<uint16_t>(q->sport),
			std::make_pair(sid, did));
	std::map<FlowCompletionKey, FlowCompletionRegistration>::iterator it =
		flowCompletionCallbacks.find(completionKey);
	if (it != flowCompletionCallbacks.end())
	{
		FlowCompletionRegistration registration = it->second;
		flowCompletionCallbacks.erase(it);
		registration.completion(
			sid,
			did,
			q->m_size,
			registration.tag,
			static_cast<uint16_t>(q->sport));
	}
}

void get_pfc(FILE *fout, Ptr<QbbNetDevice> dev, uint32_t type)
{
	fprintf(fout, "%lu %u %u %u %u\n", Simulator::Now().GetTimeStep(), dev->GetNode()->GetId(), dev->GetNode()->GetNodeType(), dev->GetIfIndex(), type);
}

struct QlenDistribution
{
	vector<uint32_t> cnt; // cnt[i] is the number of times that the queue len is i KB

	void add(uint32_t qlen)
	{
		uint32_t kb = qlen / 1000;
		if (cnt.size() < kb + 1)
			cnt.resize(kb + 1);
		cnt[kb]++;
	}
};
map<uint32_t, map<uint32_t, QlenDistribution>> queue_result;
void monitor_buffer(FILE *qlen_output, NodeContainer *n)
{
	for (uint32_t i = 0; i < n->GetN(); i++)
	{
		if (n->Get(i)->GetNodeType() == 1)
		{ // is switch
			Ptr<SwitchNode> sw = DynamicCast<SwitchNode>(n->Get(i));
			if (queue_result.find(i) == queue_result.end())
				queue_result[i];
			for (uint32_t j = 1; j < sw->GetNDevices(); j++)
			{
				uint32_t size = 0;
				for (uint32_t k = 0; k < SwitchMmu::qCnt; k++)
					size += sw->m_mmu->egress_bytes[j][k];
				queue_result[i][j].add(size);
			}
		}
	}
	if (Simulator::Now().GetTimeStep() % qlen_dump_interval == 0)
	{
		fprintf(qlen_output, "time: %lu\n", Simulator::Now().GetTimeStep());
		for (auto &it0 : queue_result)
			for (auto &it1 : it0.second)
			{
				fprintf(qlen_output, "%u %u", it0.first, it1.first);
				auto &dist = it1.second.cnt;
				for (uint32_t i = 0; i < dist.size(); i++)
					fprintf(qlen_output, " %u", dist[i]);
				fprintf(qlen_output, "\n");
			}
		fflush(qlen_output);
	}
	if (Simulator::Now().GetTimeStep() < qlen_mon_end)
		Simulator::Schedule(NanoSeconds(qlen_mon_interval), &monitor_buffer, qlen_output, n);
}

void CalculateRoute(Ptr<Node> host)
{
	// queue for the BFS.
	vector<Ptr<Node>> q;
	// Distance from the host to each node.
	map<Ptr<Node>, int> dis;
	map<Ptr<Node>, uint64_t> delay;
	map<Ptr<Node>, uint64_t> txDelay;
	map<Ptr<Node>, uint64_t> bw;
	// init BFS.
	q.push_back(host);
	dis[host] = 0;
	delay[host] = 0;
	txDelay[host] = 0;
	bw[host] = 0xfffffffffffffffflu;
	// BFS.
	for (int i = 0; i < (int)q.size(); i++)
	{
		Ptr<Node> now = q[i];
		int d = dis[now];
		for (auto it = nbr2if[now].begin(); it != nbr2if[now].end(); it++)
		{
			// skip down link
			if (!it->second.up)
				continue;
			Ptr<Node> next = it->first;
			// If 'next' have not been visited.
			if (dis.find(next) == dis.end())
			{
				dis[next] = d + 1;
				delay[next] = delay[now] + it->second.delay;
				txDelay[next] = txDelay[now] + packet_payload_size * 1000000000lu * 8 / it->second.bw;
				bw[next] = std::min(bw[now], it->second.bw);
				// we only enqueue switch, because we do not want packets to go through host as middle point
				if (next->GetNodeType() > 0)
					q.push_back(next);
			}
			// if 'now' is on the shortest path from 'next' to 'host'.
			if (d + 1 == dis[next])
			{
				nextHop[next][host].push_back(now);
			}
		}
	}
	for (auto it : delay)
		pairDelay[it.first][host] = it.second;
	for (auto it : txDelay)
		pairTxDelay[it.first][host] = it.second;
	for (auto it : bw)
		pairBw[it.first->GetId()][host->GetId()] = it.second;
}

void CalculateRoutes(NodeContainer &n)
{
	for (int i = 0; i < (int)n.GetN(); i++)
	{
		Ptr<Node> node = n.Get(i);
		if (node->GetNodeType() == 0)
			CalculateRoute(node);
	}
}

void SetRoutingEntries()
{
	// For each node.
	for (auto i = nextHop.begin(); i != nextHop.end(); i++)
	{
		Ptr<Node> node = i->first;
		auto &table = i->second;
		for (auto j = table.begin(); j != table.end(); j++)
		{
			// The destination node.
			Ptr<Node> dst = j->first;
			// The IP address of the dst.
			Ipv4Address dstAddr = dst->GetObject<Ipv4>()->GetAddress(1, 0).GetLocal();
			// The next hops towards the dst.
			vector<Ptr<Node>> nexts = j->second;
			for (int k = 0; k < (int)nexts.size(); k++)
			{
				Ptr<Node> next = nexts[k];
				uint32_t interface = nbr2if[node][next].idx;
				if (node->GetNodeType() == 0)
				{
					node->GetObject<RdmaDriver>()->m_rdma->AddTableEntry(dstAddr, interface);
				}
				else if (node->GetNodeType() == 1)
				{
					DynamicCast<SwitchNode>(node)->AddTableEntry(dstAddr, interface);
				}
				else if (node->GetNodeType() == 2)
				{
					// OCS does not use an IP forwarding table.
					// It forwards packets according to its port-to-port circuit map.
				}
			}
		}
	}
}

// take down the link between a and b, and redo the routing
void TakeDownLink(NodeContainer n, Ptr<Node> a, Ptr<Node> b)
{
	if (!nbr2if[a][b].up)
		return;
	// take down link between a and b
	nbr2if[a][b].up = nbr2if[b][a].up = false;
	nextHop.clear();
	CalculateRoutes(n);
	// clear routing tables
	for (uint32_t i = 0; i < n.GetN(); i++)
	{
		if (n.Get(i)->GetNodeType() == 1)
			DynamicCast<SwitchNode>(n.Get(i))->ClearTable();
		else if (n.Get(i)->GetNodeType() == 0)
			n.Get(i)->GetObject<RdmaDriver>()->m_rdma->ClearTable();
		else if (n.Get(i)->GetNodeType() == 2)
		{
			// OCS has no IP forwarding table.
		}
	}
	DynamicCast<QbbNetDevice>(a->GetDevice(nbr2if[a][b].idx))->TakeDown();
	DynamicCast<QbbNetDevice>(b->GetDevice(nbr2if[b][a].idx))->TakeDown();
	// reset routing table
	SetRoutingEntries();

	// redistribute qp on each host
	for (uint32_t i = 0; i < n.GetN(); i++)
	{
		if (n.Get(i)->GetNodeType() == 0)
			n.Get(i)->GetObject<RdmaDriver>()->m_rdma->RedistributeQp();
	}
}

uint64_t get_nic_rate(NodeContainer &n)
{
	for (uint32_t i = 0; i < n.GetN(); i++)
		if (n.Get(i)->GetNodeType() == 0)
			return DynamicCast<QbbNetDevice>(n.Get(i)->GetDevice(1))->GetDataRate().GetBitRate();
}


static bool
StartsWithCommentOrBlank(const std::string &line)
{
	for (size_t i = 0; i < line.size(); i++)
	{
		if (line[i] == ' ' || line[i] == '\t' || line[i] == '\r')
		{
			continue;
		}
		return line[i] == '#';
	}
	return true;
}

static std::vector<std::string>
TokenizeLine(const std::string &line)
{
	std::vector<std::string> tokens;
	std::istringstream iss(line);
	std::string token;
	while (iss >> token)
	{
		if (!token.empty() && token[0] == '#')
		{
			break;
		}
		tokens.push_back(token);
	}
	return tokens;
}

static uint32_t
ParseUint32Token(const std::string &token, const std::string &line)
{
	char *end = 0;
	unsigned long value = std::strtoul(token.c_str(), &end, 10);
	NS_ASSERT_MSG(end != token.c_str() && *end == '\0', "Invalid uint32 token '" << token << "' in topology line: " << line);
	NS_ASSERT_MSG(value <= 0xfffffffful, "uint32 token out of range '" << token << "' in topology line: " << line);
	return static_cast<uint32_t>(value);
}

static double
ParseDoubleToken(const std::string &token, const std::string &line)
{
	char *end = 0;
	double value = std::strtod(token.c_str(), &end);
	NS_ASSERT_MSG(end != token.c_str() && *end == '\0', "Invalid double token '" << token << "' in topology line: " << line);
	return value;
}


struct RawTopologyLink
{
	std::string line;
	std::vector<std::string> tokens;
};

static bool
IsNumericNodeToken(const std::string &token)
{
	return RdmaMultipathTransport::IsUnsignedIntegerToken(token);
}

static bool
IsExplicitEndpointNodeToken(const std::string &token)
{
	return RdmaMultipathTransport::IsExplicitEndpointToken(token);
}

static bool
IsOcsToken(const std::string &token,
           const std::vector<uint32_t> &node_type,
           uint32_t base_node_num)
{
	if (!IsNumericNodeToken(token))
	{
		return false;
	}
	uint32_t nodeId = ParseUint32Token(token, token);
	return nodeId < base_node_num && node_type[nodeId] == 2;
}

static bool
IsSwitchToken(const std::string &token,
              const std::vector<uint32_t> &node_type,
              uint32_t base_node_num)
{
	if (!IsNumericNodeToken(token))
	{
		return false;
	}
	uint32_t nodeId = ParseUint32Token(token, token);
	return nodeId < base_node_num && node_type[nodeId] == 1;
}

static bool
IsInfrastructureToken(const std::string &token,
                      const std::vector<uint32_t> &node_type,
                      uint32_t base_node_num)
{
	return IsSwitchToken(token, node_type, base_node_num) ||
	       IsOcsToken(token, node_type, base_node_num);
}

static bool
IsEndpointPositionToken(const std::string &token,
                        const std::vector<uint32_t> &node_type,
                        uint32_t base_node_num)
{
	if (IsExplicitEndpointNodeToken(token))
	{
		return true;
	}
	if (!IsNumericNodeToken(token))
	{
		return false;
	}
	uint32_t nodeId = ParseUint32Token(token, token);
	if (nodeId >= base_node_num)
	{
		return true;
	}
	return node_type[nodeId] == 0;
}

static uint32_t
ResolveTopologyNodeToken(const std::string &token,
                         uint32_t base_node_num)
{
	if (rdmaMultipathTransport.HasEndpointToken(token))
	{
		return rdmaMultipathTransport.GetCarrierNodeForToken(token);
	}
	uint32_t nodeId = ParseUint32Token(token, token);
	NS_ASSERT_MSG(nodeId < base_node_num,
		"numeric infrastructure/base node token " << token << " is out of base range");
	return nodeId;
}

} // namespace

OcsRdmaSimulation::OcsRdmaSimulation()
    : m_initialized(false)
{
}

bool
OcsRdmaSimulation::Initialize(const std::string &configFile,
                              const std::string &traceSuffix)
{
  if (m_initialized)
  {
    std::cerr << "OCS/RDMA simulation is already initialized" << std::endl;
    return false;
  }
  return ConfigureAndMaybeRun(configFile, traceSuffix, false, false) == 0;
}

uint16_t
OcsRdmaSimulation::SubmitFlow(
    const std::string &srcToken,
    const std::string &dstToken,
    uint64_t bytes,
    uint32_t tag,
    FlowCompletionCallback completion,
    uint32_t priorityGroup,
    uint32_t destinationPort)
{
  NS_ASSERT_MSG(m_initialized,
                "Initialize() must be called before SubmitFlow()");

  RdmaMultipathTransport::ScheduledFlow scheduled =
      rdmaMultipathTransport.ScheduleFlow(srcToken, dstToken);
  return StartResolvedFlow(
      scheduled.srcCarrierNodeId,
      scheduled.dstCarrierNodeId,
      priorityGroup,
      destinationPort,
      bytes,
      tag,
      completion);
}

bool
OcsRdmaSimulation::IsInitialized() const
{
  return m_initialized;
}

int
OcsRdmaSimulation::RunStaticExperiment(const std::string &configFile,
                                       const std::string &traceSuffix)
{
  return ConfigureAndMaybeRun(configFile, traceSuffix, true, true);
}

int
OcsRdmaSimulation::ConfigureAndMaybeRun(
    const std::string &configFile,
    const std::string &traceSuffix,
    bool loadStaticFlows,
    bool runSimulator)
{
	clock_t begint, endt;
	begint = clock();
	// read the config file
	if (!configFile.empty())
	{
		// Read the configuration file
		std::ifstream conf;
#ifndef PGO_TRAINING
		conf.open(configFile.c_str());
#else
		conf.open(PATH_TO_PGO_CONFIG);
#endif
		while (!conf.eof())
		{
			std::string key;
			conf >> key;

			// std::cout << conf.cur << "\n";

			if (key.compare("ENABLE_QCN") == 0)
			{
				uint32_t v;
				conf >> v;
				enable_qcn = v;
				if (enable_qcn)
					std::cout << "ENABLE_QCN\t\t\t"
							  << "Yes"
							  << "\n";
				else
					std::cout << "ENABLE_QCN\t\t\t"
							  << "No"
							  << "\n";
			}
			else if (key.compare("USE_DYNAMIC_PFC_THRESHOLD") == 0)
			{
				uint32_t v;
				conf >> v;
				use_dynamic_pfc_threshold = v;
				if (use_dynamic_pfc_threshold)
					std::cout << "USE_DYNAMIC_PFC_THRESHOLD\t"
							  << "Yes"
							  << "\n";
				else
					std::cout << "USE_DYNAMIC_PFC_THRESHOLD\t"
							  << "No"
							  << "\n";
			}
			else if (key.compare("CLAMP_TARGET_RATE") == 0)
			{
				uint32_t v;
				conf >> v;
				clamp_target_rate = v;
				if (clamp_target_rate)
					std::cout << "CLAMP_TARGET_RATE\t\t"
							  << "Yes"
							  << "\n";
				else
					std::cout << "CLAMP_TARGET_RATE\t\t"
							  << "No"
							  << "\n";
			}
			else if (key.compare("PAUSE_TIME") == 0)
			{
				double v;
				conf >> v;
				pause_time = v;
				std::cout << "PAUSE_TIME\t\t\t" << pause_time << "\n";
			}
			else if (key.compare("DATA_RATE") == 0)
			{
				std::string v;
				conf >> v;
				data_rate = v;
				std::cout << "DATA_RATE\t\t\t" << data_rate << "\n";
			}
			else if (key.compare("LINK_DELAY") == 0)
			{
				std::string v;
				conf >> v;
				link_delay = v;
				std::cout << "LINK_DELAY\t\t\t" << link_delay << "\n";
			}
			else if (key.compare("PACKET_PAYLOAD_SIZE") == 0)
			{
				uint32_t v;
				conf >> v;
				packet_payload_size = v;
				std::cout << "PACKET_PAYLOAD_SIZE\t\t" << packet_payload_size << "\n";
			}
			else if (key.compare("L2_CHUNK_SIZE") == 0)
			{
				uint32_t v;
				conf >> v;
				l2_chunk_size = v;
				std::cout << "L2_CHUNK_SIZE\t\t\t" << l2_chunk_size << "\n";
			}
			else if (key.compare("L2_ACK_INTERVAL") == 0)
			{
				uint32_t v;
				conf >> v;
				l2_ack_interval = v;
				std::cout << "L2_ACK_INTERVAL\t\t\t" << l2_ack_interval << "\n";
			}
			else if (key.compare("L2_BACK_TO_ZERO") == 0)
			{
				uint32_t v;
				conf >> v;
				l2_back_to_zero = v;
				if (l2_back_to_zero)
					std::cout << "L2_BACK_TO_ZERO\t\t\t"
							  << "Yes"
							  << "\n";
				else
					std::cout << "L2_BACK_TO_ZERO\t\t\t"
							  << "No"
							  << "\n";
			}
			else if (key.compare("TOPOLOGY_FILE") == 0)
			{
				std::string v;
				conf >> v;
				topology_file = v;
				std::cout << "TOPOLOGY_FILE\t\t\t" << topology_file << "\n";
			}
			else if (key.compare("FLOW_FILE") == 0)
			{
				std::string v;
				conf >> v;
				flow_file = v;
				std::cout << "FLOW_FILE\t\t\t" << flow_file << "\n";
			}
			else if (key.compare("TRACE_FILE") == 0)
			{
				std::string v;
				conf >> v;
				trace_file = v;
				std::cout << "TRACE_FILE\t\t\t" << trace_file << "\n";
			}
			else if (key.compare("TRACE_OUTPUT_FILE") == 0)
			{
				std::string v;
				conf >> v;
				trace_output_file = v;
				if (!traceSuffix.empty())
				{
					trace_output_file += traceSuffix;
				}
				std::cout << "TRACE_OUTPUT_FILE\t\t" << trace_output_file << "\n";
			}
			else if (key.compare("SIMULATOR_STOP_TIME") == 0)
			{
				double v;
				conf >> v;
				simulator_stop_time = v;
				std::cout << "SIMULATOR_STOP_TIME\t\t" << simulator_stop_time << "\n";
			}
			else if (key.compare("ALPHA_RESUME_INTERVAL") == 0)
			{
				double v;
				conf >> v;
				alpha_resume_interval = v;
				std::cout << "ALPHA_RESUME_INTERVAL\t\t" << alpha_resume_interval << "\n";
			}
			else if (key.compare("RP_TIMER") == 0)
			{
				double v;
				conf >> v;
				rp_timer = v;
				std::cout << "RP_TIMER\t\t\t" << rp_timer << "\n";
			}
			else if (key.compare("EWMA_GAIN") == 0)
			{
				double v;
				conf >> v;
				ewma_gain = v;
				std::cout << "EWMA_GAIN\t\t\t" << ewma_gain << "\n";
			}
			else if (key.compare("FAST_RECOVERY_TIMES") == 0)
			{
				uint32_t v;
				conf >> v;
				fast_recovery_times = v;
				std::cout << "FAST_RECOVERY_TIMES\t\t" << fast_recovery_times << "\n";
			}
			else if (key.compare("RATE_AI") == 0)
			{
				std::string v;
				conf >> v;
				rate_ai = v;
				std::cout << "RATE_AI\t\t\t\t" << rate_ai << "\n";
			}
			else if (key.compare("RATE_HAI") == 0)
			{
				std::string v;
				conf >> v;
				rate_hai = v;
				std::cout << "RATE_HAI\t\t\t" << rate_hai << "\n";
			}
			else if (key.compare("ERROR_RATE_PER_LINK") == 0)
			{
				double v;
				conf >> v;
				error_rate_per_link = v;
				std::cout << "ERROR_RATE_PER_LINK\t\t" << error_rate_per_link << "\n";
			}
			else if (key.compare("CC_MODE") == 0)
			{
				conf >> cc_mode;
				std::cout << "CC_MODE\t\t" << cc_mode << '\n';
			}
			else if (key.compare("RATE_DECREASE_INTERVAL") == 0)
			{
				double v;
				conf >> v;
				rate_decrease_interval = v;
				std::cout << "RATE_DECREASE_INTERVAL\t\t" << rate_decrease_interval << "\n";
			}
			else if (key.compare("MIN_RATE") == 0)
			{
				conf >> min_rate;
				std::cout << "MIN_RATE\t\t" << min_rate << "\n";
			}
			else if (key.compare("FCT_OUTPUT_FILE") == 0)
			{
				conf >> fct_output_file;
				std::cout << "FCT_OUTPUT_FILE\t\t" << fct_output_file << '\n';
			}
			else if (key.compare("HAS_WIN") == 0)
			{
				conf >> has_win;
				std::cout << "HAS_WIN\t\t" << has_win << "\n";
			}
			else if (key.compare("GLOBAL_T") == 0)
			{
				conf >> global_t;
				std::cout << "GLOBAL_T\t\t" << global_t << '\n';
			}
			else if (key.compare("MI_THRESH") == 0)
			{
				conf >> mi_thresh;
				std::cout << "MI_THRESH\t\t" << mi_thresh << '\n';
			}
			else if (key.compare("VAR_WIN") == 0)
			{
				uint32_t v;
				conf >> v;
				var_win = v;
				std::cout << "VAR_WIN\t\t" << v << '\n';
			}
			else if (key.compare("FAST_REACT") == 0)
			{
				uint32_t v;
				conf >> v;
				fast_react = v;
				std::cout << "FAST_REACT\t\t" << v << '\n';
			}
			else if (key.compare("U_TARGET") == 0)
			{
				conf >> u_target;
				std::cout << "U_TARGET\t\t" << u_target << '\n';
			}
			else if (key.compare("INT_MULTI") == 0)
			{
				conf >> int_multi;
				std::cout << "INT_MULTI\t\t\t\t" << int_multi << '\n';
			}
			else if (key.compare("RATE_BOUND") == 0)
			{
				uint32_t v;
				conf >> v;
				rate_bound = v;
				std::cout << "RATE_BOUND\t\t" << rate_bound << '\n';
			}
			else if (key.compare("ACK_HIGH_PRIO") == 0)
			{
				conf >> ack_high_prio;
				std::cout << "ACK_HIGH_PRIO\t\t" << ack_high_prio << '\n';
			}
			else if (key.compare("DCTCP_RATE_AI") == 0)
			{
				conf >> dctcp_rate_ai;
				std::cout << "DCTCP_RATE_AI\t\t\t\t" << dctcp_rate_ai << "\n";
			}
			else if (key.compare("PFC_OUTPUT_FILE") == 0)
			{
				conf >> pfc_output_file;
				std::cout << "PFC_OUTPUT_FILE\t\t\t\t" << pfc_output_file << '\n';
			}
			else if (key.compare("LINK_DOWN") == 0)
			{
				conf >> link_down_time >> link_down_A >> link_down_B;
				std::cout << "LINK_DOWN\t\t\t\t" << link_down_time << ' ' << link_down_A << ' ' << link_down_B << '\n';
			}
			else if (key.compare("ENABLE_TRACE") == 0)
			{
				conf >> enable_trace;
				std::cout << "ENABLE_TRACE\t\t\t\t" << enable_trace << '\n';
			}
			else if (key.compare("KMAX_MAP") == 0)
			{
				int n_k;
				conf >> n_k;
				std::cout << "KMAX_MAP\t\t\t\t";
				for (int i = 0; i < n_k; i++)
				{
					uint64_t rate;
					uint32_t k;
					conf >> rate >> k;
					rate2kmax[rate] = k;
					std::cout << ' ' << rate << ' ' << k;
				}
				std::cout << '\n';
			}
			else if (key.compare("KMIN_MAP") == 0)
			{
				int n_k;
				conf >> n_k;
				std::cout << "KMIN_MAP\t\t\t\t";
				for (int i = 0; i < n_k; i++)
				{
					uint64_t rate;
					uint32_t k;
					conf >> rate >> k;
					rate2kmin[rate] = k;
					std::cout << ' ' << rate << ' ' << k;
				}
				std::cout << '\n';
			}
			else if (key.compare("PMAX_MAP") == 0)
			{
				int n_k;
				conf >> n_k;
				std::cout << "PMAX_MAP\t\t\t\t";
				for (int i = 0; i < n_k; i++)
				{
					uint64_t rate;
					double p;
					conf >> rate >> p;
					rate2pmax[rate] = p;
					std::cout << ' ' << rate << ' ' << p;
				}
				std::cout << '\n';
			}
			else if (key.compare("BUFFER_SIZE") == 0)
			{
				conf >> buffer_size;
				std::cout << "BUFFER_SIZE\t\t\t\t" << buffer_size << '\n';
			}
			else if (key.compare("QLEN_MON_FILE") == 0)
			{
				conf >> qlen_mon_file;
				std::cout << "QLEN_MON_FILE\t\t\t\t" << qlen_mon_file << '\n';
			}
			else if (key.compare("QLEN_MON_START") == 0)
			{
				conf >> qlen_mon_start;
				std::cout << "QLEN_MON_START\t\t\t\t" << qlen_mon_start << '\n';
			}
			else if (key.compare("QLEN_MON_END") == 0)
			{
				conf >> qlen_mon_end;
				std::cout << "QLEN_MON_END\t\t\t\t" << qlen_mon_end << '\n';
			}
			else if (key.compare("MULTI_RATE") == 0)
			{
				int v;
				conf >> v;
				multi_rate = v;
				std::cout << "MULTI_RATE\t\t\t\t" << multi_rate << '\n';
			}
			else if (key.compare("SAMPLE_FEEDBACK") == 0)
			{
				int v;
				conf >> v;
				sample_feedback = v;
				std::cout << "SAMPLE_FEEDBACK\t\t\t\t" << sample_feedback << '\n';
			}
			else if (key.compare("PINT_LOG_BASE") == 0)
			{
				conf >> pint_log_base;
				std::cout << "PINT_LOG_BASE\t\t\t\t" << pint_log_base << '\n';
			}
			else if (key.compare("PINT_PROB") == 0)
			{
				conf >> pint_prob;
				std::cout << "PINT_PROB\t\t\t\t" << pint_prob << '\n';
			}
			else if (key.compare("TOPOLOGY_FORMAT") == 0)
			{
				conf >> topology_format;
				std::cout << "TOPOLOGY_FORMAT_CONFIG\t\t" << topology_format << "\n";
			}
			else if (key.compare("OCS_MAP_FILE") == 0)
			{
				conf >> ocs_map_file;
				std::cout << "OCS_MAP_FILE\t\t\t" << ocs_map_file << "\n";
			}
			else if (key.compare("OCS_SCHEDULE_ENABLE") == 0)
			{
				conf >> ocs_schedule_enable;
				std::cout << "OCS_SCHEDULE_ENABLE\t\t" << ocs_schedule_enable << "\n";
			}
			else if (key.compare("OCS_SCHEDULE_FILE") == 0)
			{
				conf >> ocs_schedule_file;
				std::cout << "OCS_SCHEDULE_FILE\t\t" << ocs_schedule_file << "\n";
			}
			else if (key.compare("RNIC_GATE_ENABLE") == 0) {
				conf >> rnic_gate_enable;
				std::cout << "RNIC_GATE_ENABLE\t\t" << rnic_gate_enable << "\n";
			}
			fflush(stdout);
		}
		conf.close();
	}
	else
	{
		std::cout << "Error: require a config file\n";
		fflush(stdout);
		return 1;
	}

	bool dynamicth = use_dynamic_pfc_threshold;

	// 为与 QbbNetDevice 相关的仿真参数设置默认值
	Config::SetDefault("ns3::QbbNetDevice::PauseTime", UintegerValue(pause_time));
	Config::SetDefault("ns3::QbbNetDevice::QcnEnabled", BooleanValue(enable_qcn));
	Config::SetDefault("ns3::QbbNetDevice::DynamicThreshold", BooleanValue(dynamicth));

	// set int_multi
	IntHop::multi = int_multi;
	// IntHeader::mode
	if (cc_mode == 7) // timely, use ts
		IntHeader::mode = IntHeader::TS;
	else if (cc_mode == 3) // hpcc, use int
		IntHeader::mode = IntHeader::NORMAL;
	else if (cc_mode == 10) // hpcc-pint
		IntHeader::mode = IntHeader::PINT;
	else // others, no extra header
		IntHeader::mode = IntHeader::NONE;

	// Set Pint
	if (cc_mode == 10)
	{
		Pint::set_log_base(pint_log_base);
		IntHeader::pint_bytes = Pint::get_n_bytes();
		printf("PINT bits: %d bytes: %d\n", Pint::get_n_bits(), Pint::get_n_bytes());
	}

	// SeedManager::SetSeed(time(NULL));

	// set topology, flow and trace
	topof.open(topology_file.c_str());
	if (loadStaticFlows)
	{
		flowf.open(flow_file.c_str());
	}
	tracef.open(trace_file.c_str());
	uint32_t node_num, switch_num, link_num, trace_num;
	uint32_t ocs_num = 0;
	bool topology_has_logical_ports = false;

	std::string firstLine;
	std::getline(topof, firstLine);

	// Skip blank lines before the topology header.
	while (firstLine.size() == 0 && std::getline(topof, firstLine)) {
	}

	std::stringstream headerStream(firstLine);
	std::vector<uint32_t> headerFields;
	uint32_t headerValue;
	while (headerStream >> headerValue) {
		headerFields.push_back(headerValue);
	}

	if (headerFields.size() == 3) {
		// Legacy format:
		// node_num switch_num link_num
		// src dst rate delay error
		node_num = headerFields[0];
		switch_num = headerFields[1];
		link_num = headerFields[2];
		NS_ASSERT_MSG(topology_format == "auto" || topology_format == "legacy",
				"3-field topology header only supports TOPOLOGY_FORMAT auto or legacy");
		std::cout << "TOPOLOGY_FORMAT\t\t\tlegacy\n";
	}
	else if (headerFields.size() == 4) {
		// OCS-aware format:
		// node_num switch_num ocs_num link_num
		// Supported link formats:
		//   with_ocs_ports:    src dst src_port dst_port rate delay error
		//   compact_ocs_ports: src dst [only OCS endpoint logical ports] rate delay error
		node_num = headerFields[0];
		switch_num = headerFields[1];
		ocs_num = headerFields[2];
		link_num = headerFields[3];
		topology_has_logical_ports = true;
		NS_ASSERT_MSG(topology_format == "auto" || topology_format == "with_ocs_ports" || topology_format == "compact_ocs_ports",
				"4-field topology header only supports TOPOLOGY_FORMAT auto, with_ocs_ports, or compact_ocs_ports");
		std::cout << "TOPOLOGY_FORMAT\t\t\t"
				  << (topology_format == "auto" ? "auto_ocs_ports" : topology_format)
				  << "\n";
	}
	else {
		NS_ASSERT_MSG(false, "Invalid topology header format");
	}

	std::cout << "TOPOLOGY_NODES\t\t\t" << node_num << "\n";
	std::cout << "TOPOLOGY_SWITCHES\t\t" << switch_num << "\n";
	std::cout << "TOPOLOGY_OCS\t\t\t" << ocs_num << "\n";
	std::cout << "TOPOLOGY_LINKS\t\t\t" << link_num << "\n";

	flow_num = 0;
	if (loadStaticFlows)
	{
		flowf >> flow_num;
	}
	tracef >> trace_num;

	// Set node roles: 0 = host, 1 = packet switch, 2 = OCS.
	std::vector<uint32_t> node_type(node_num, 0);
	for (uint32_t i = 0; i < switch_num; i++)
	{
		uint32_t sid;
		topof >> sid;
		NS_ASSERT_MSG(sid < node_num, "switch id out of range");
		node_type[sid] = 1;
		std::cout << "[TOPOLOGY SWITCH] node=" << sid << std::endl;
	}

	for (uint32_t i = 0; i < ocs_num; i++)
	{
		uint32_t oid;
		topof >> oid;
		NS_ASSERT_MSG(oid < node_num, "OCS id out of range");
		NS_ASSERT_MSG(node_type[oid] == 0, "OCS node conflicts with switch node");
		node_type[oid] = 2;
		ocs_node_ids.insert(oid);
		std::cout << "[TOPOLOGY OCS] node=" << oid << std::endl;
	}

	// Switch and OCS IDs are token-based. Move to the next line before
	// parsing link entries line-by-line so compact_ocs_ports can have
	// variable token counts per link. If there are no ID tokens, the stream
	// is already positioned at the first link line.
	if (switch_num + ocs_num > 0)
	{
		topof.ignore(std::numeric_limits<std::streamsize>::max(), '\n');
	}

	// Multipath/multiplane topology parsing uses two passes.  The first pass
	// records link lines and registers host endpoint tokens:
	//   N     : logicalNode N single endpoint
	//   N-R-P : logicalNode N, RNICGroup R, plane P endpoint
	// Numeric switch / OCS tokens remain infrastructure nodes.  Explicit
	// N-R-P endpoints and numeric endpoints outside the base node namespace are
	// assigned carrier RNIC node IDs automatically.
	const uint32_t base_node_num = node_num;
	uint32_t next_carrier_node_id = base_node_num;
	std::vector<RawTopologyLink> rawLinks;
	rawLinks.reserve(link_num);

	for (uint32_t i = 0; i < link_num; i++)
	{
		std::string linkLine;
		std::vector<std::string> tokens;
		while (std::getline(topof, linkLine))
		{
			if (StartsWithCommentOrBlank(linkLine))
			{
				continue;
			}
			tokens = TokenizeLine(linkLine);
			if (!tokens.empty())
			{
				break;
			}
		}
		NS_ASSERT_MSG(!tokens.empty(), "Unexpected end of topology file while reading link " << i);
		NS_ASSERT_MSG(tokens.size() >= 2, "Invalid topology link line: expected at least src and dst: " << linkLine);

		for (uint32_t endpointIdx = 0; endpointIdx < 2; endpointIdx++)
		{
			const std::string &tok = tokens[endpointIdx];
			if (!IsEndpointPositionToken(tok, node_type, base_node_num))
			{
				continue;
			}

			if (rdmaMultipathTransport.HasEndpointToken(tok))
			{
				continue;
			}

			bool explicitEndpoint = IsExplicitEndpointNodeToken(tok);
			uint32_t carrier = 0;
			if (!explicitEndpoint && IsNumericNodeToken(tok))
			{
				uint32_t nodeId = ParseUint32Token(tok, linkLine);
				if (nodeId < base_node_num)
				{
					NS_ASSERT_MSG(node_type[nodeId] == 0,
						"numeric topology endpoint " << tok << " is not a host node");
					carrier = nodeId;
				}
				else
				{
					carrier = next_carrier_node_id++;
				}
			}
			else
			{
				carrier = next_carrier_node_id++;
			}

			rdmaMultipathTransport.RegisterTopologyEndpoint(tok, carrier, explicitEndpoint);
		}

		RawTopologyLink raw;
		raw.line = linkLine;
		raw.tokens = tokens;
		rawLinks.push_back(raw);
	}

	node_num = next_carrier_node_id;
	node_type.resize(node_num, 0);
	std::cout << "TOPOLOGY_BASE_NODES\t\t" << base_node_num << "\n";
	std::cout << "TOPOLOGY_NODES_FINAL\t\t" << node_num << "\n";
	rdmaMultipathTransport.DumpEndpoints(std::cout);

	for (uint32_t i = 0; i < node_num; i++)
	{
		if (node_type[i] == 2)
		{
			Ptr<OcsNode> ocs = CreateObject<OcsNode>();
			n.Add(ocs);
			std::cout << "Create OCS node: " << i << std::endl;
		}
		else if (node_type[i] == 1)
		{
			Ptr<SwitchNode> sw = CreateObject<SwitchNode>();
			n.Add(sw);
			sw->SetAttribute("EcnEnabled", BooleanValue(enable_qcn));
			std::cout << "Create switch node: " << i << std::endl;
		}
		else
		{
			n.Add(CreateObject<Node>());
		}
	}

	rdmaOcsController = CreateObject<RdmaOcsController>();
	rdmaOcsController->SetNodeContainer(n);
	// PACKET_PAYLOAD_SIZE excludes protocol headers. The RNIC gate deadline
	// uses the approximate wire packet size observed by the OCS data path.
	rdmaOcsController->SetRnicGatePacketBytes(packet_payload_size + 92);

	for (std::set<uint32_t>::iterator it = ocs_node_ids.begin();
		it != ocs_node_ids.end();
		++it)
	{
		rdmaOcsController->AddOcsNode(*it);
	}

	NS_LOG_INFO("Create nodes.");

	InternetStackHelper internet;
	internet.Install(n);

	//
	// Assign IP to each server
	//
	for (uint32_t i = 0; i < node_num; i++)
	{
		if (n.Get(i)->GetNodeType() == 0)
		{ // is server
			serverAddress.resize(i + 1);
			serverAddress[i] = node_id_to_ip(i);
		}
	}

	NS_LOG_INFO("Create channels.");

	//
	// Explicitly create the channels required by the topology.
	//

	//
	// set error rate model
	//
	Ptr<RateErrorModel> rem = CreateObject<RateErrorModel>();
	Ptr<UniformRandomVariable> uv = CreateObject<UniformRandomVariable>();
	rem->SetRandomVariable(uv);
	uv->SetStream(50);
	rem->SetAttribute("ErrorRate", DoubleValue(error_rate_per_link));
	rem->SetAttribute("ErrorUnit", StringValue("ERROR_UNIT_PACKET"));

	FILE *pfc_file = fopen(pfc_output_file.c_str(), "w");

	QbbHelper qbb;
	Ipv4AddressHelper ipv4;
	//
	// set link attribute
	//
	std::vector<uint32_t> nextAutoLogicalPort(node_num, 0);
	for (uint32_t i = 0; i < link_num; i++)
	{
		uint32_t src = 0, dst = 0;
		uint32_t srcPort = 0, dstPort = 0;
		std::string data_rate, link_delay;
		double error_rate = 0.0;

		NS_ASSERT_MSG(i < rawLinks.size(), "raw topology link index out of range");
		std::string linkLine = rawLinks[i].line;
		std::vector<std::string> tokens = rawLinks[i].tokens;
		NS_ASSERT_MSG(tokens.size() >= 2, "Invalid topology link line: expected at least src and dst: " << linkLine);

		src = ResolveTopologyNodeToken(tokens[0], base_node_num);
		dst = ResolveTopologyNodeToken(tokens[1], base_node_num);
		NS_ASSERT_MSG(src < node_num, "resolved link src node id out of range in topology line: " << linkLine);
		NS_ASSERT_MSG(dst < node_num, "resolved link dst node id out of range in topology line: " << linkLine);

		if (!topology_has_logical_ports) {
			// Legacy format:
			// src dst rate delay error
			NS_ASSERT_MSG(tokens.size() == 5,
					"Invalid legacy topology link line: expected 5 tokens, got "
					<< tokens.size() << ": " << linkLine);
			srcPort = nextAutoLogicalPort[src]++;
			dstPort = nextAutoLogicalPort[dst]++;
			data_rate = tokens[2];
			link_delay = tokens[3];
			error_rate = ParseDoubleToken(tokens[4], linkLine);
		}
		else {
			const bool srcIsOcs = (node_type[src] == 2);
			const bool dstIsOcs = (node_type[dst] == 2);
			const size_t compactTokens = 2 + (srcIsOcs ? 1 : 0) + (dstIsOcs ? 1 : 0) + 3;
			const bool forceCompact = (topology_format == "compact_ocs_ports");
			const bool forceFull = (topology_format == "with_ocs_ports");
			const bool useCompact = forceCompact || (!forceFull && tokens.size() == compactTokens);

			if (useCompact) {
				NS_ASSERT_MSG(tokens.size() == compactTokens,
						"Invalid compact_ocs_ports topology link line: expected "
						<< compactTokens << " tokens, got " << tokens.size()
						<< ": " << linkLine);
				size_t idx = 2;
				if (srcIsOcs) {
					srcPort = ParseUint32Token(tokens[idx++], linkLine);
				}
				else {
					srcPort = nextAutoLogicalPort[src]++;
				}
				if (dstIsOcs) {
					dstPort = ParseUint32Token(tokens[idx++], linkLine);
				}
				else {
					dstPort = nextAutoLogicalPort[dst]++;
				}
				data_rate = tokens[idx++];
				link_delay = tokens[idx++];
				error_rate = ParseDoubleToken(tokens[idx++], linkLine);
			}
			else {
				// Full OCS-aware format:
				// src dst src_port dst_port rate delay error
				NS_ASSERT_MSG(tokens.size() == 7,
						"Invalid with_ocs_ports topology link line: expected 7 tokens, got "
						<< tokens.size() << ": " << linkLine);
				srcPort = ParseUint32Token(tokens[2], linkLine);
				dstPort = ParseUint32Token(tokens[3], linkLine);
				data_rate = tokens[4];
				link_delay = tokens[5];
				error_rate = ParseDoubleToken(tokens[6], linkLine);

				if (!srcIsOcs) {
					nextAutoLogicalPort[src] = std::max(nextAutoLogicalPort[src], srcPort + 1);
				}
				if (!dstIsOcs) {
					nextAutoLogicalPort[dst] = std::max(nextAutoLogicalPort[dst], dstPort + 1);
				}
			}
		}

		Ptr<Node> snode = n.Get(src), dnode = n.Get(dst);

		qbb.SetDeviceAttribute("DataRate", StringValue(data_rate));
		qbb.SetChannelAttribute("Delay", StringValue(link_delay));

		if (error_rate > 0)
		{
			Ptr<RateErrorModel> rem = CreateObject<RateErrorModel>();
			Ptr<UniformRandomVariable> uv = CreateObject<UniformRandomVariable>();
			rem->SetRandomVariable(uv);
			uv->SetStream(50);
			rem->SetAttribute("ErrorRate", DoubleValue(error_rate));
			rem->SetAttribute("ErrorUnit", StringValue("ERROR_UNIT_PACKET"));
			qbb.SetDeviceAttribute("ReceiveErrorModel", PointerValue(rem));
		}
		else
		{
			qbb.SetDeviceAttribute("ReceiveErrorModel", PointerValue(rem));
		}

		fflush(stdout);

		// Assigne server IP
		// Note: this should be before the automatic assignment below (ipv4.Assign(d)),
		// because we want our IP to be the primary IP (first in the IP address list),
		// so that the global routing is based on our IP
		NetDeviceContainer d = qbb.Install(snode, dnode);

		Ptr<QbbNetDevice> srcDev = DynamicCast<QbbNetDevice>(d.Get(0));
		Ptr<QbbNetDevice> dstDev = DynamicCast<QbbNetDevice>(d.Get(1));
		NS_ASSERT_MSG(srcDev != 0, "source device is not QbbNetDevice");
		NS_ASSERT_MSG(dstDev != 0, "destination device is not QbbNetDevice");

		uint32_t srcIf = srcDev->GetIfIndex();
		uint32_t dstIf = dstDev->GetIfIndex();

		if (topology_has_logical_ports) {
			uint64_t srcLinkDelayNs = DynamicCast<QbbChannel>(srcDev->GetChannel())->GetDelay().GetNanoSeconds();
			uint64_t dstLinkDelayNs = DynamicCast<QbbChannel>(dstDev->GetChannel())->GetDelay().GetNanoSeconds();
			uint64_t srcLinkBandwidthBps = srcDev->GetDataRate().GetBitRate();
			uint64_t dstLinkBandwidthBps = dstDev->GetDataRate().GetBitRate();

			rdmaOcsController->AddPortBinding(src, srcPort, srcIf, dst, dstPort,
										srcLinkDelayNs, srcLinkBandwidthBps);
			rdmaOcsController->AddPortBinding(dst, dstPort, dstIf, src, srcPort,
										dstLinkDelayNs, dstLinkBandwidthBps);

			std::cout << "[PORT MAP] node " << src
					<< " logical " << srcPort
					<< " -> if " << srcIf
					<< " connected to node " << dst
					<< " logical " << dstPort
					<< std::endl;
			std::cout << "[PORT MAP] node " << dst
					<< " logical " << dstPort
					<< " -> if " << dstIf
					<< " connected to node " << src
					<< " logical " << srcPort
					<< std::endl;
		}

		if (snode->GetNodeType() == 0)
		{
			Ptr<Ipv4> ipv4 = snode->GetObject<Ipv4>();
			ipv4->AddInterface(d.Get(0));
			ipv4->AddAddress(1, Ipv4InterfaceAddress(serverAddress[src], Ipv4Mask(0xff000000)));
		}
		if (dnode->GetNodeType() == 0)
		{
			Ptr<Ipv4> ipv4 = dnode->GetObject<Ipv4>();
			ipv4->AddInterface(d.Get(1));
			ipv4->AddAddress(1, Ipv4InterfaceAddress(serverAddress[dst], Ipv4Mask(0xff000000)));
		}

		// used to create a graph of the topology
		nbr2if[snode][dnode].idx = srcIf;
		nbr2if[snode][dnode].up = true;
		nbr2if[snode][dnode].delay = DynamicCast<QbbChannel>(srcDev->GetChannel())->GetDelay().GetTimeStep();
		nbr2if[snode][dnode].bw = srcDev->GetDataRate().GetBitRate();
		nbr2if[dnode][snode].idx = dstIf;
		nbr2if[dnode][snode].up = true;
		nbr2if[dnode][snode].delay = DynamicCast<QbbChannel>(dstDev->GetChannel())->GetDelay().GetTimeStep();
		nbr2if[dnode][snode].bw = dstDev->GetDataRate().GetBitRate();

		// This is just to set up the connectivity between nodes. The IP addresses are useless
		char ipstring[16];
		sprintf(ipstring, "10.%d.%d.0", i / 254 + 1, i % 254 + 1);
		ipv4.SetBase(ipstring, "255.255.255.0");
		ipv4.Assign(d);

		// setup PFC trace
		srcDev->TraceConnectWithoutContext("QbbPfc", MakeBoundCallback(&get_pfc, pfc_file, srcDev));
		dstDev->TraceConnectWithoutContext("QbbPfc", MakeBoundCallback(&get_pfc, pfc_file, dstDev));
	}

	if (ocs_schedule_enable && !ocs_node_ids.empty()) {
		rdmaOcsController->LoadAndInstallOcsSchedule(ocs_schedule_file);

		if (rnic_gate_enable) {
			rdmaOcsController->BuildRnicGroups();
			rdmaOcsController->DumpRnicGroups();
			rdmaOcsController->CompileRnicReachabilityWindows();
			rdmaOcsController->DumpRnicReachabilityWindows();
		} else {
			std::cout << "[RNIC GATE DISABLED] mode=default_rdma reason=RNIC_GATE_ENABLE_0" << std::endl;
		}
	} else if (!ocs_node_ids.empty()) {
		rdmaOcsController->LoadAndInstallOcsMap(ocs_map_file);
	} else {
		std::cout << "[OCS DISABLED] no OCS nodes; skip OCS controller" << std::endl;
	}

	nic_rate = get_nic_rate(n);

	// config switch
	for (uint32_t i = 0; i < node_num; i++)
	{
		if (n.Get(i)->GetNodeType() == 1)
		{ // is switch
			Ptr<SwitchNode> sw = DynamicCast<SwitchNode>(n.Get(i));
			uint32_t shift = 3; // by default 1/8
			for (uint32_t j = 1; j < sw->GetNDevices(); j++)
			{
				Ptr<QbbNetDevice> dev = DynamicCast<QbbNetDevice>(sw->GetDevice(j));
				// set ecn
				uint64_t rate = dev->GetDataRate().GetBitRate();
				NS_ASSERT_MSG(rate2kmin.find(rate) != rate2kmin.end(), "must set kmin for each link speed");
				NS_ASSERT_MSG(rate2kmax.find(rate) != rate2kmax.end(), "must set kmax for each link speed");
				NS_ASSERT_MSG(rate2pmax.find(rate) != rate2pmax.end(), "must set pmax for each link speed");
				sw->m_mmu->ConfigEcn(j, rate2kmin[rate], rate2kmax[rate], rate2pmax[rate]);
				// set pfc
				uint64_t delay = DynamicCast<QbbChannel>(dev->GetChannel())->GetDelay().GetTimeStep();
				uint32_t headroom = rate * delay / 8 / 1000000000 * 3;
				sw->m_mmu->ConfigHdrm(j, headroom);

				// set pfc alpha, proportional to link bw
				sw->m_mmu->pfc_a_shift[j] = shift;
				while (rate > nic_rate && sw->m_mmu->pfc_a_shift[j] > 0)
				{
					sw->m_mmu->pfc_a_shift[j]--;
					rate /= 2;
				}
			}
			sw->m_mmu->ConfigNPort(sw->GetNDevices() - 1);
			sw->m_mmu->ConfigBufferSize(buffer_size * 1024 * 1024);
			sw->m_mmu->node_id = sw->GetId();
		}
	}

#if ENABLE_QP
	FILE *fct_output = fopen(fct_output_file.c_str(), "w");
	//
	// install RDMA driver
	//
	for (uint32_t i = 0; i < node_num; i++)
	{
		if (n.Get(i)->GetNodeType() == 0)
		{ // is server
			// create RdmaHw
			Ptr<RdmaHw> rdmaHw = CreateObject<RdmaHw>();
			rdmaHw->SetAttribute("ClampTargetRate", BooleanValue(clamp_target_rate));
			rdmaHw->SetAttribute("AlphaResumInterval", DoubleValue(alpha_resume_interval));
			rdmaHw->SetAttribute("RPTimer", DoubleValue(rp_timer));
			rdmaHw->SetAttribute("FastRecoveryTimes", UintegerValue(fast_recovery_times));
			rdmaHw->SetAttribute("EwmaGain", DoubleValue(ewma_gain));
			rdmaHw->SetAttribute("RateAI", DataRateValue(DataRate(rate_ai)));
			rdmaHw->SetAttribute("RateHAI", DataRateValue(DataRate(rate_hai)));
			rdmaHw->SetAttribute("L2BackToZero", BooleanValue(l2_back_to_zero));
			rdmaHw->SetAttribute("L2ChunkSize", UintegerValue(l2_chunk_size));
			rdmaHw->SetAttribute("L2AckInterval", UintegerValue(l2_ack_interval));
			rdmaHw->SetAttribute("CcMode", UintegerValue(cc_mode));
			rdmaHw->SetAttribute("RateDecreaseInterval", DoubleValue(rate_decrease_interval));
			rdmaHw->SetAttribute("MinRate", DataRateValue(DataRate(min_rate)));
			rdmaHw->SetAttribute("Mtu", UintegerValue(packet_payload_size));
			rdmaHw->SetAttribute("MiThresh", UintegerValue(mi_thresh));
			rdmaHw->SetAttribute("VarWin", BooleanValue(var_win));
			rdmaHw->SetAttribute("FastReact", BooleanValue(fast_react));
			rdmaHw->SetAttribute("MultiRate", BooleanValue(multi_rate));
			rdmaHw->SetAttribute("SampleFeedback", BooleanValue(sample_feedback));
			rdmaHw->SetAttribute("TargetUtil", DoubleValue(u_target));
			rdmaHw->SetAttribute("RateBound", BooleanValue(rate_bound));
			rdmaHw->SetAttribute("DctcpRateAI", DataRateValue(DataRate(dctcp_rate_ai)));
			rdmaHw->SetPintSmplThresh(pint_prob);
			// create and install RdmaDriver
			Ptr<RdmaDriver> rdma = CreateObject<RdmaDriver>();
			Ptr<Node> node = n.Get(i);
			rdma->SetNode(node);
			rdma->SetRdmaHw(rdmaHw);

			node->AggregateObject(rdma);
			rdma->Init();

			rdma->SetInjectionMode(
				rnic_gate_enable);

			rdma->ConfigureUserspaceTransport(
				userspace_wr_chunk_bytes,
				userspace_max_outstanding_bytes);

			rdma->TraceConnectWithoutContext(
				"QpComplete",
				MakeBoundCallback(
					qp_finish,
					fct_output));
		}
	}
#endif

	if (ocs_schedule_enable &&
		!ocs_node_ids.empty())
	{
		if (rnic_gate_enable == 1)
		{
			rdmaOcsController
				->InstallRnicGateTablesToRdmaHw();

			std::cout
				<< "[RDMA GATE MODE]"
				<< " mode=1 layer=rnic"
				<< std::endl;
		}
		else if (rnic_gate_enable == 2)
		{
			rdmaOcsController
				->InstallRnicGateTablesToUserspace();

			std::cout
				<< "[RDMA GATE MODE]"
				<< " mode=2 layer=userspace"
				<< std::endl;
		}
		else
		{
			std::cout
				<< "[RDMA GATE MODE]"
				<< " mode=0 layer=default"
				<< std::endl;
		}
	}

	// set ACK priority on hosts
	if (ack_high_prio)
		RdmaEgressQueue::ack_q_idx = 0;
	else
		RdmaEgressQueue::ack_q_idx = 3;

	// setup routing
	CalculateRoutes(n);
	SetRoutingEntries();

	//
	// get BDP and delay
	//
	maxRtt = maxBdp = 0;
	for (uint32_t i = 0; i < node_num; i++)
	{
		if (n.Get(i)->GetNodeType() != 0)
			continue;
		for (uint32_t j = 0; j < node_num; j++)
		{
			if (n.Get(j)->GetNodeType() != 0)
				continue;
			if (pairDelay[n.Get(i)].find(n.Get(j)) == pairDelay[n.Get(i)].end())
				continue;
			if (pairTxDelay[n.Get(i)].find(n.Get(j)) == pairTxDelay[n.Get(i)].end())
				continue;
			if (pairBw[i].find(j) == pairBw[i].end())
				continue;
			uint64_t delay = pairDelay[n.Get(i)][n.Get(j)];
			uint64_t txDelay = pairTxDelay[n.Get(i)][n.Get(j)];
			uint64_t rtt = delay * 2 + txDelay;
			uint64_t bw = pairBw[i][j];
			uint64_t bdp = rtt * bw / 1000000000 / 8;
			pairBdp[n.Get(i)][n.Get(j)] = bdp;
			pairRtt[i][j] = rtt;
			if (bdp > maxBdp)
				maxBdp = bdp;
			if (rtt > maxRtt)
				maxRtt = rtt;
		}
	}
	printf("maxRtt=%lu maxBdp=%lu\n", maxRtt, maxBdp);

	// Export host-to-host route costs to the MPQUIC-like RDMA multipath
	// transport layer. The transport layer uses these costs only for endpoint
	// binding before creating a concrete RDMA flow; packet forwarding remains in
	// the existing RDMA/switch forwarding tables.
	rdmaMultipathTransport.ClearRouteCosts();
	for (uint32_t i = 0; i < node_num; i++)
	{
		if (n.Get(i)->GetNodeType() != 0)
			continue;
		for (uint32_t j = 0; j < node_num; j++)
		{
			if (n.Get(j)->GetNodeType() != 0)
				continue;
			if (pairDelay[n.Get(i)].find(n.Get(j)) == pairDelay[n.Get(i)].end())
				continue;
			uint64_t cost = pairDelay[n.Get(i)][n.Get(j)] + pairTxDelay[n.Get(i)][n.Get(j)];
			rdmaMultipathTransport.AddRouteCost(i, j, cost);
		}
	}


	//
	// setup switch CC
	//
	for (uint32_t i = 0; i < node_num; i++)
	{
		if (n.Get(i)->GetNodeType() == 1)
		{ // switch
			Ptr<SwitchNode> sw = DynamicCast<SwitchNode>(n.Get(i));
			sw->SetAttribute("CcMode", UintegerValue(cc_mode));
			sw->SetAttribute("MaxRtt", UintegerValue(maxRtt));
		}
	}

	//
	// add trace
	//

	NodeContainer trace_nodes;
	for (uint32_t i = 0; i < trace_num; i++)
	{
		uint32_t nid;
		tracef >> nid;
		if (nid >= n.GetN())
		{
			continue;
		}
		trace_nodes = NodeContainer(trace_nodes, n.Get(nid));
	}

	FILE *trace_output = fopen(trace_output_file.c_str(), "w");
	if (enable_trace)
		qbb.EnableTracing(trace_output, trace_nodes);

	// dump link speed to trace file
	{
		SimSetting sim_setting;
		for (auto i : nbr2if)
		{
			for (auto j : i.second)
			{
				uint16_t node = i.first->GetId();
				uint8_t intf = j.second.idx;
				uint64_t bps = DynamicCast<QbbNetDevice>(i.first->GetDevice(j.second.idx))->GetDataRate().GetBitRate();
				sim_setting.port_speed[node][intf] = bps;
			}
		}
		sim_setting.win = maxBdp;
		sim_setting.Serialize(trace_output);
	}

	Ipv4GlobalRoutingHelper::PopulateRoutingTables();

	NS_LOG_INFO("Create Applications.");

	Time interPacketInterval = Seconds(0.0000005 / 2);

	// maintain port number for each host
	for (uint32_t i = 0; i < node_num; i++)
	{
		if (n.Get(i)->GetNodeType() == 0)
			for (uint32_t j = 0; j < node_num; j++)
			{
				if (n.Get(j)->GetNodeType() == 0)
					portNumder[i][j] = 10000; // each host pair use port number from 10000
			}
	}

	RdmaHw::ClearFlowRxTrace();
	RdmaHw::ConfigureFlowRxTrace(true, 100000); // 100 us buckets for dashboard throughput timeline

	flow_input.idx = 0;
	if (flow_num > 0)
	{
		ReadFlowInput();
		Simulator::Schedule(Seconds(flow_input.start_time) - Simulator::Now(), ScheduleFlowInputs);
	}

	topof.close();
	tracef.close();

	// schedule link down
	if (link_down_time > 0)
	{
		Simulator::Schedule(Seconds(2) + MicroSeconds(link_down_time), &TakeDownLink, n, n.Get(link_down_A), n.Get(link_down_B));
	}

	// schedule buffer monitor
	FILE *qlen_output = fopen(qlen_mon_file.c_str(), "w");
	Simulator::Schedule(NanoSeconds(qlen_mon_start), &monitor_buffer, qlen_output, &n);

	m_initialized = true;
	if (!runSimulator)
	{
		return 0;
	}

	//
	// Now, do the actual simulation.
	//
	std::cout << "Running Simulation.\n";
	fflush(stdout);
	NS_LOG_INFO("Run Simulation.");
	Simulator::Stop(Seconds(simulator_stop_time));
	Simulator::Run();
	RdmaHw::DumpFlowRxTrace(std::cout);
    for (std::set<uint32_t>::iterator it = ocs_node_ids.begin();
		it != ocs_node_ids.end();
		++it) {

		Ptr<OcsNode> ocs = DynamicCast<OcsNode>(n.Get(*it));

		if (ocs != 0) {
			ocs->DumpStats();
		}
	}
	Simulator::Destroy();
	m_initialized = false;
	flowCompletionCallbacks.clear();
	NS_LOG_INFO("Done.");
	fclose(trace_output);

	endt = clock();
	std::cout << (double)(endt - begint) / CLOCKS_PER_SEC << "\n";
	return 0;
}

} // namespace ns3
