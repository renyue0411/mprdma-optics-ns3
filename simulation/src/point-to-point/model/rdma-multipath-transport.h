/* -*- Mode:C++; c-file-style:"gnu"; indent-tabs-mode:nil; -*- */
#ifndef RDMA_MULTIPATH_TRANSPORT_H
#define RDMA_MULTIPATH_TRANSPORT_H

#include <stdint.h>
#include <map>
#include <string>
#include <vector>
#include <ostream>

#include "ns3/assert.h"

namespace ns3 {

/**
 * A lightweight MPQUIC-like management layer for RDMA multipath / multiplane
 * experiments.
 *
 * v1 scope:
 *   - Parse logical topology/flow endpoint tokens.
 *   - Register logicalNode -> RNICGroup -> plane endpoints.
 *   - Map each endpoint to one ns-3 carrier RNIC node.
 *   - Resolve a logical flow to one concrete RDMA path.
 *
 * Future scope, intentionally left as reserved structures below:
 *   - NCCL/ASTRA path constraints.
 *   - Per-path congestion/admission state.
 *   - Split one logical transfer into multiple per-path RDMA subflows.
 *   - Completion aggregation across subflows.
 *   - Real RDMA backend mapping to device/port/GID/QP context.
 */
class RdmaMultipathTransport
{
public:
  struct EndpointKey
  {
    uint32_t logicalNodeId;
    uint32_t rnicGroupId;
    uint32_t planeId;

    EndpointKey ();
    EndpointKey (uint32_t logicalNode, uint32_t rnicGroup, uint32_t plane);

    bool operator < (const EndpointKey& other) const;
    bool operator == (const EndpointKey& other) const;
    std::string ToString () const;
  };

  struct PlaneEndpoint
  {
    EndpointKey key;
    uint32_t carrierRnicNodeId;
    bool explicitEndpoint;
    bool enabled;
    std::string token;

    PlaneEndpoint ();
  };

  struct EndpointSelector
  {
    uint32_t logicalNodeId;
    bool hasRnicGroup;
    uint32_t rnicGroupId;
    bool hasPlane;
    uint32_t planeId;
    std::string token;

    EndpointSelector ();
  };

  struct RdmaPath
  {
    // MPQUIC-like path abstraction.  A path is an endpoint pair, not a single
    // plane. v1 uses it only for single-path scheduling.
    uint32_t pathId;
    PlaneEndpoint src;
    PlaneEndpoint dst;
    bool reachable;
    uint64_t routeCost;
    bool enabled;

    RdmaPath ();
  };

  struct ScheduledFlow
  {
    PlaneEndpoint src;
    PlaneEndpoint dst;
    uint32_t srcCarrierNodeId;
    uint32_t dstCarrierNodeId;
    uint64_t routeCost;
    bool valid;

    ScheduledFlow ();
  };

  struct PathConstraint
  {
    // Reserved for future NCCL / ASTRA-sim integration.
    // A higher layer may constrain a transfer to a given RNICGroup, plane, or
    // exact endpoint. v1 parses constraints through flow tokens but does not
    // expose a separate API yet.
    bool hasRnicGroup;
    uint32_t rnicGroupId;
    bool hasPlane;
    uint32_t planeId;
    bool allowFallback;

    PathConstraint ();
  };

  struct PathState
  {
    // Reserved for future path-level congestion/admission control.
    uint32_t pathId;
    uint64_t safeRateBps;
    uint64_t outstandingBytes;
    uint64_t inflightBytes;
    uint64_t rttNs;
    bool congested;
    bool recovering;
    bool ocsWindowAvailable;

    PathState ();
  };

  struct LogicalTransfer
  {
    // Reserved for future MPQUIC-like transfer split and completion aggregation.
    uint64_t transferId;
    uint32_t srcLogicalNode;
    uint32_t dstLogicalNode;
    uint64_t totalBytes;
    uint64_t completedBytes;
    std::vector<uint64_t> subflowIds;

    LogicalTransfer ();
  };

  RdmaMultipathTransport ();

  static bool IsUnsignedIntegerToken (const std::string& token);
  static bool IsExplicitEndpointToken (const std::string& token);
  static bool IsFlowGroupSelectorToken (const std::string& token);

  EndpointKey ParseTopologyEndpointToken (const std::string& token) const;
  EndpointSelector ParseFlowSelectorToken (const std::string& token) const;

  void RegisterTopologyEndpoint (const std::string& token,
                                 uint32_t carrierRnicNodeId,
                                 bool explicitEndpoint);

  bool HasEndpointToken (const std::string& token) const;
  uint32_t GetCarrierNodeForToken (const std::string& token) const;

  std::vector<PlaneEndpoint> GetEndpoints (uint32_t logicalNodeId) const;

  void ClearRouteCosts ();
  void AddRouteCost (uint32_t srcCarrierNodeId,
                     uint32_t dstCarrierNodeId,
                     uint64_t routeCost);

  ScheduledFlow ScheduleFlow (const std::string& srcToken,
                              const std::string& dstToken) const;

  void DumpEndpoints (std::ostream& os) const;

private:
  PlaneEndpoint SelectSourceEndpoint (const EndpointSelector& selector) const;
  PlaneEndpoint ResolveDestinationEndpoint (const PlaneEndpoint& selectedSrc,
                                            const EndpointSelector& selector,
                                            uint64_t* routeCost) const;
  bool LookupRouteCost (uint32_t srcCarrierNodeId,
                        uint32_t dstCarrierNodeId,
                        uint64_t* routeCost) const;

  static uint64_t MakeNodePairKey (uint32_t src, uint32_t dst);
  static std::vector<std::string> Split (const std::string& token, char delim);
  static uint32_t ParseUint32Strict (const std::string& token,
                                     const std::string& context);
  static std::string EndpointTokenFromKey (const EndpointKey& key,
                                           bool explicitEndpoint);

private:
  std::map<std::string, PlaneEndpoint> m_endpointByToken;
  std::map<uint32_t, std::vector<PlaneEndpoint> > m_endpointsByLogicalNode;
  std::map<uint32_t, bool> m_logicalHasBare;
  std::map<uint32_t, bool> m_logicalHasExplicit;
  std::map<uint64_t, uint64_t> m_routeCost;
};

} // namespace ns3

#endif // RDMA_MULTIPATH_TRANSPORT_H
