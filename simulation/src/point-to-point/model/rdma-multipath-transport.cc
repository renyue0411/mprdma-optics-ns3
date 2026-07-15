/* -*- Mode:C++; c-file-style:"gnu"; indent-tabs-mode:nil; -*- */

#include "rdma-multipath-transport.h"

#include <cstdlib>
#include <sstream>
#include <iostream>
#include <algorithm>

namespace ns3 {

RdmaMultipathTransport::EndpointKey::EndpointKey ()
  : logicalNodeId (0), rnicGroupId (0), planeId (0)
{
}

RdmaMultipathTransport::EndpointKey::EndpointKey (uint32_t logicalNode,
                                                  uint32_t rnicGroup,
                                                  uint32_t plane)
  : logicalNodeId (logicalNode), rnicGroupId (rnicGroup), planeId (plane)
{
}

bool
RdmaMultipathTransport::EndpointKey::operator < (const EndpointKey& other) const
{
  if (logicalNodeId != other.logicalNodeId)
    {
      return logicalNodeId < other.logicalNodeId;
    }
  if (rnicGroupId != other.rnicGroupId)
    {
      return rnicGroupId < other.rnicGroupId;
    }
  return planeId < other.planeId;
}

bool
RdmaMultipathTransport::EndpointKey::operator == (const EndpointKey& other) const
{
  return logicalNodeId == other.logicalNodeId &&
         rnicGroupId == other.rnicGroupId &&
         planeId == other.planeId;
}

std::string
RdmaMultipathTransport::EndpointKey::ToString () const
{
  std::ostringstream oss;
  oss << logicalNodeId << "-" << rnicGroupId << "-" << planeId;
  return oss.str ();
}

RdmaMultipathTransport::PlaneEndpoint::PlaneEndpoint ()
  : carrierRnicNodeId (0), explicitEndpoint (false), enabled (true)
{
}

RdmaMultipathTransport::EndpointSelector::EndpointSelector ()
  : logicalNodeId (0), hasRnicGroup (false), rnicGroupId (0),
    hasPlane (false), planeId (0)
{
}

RdmaMultipathTransport::RdmaPath::RdmaPath ()
  : pathId (0), reachable (false), routeCost (0), enabled (true)
{
}

RdmaMultipathTransport::ScheduledFlow::ScheduledFlow ()
  : srcCarrierNodeId (0), dstCarrierNodeId (0), routeCost (0), valid (false)
{
}

RdmaMultipathTransport::PathConstraint::PathConstraint ()
  : hasRnicGroup (false), rnicGroupId (0), hasPlane (false), planeId (0),
    allowFallback (false)
{
}

RdmaMultipathTransport::PathState::PathState ()
  : pathId (0), safeRateBps (0), outstandingBytes (0), inflightBytes (0),
    rttNs (0), congested (false), recovering (false), ocsWindowAvailable (true)
{
}

RdmaMultipathTransport::LogicalTransfer::LogicalTransfer ()
  : transferId (0), srcLogicalNode (0), dstLogicalNode (0),
    totalBytes (0), completedBytes (0)
{
}

RdmaMultipathTransport::RdmaMultipathTransport ()
{
}

std::vector<std::string>
RdmaMultipathTransport::Split (const std::string& token, char delim)
{
  std::vector<std::string> out;
  std::stringstream ss (token);
  std::string item;
  while (std::getline (ss, item, delim))
    {
      out.push_back (item);
    }
  return out;
}

bool
RdmaMultipathTransport::IsUnsignedIntegerToken (const std::string& token)
{
  if (token.empty ())
    {
      return false;
    }
  for (size_t i = 0; i < token.size (); ++i)
    {
      if (token[i] < '0' || token[i] > '9')
        {
          return false;
        }
    }
  return true;
}

bool
RdmaMultipathTransport::IsExplicitEndpointToken (const std::string& token)
{
  std::vector<std::string> fields = Split (token, '-');
  return fields.size () == 3 && IsUnsignedIntegerToken (fields[0]) &&
         IsUnsignedIntegerToken (fields[1]) && IsUnsignedIntegerToken (fields[2]);
}

bool
RdmaMultipathTransport::IsFlowGroupSelectorToken (const std::string& token)
{
  std::vector<std::string> fields = Split (token, '-');
  return fields.size () == 2 && IsUnsignedIntegerToken (fields[0]) &&
         IsUnsignedIntegerToken (fields[1]);
}

uint32_t
RdmaMultipathTransport::ParseUint32Strict (const std::string& token,
                                           const std::string& context)
{
  char *end = 0;
  unsigned long value = std::strtoul (token.c_str (), &end, 10);
  NS_ASSERT_MSG (end != token.c_str () && *end == '\0',
                 "Invalid uint32 token '" << token << "' in " << context);
  NS_ASSERT_MSG (value <= 0xfffffffful,
                 "uint32 token out of range '" << token << "' in " << context);
  return static_cast<uint32_t> (value);
}

RdmaMultipathTransport::EndpointKey
RdmaMultipathTransport::ParseTopologyEndpointToken (const std::string& token) const
{
  if (IsUnsignedIntegerToken (token))
    {
      uint32_t logical = ParseUint32Strict (token, "topology endpoint token");
      return EndpointKey (logical, 0, 0);
    }

  NS_ASSERT_MSG (IsExplicitEndpointToken (token),
                 "Invalid topology endpoint token '" << token
                 << "'. Expected N or N-R-P.");

  std::vector<std::string> fields = Split (token, '-');
  return EndpointKey (ParseUint32Strict (fields[0], token),
                      ParseUint32Strict (fields[1], token),
                      ParseUint32Strict (fields[2], token));
}

RdmaMultipathTransport::EndpointSelector
RdmaMultipathTransport::ParseFlowSelectorToken (const std::string& token) const
{
  EndpointSelector s;
  s.token = token;

  if (IsUnsignedIntegerToken (token))
    {
      s.logicalNodeId = ParseUint32Strict (token, "flow selector token");
      return s;
    }

  if (IsFlowGroupSelectorToken (token))
    {
      std::vector<std::string> fields = Split (token, '-');
      s.logicalNodeId = ParseUint32Strict (fields[0], token);
      s.hasRnicGroup = true;
      s.rnicGroupId = ParseUint32Strict (fields[1], token);
      return s;
    }

  NS_ASSERT_MSG (IsExplicitEndpointToken (token),
                 "Invalid flow selector token '" << token
                 << "'. Expected N, N-R, or N-R-P.");

  std::vector<std::string> fields = Split (token, '-');
  s.logicalNodeId = ParseUint32Strict (fields[0], token);
  s.hasRnicGroup = true;
  s.rnicGroupId = ParseUint32Strict (fields[1], token);
  s.hasPlane = true;
  s.planeId = ParseUint32Strict (fields[2], token);
  return s;
}

std::string
RdmaMultipathTransport::EndpointTokenFromKey (const EndpointKey& key,
                                              bool explicitEndpoint)
{
  if (!explicitEndpoint && key.rnicGroupId == 0 && key.planeId == 0)
    {
      std::ostringstream oss;
      oss << key.logicalNodeId;
      return oss.str ();
    }
  return key.ToString ();
}

void
RdmaMultipathTransport::RegisterTopologyEndpoint (const std::string& token,
                                                  uint32_t carrierRnicNodeId,
                                                  bool explicitEndpoint)
{
  EndpointKey key = ParseTopologyEndpointToken (token);
  NS_ASSERT_MSG (explicitEndpoint == IsExplicitEndpointToken (token),
                 "Endpoint explicit flag mismatch for token " << token);

  if (m_endpointByToken.find (token) != m_endpointByToken.end ())
    {
      NS_ASSERT_MSG (m_endpointByToken[token].carrierRnicNodeId == carrierRnicNodeId,
                     "Endpoint token " << token << " mapped to different carrier nodes");
      return;
    }

  bool hasBare = m_logicalHasBare[key.logicalNodeId];
  bool hasExplicit = m_logicalHasExplicit[key.logicalNodeId];
  NS_ASSERT_MSG (!(explicitEndpoint && hasBare),
                 "logicalNode " << key.logicalNodeId
                 << " mixes bare endpoint and explicit N-R-P endpoints");
  NS_ASSERT_MSG (!(!explicitEndpoint && hasExplicit),
                 "logicalNode " << key.logicalNodeId
                 << " mixes explicit N-R-P endpoints and bare endpoint");

  PlaneEndpoint ep;
  ep.key = key;
  ep.carrierRnicNodeId = carrierRnicNodeId;
  ep.explicitEndpoint = explicitEndpoint;
  ep.enabled = true;
  ep.token = token;

  m_endpointByToken[token] = ep;
  m_endpointsByLogicalNode[key.logicalNodeId].push_back (ep);
  if (explicitEndpoint)
    {
      m_logicalHasExplicit[key.logicalNodeId] = true;
    }
  else
    {
      m_logicalHasBare[key.logicalNodeId] = true;
    }

  std::cout << "[MPATH ENDPOINT]"
            << " token=" << token
            << " logical=" << key.logicalNodeId
            << " rnicGroup=" << key.rnicGroupId
            << " plane=" << key.planeId
            << " carrier=" << carrierRnicNodeId
            << " explicit=" << (explicitEndpoint ? 1 : 0)
            << std::endl;
}

bool
RdmaMultipathTransport::HasEndpointToken (const std::string& token) const
{
  return m_endpointByToken.find (token) != m_endpointByToken.end ();
}

uint32_t
RdmaMultipathTransport::GetCarrierNodeForToken (const std::string& token) const
{
  std::map<std::string, PlaneEndpoint>::const_iterator it = m_endpointByToken.find (token);
  NS_ASSERT_MSG (it != m_endpointByToken.end (),
                 "Unknown endpoint token " << token);
  return it->second.carrierRnicNodeId;
}

std::vector<RdmaMultipathTransport::PlaneEndpoint>
RdmaMultipathTransport::GetEndpoints (uint32_t logicalNodeId) const
{
  std::map<uint32_t, std::vector<PlaneEndpoint> >::const_iterator it =
    m_endpointsByLogicalNode.find (logicalNodeId);
  if (it == m_endpointsByLogicalNode.end ())
    {
      return std::vector<PlaneEndpoint> ();
    }
  return it->second;
}

uint64_t
RdmaMultipathTransport::MakeNodePairKey (uint32_t src, uint32_t dst)
{
  return (static_cast<uint64_t> (src) << 32) | dst;
}

void
RdmaMultipathTransport::ClearRouteCosts ()
{
  m_routeCost.clear ();
}

void
RdmaMultipathTransport::AddRouteCost (uint32_t srcCarrierNodeId,
                                      uint32_t dstCarrierNodeId,
                                      uint64_t routeCost)
{
  m_routeCost[MakeNodePairKey (srcCarrierNodeId, dstCarrierNodeId)] = routeCost;
}

bool
RdmaMultipathTransport::LookupRouteCost (uint32_t srcCarrierNodeId,
                                         uint32_t dstCarrierNodeId,
                                         uint64_t* routeCost) const
{
  std::map<uint64_t, uint64_t>::const_iterator it =
    m_routeCost.find (MakeNodePairKey (srcCarrierNodeId, dstCarrierNodeId));
  if (it == m_routeCost.end ())
    {
      return false;
    }
  if (routeCost != 0)
    {
      *routeCost = it->second;
    }
  return true;
}

RdmaMultipathTransport::PlaneEndpoint
RdmaMultipathTransport::SelectSourceEndpoint (const EndpointSelector& selector) const
{
  std::vector<PlaneEndpoint> eps = GetEndpoints (selector.logicalNodeId);
  NS_ASSERT_MSG (!eps.empty (),
                 "No source endpoints for logicalNode " << selector.logicalNodeId
                 << " token=" << selector.token);

  std::vector<PlaneEndpoint> candidates;
  for (size_t i = 0; i < eps.size (); ++i)
    {
      const PlaneEndpoint& ep = eps[i];
      if (!ep.enabled)
        {
          continue;
        }
      if (selector.hasRnicGroup && ep.key.rnicGroupId != selector.rnicGroupId)
        {
          continue;
        }
      if (selector.hasPlane && ep.key.planeId != selector.planeId)
        {
          continue;
        }
      candidates.push_back (ep);
    }

  NS_ASSERT_MSG (!candidates.empty (),
                 "No source endpoint matches selector " << selector.token);

  std::sort (candidates.begin (), candidates.end (),
             [] (const PlaneEndpoint& a, const PlaneEndpoint& b) {
               if (a.key.rnicGroupId != b.key.rnicGroupId)
                 {
                   return a.key.rnicGroupId < b.key.rnicGroupId;
                 }
               if (a.key.planeId != b.key.planeId)
                 {
                   return a.key.planeId < b.key.planeId;
                 }
               return a.carrierRnicNodeId < b.carrierRnicNodeId;
             });
  return candidates[0];
}

RdmaMultipathTransport::PlaneEndpoint
RdmaMultipathTransport::ResolveDestinationEndpoint (const PlaneEndpoint& selectedSrc,
                                                    const EndpointSelector& selector,
                                                    uint64_t* routeCost) const
{
  std::vector<PlaneEndpoint> eps = GetEndpoints (selector.logicalNodeId);
  NS_ASSERT_MSG (!eps.empty (),
                 "No destination endpoints for logicalNode " << selector.logicalNodeId
                 << " token=" << selector.token);

  bool found = false;
  PlaneEndpoint best;
  uint64_t bestCost = 0;

  for (size_t i = 0; i < eps.size (); ++i)
    {
      const PlaneEndpoint& ep = eps[i];
      if (!ep.enabled)
        {
          continue;
        }
      if (selector.hasRnicGroup && ep.key.rnicGroupId != selector.rnicGroupId)
        {
          continue;
        }
      if (selector.hasPlane && ep.key.planeId != selector.planeId)
        {
          continue;
        }

      uint64_t cost = 0;
      if (!LookupRouteCost (selectedSrc.carrierRnicNodeId,
                            ep.carrierRnicNodeId,
                            &cost))
        {
          std::cout << "[MPATH SKIP]"
                    << " src=" << selectedSrc.token
                    << " dst=" << ep.token
                    << " reason=not-reachable"
                    << std::endl;
          continue;
        }

      bool better = false;
      if (!found || cost < bestCost)
        {
          better = true;
        }
      else if (cost == bestCost)
        {
          if (ep.key.rnicGroupId != best.key.rnicGroupId)
            {
              better = ep.key.rnicGroupId < best.key.rnicGroupId;
            }
          else if (ep.key.planeId != best.key.planeId)
            {
              better = ep.key.planeId < best.key.planeId;
            }
          else
            {
              better = ep.carrierRnicNodeId < best.carrierRnicNodeId;
            }
        }

      if (better)
        {
          found = true;
          best = ep;
          bestCost = cost;
        }
    }

  NS_ASSERT_MSG (found,
                 "No reachable destination endpoint for selector " << selector.token
                 << " from source endpoint " << selectedSrc.token
                 << " carrier=" << selectedSrc.carrierRnicNodeId);
  if (routeCost != 0)
    {
      *routeCost = bestCost;
    }
  return best;
}

RdmaMultipathTransport::ScheduledFlow
RdmaMultipathTransport::ScheduleFlow (const std::string& srcToken,
                                      const std::string& dstToken) const
{
  EndpointSelector srcSel = ParseFlowSelectorToken (srcToken);
  EndpointSelector dstSel = ParseFlowSelectorToken (dstToken);

  ScheduledFlow out;
  out.src = SelectSourceEndpoint (srcSel);
  out.dst = ResolveDestinationEndpoint (out.src, dstSel, &out.routeCost);
  out.srcCarrierNodeId = out.src.carrierRnicNodeId;
  out.dstCarrierNodeId = out.dst.carrierRnicNodeId;
  out.valid = true;

  std::cout << "[MPATH SCHEDULE]"
            << " srcToken=" << srcToken
            << " dstToken=" << dstToken
            << " selectedSrc=" << out.src.token
            << " selectedDst=" << out.dst.token
            << " srcCarrier=" << out.srcCarrierNodeId
            << " dstCarrier=" << out.dstCarrierNodeId
            << " routeCost=" << out.routeCost
            << std::endl;

  return out;
}

void
RdmaMultipathTransport::DumpEndpoints (std::ostream& os) const
{
  for (std::map<std::string, PlaneEndpoint>::const_iterator it = m_endpointByToken.begin ();
       it != m_endpointByToken.end (); ++it)
    {
      const PlaneEndpoint& ep = it->second;
      os << "[MPATH ENDPOINT DUMP]"
         << " token=" << ep.token
         << " logical=" << ep.key.logicalNodeId
         << " rnicGroup=" << ep.key.rnicGroupId
         << " plane=" << ep.key.planeId
         << " carrier=" << ep.carrierRnicNodeId
         << " explicit=" << (ep.explicitEndpoint ? 1 : 0)
         << " enabled=" << (ep.enabled ? 1 : 0)
         << std::endl;
    }
}

} // namespace ns3
