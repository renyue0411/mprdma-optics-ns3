/* -*- Mode:C++; c-file-style:"gnu"; indent-tabs-mode:nil; -*- */

#ifndef RDMA_TRANSPORT_CONTROL_H
#define RDMA_TRANSPORT_CONTROL_H

#include "ns3/ptr.h"
#include "ns3/drop-tail-queue.h"
#include "ns3/rdma-queue-pair.h"
#include "ns3/nstime.h"
#include "ns3/callback.h"

namespace ns3 {

class RdmaTransportControl
{
public:
  typedef Callback<bool, Ptr<RdmaQueuePair> > QpGateAllowCallback;
  typedef Callback<Time, Ptr<RdmaQueuePair> > QpGateNextTimeCallback;
  /*
   * Return value follows RdmaEgressQueue convention:
   *   -1    : ACK / high-priority control queue
   *   >= 0  : selected RDMA QP index
   *   -1024 : no eligible QP or control packet
   */
  static int GetNextQindex(Ptr<RdmaQueuePairGroup> qpGrp,
                           Ptr<DropTailQueue> ackQ,
                           const bool paused[],
                           uint32_t ackQIdx,
                           uint32_t rrLast,
                           QpGateAllowCallback gateAllowCb,
                           QpGateNextTimeCallback gateNextTimeCb,
                           Time *nextGateWake);
};

} // namespace ns3

#endif /* RDMA_TRANSPORT_CONTROL_H */