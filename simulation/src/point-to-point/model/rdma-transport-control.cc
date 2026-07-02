/* -*- Mode:C++; c-file-style:"gnu"; indent-tabs-mode:nil; -*- */

#include "ns3/rdma-transport-control.h"
#include "ns3/simulator.h"
#include "ns3/assert.h"

namespace ns3 {

int
RdmaTransportControl::GetNextQindex(Ptr<RdmaQueuePairGroup> qpGrp,
                                    Ptr<DropTailQueue> ackQ,
                                    const bool paused[],
                                    uint32_t ackQIdx,
                                    uint32_t rrLast,
                                    RdmaTransportControl::QpGateAllowCallback gateAllowCb,
                                    RdmaTransportControl::QpGateNextTimeCallback gateNextTimeCb,
                                    Time *nextGateWake)
{
  if (!paused[ackQIdx] && ackQ->GetNPackets() > 0)
    {
      return -1;
    }

  // No packet in the highest priority queue.
  // Do round-robin across RDMA QPs.
  int res = -1024;
  uint32_t fcount = qpGrp->GetN();
  uint32_t minFinishId = 0xffffffff;

  for (uint32_t qIndex = 1; qIndex <= fcount; qIndex++)
    {
      uint32_t idx = (qIndex + rrLast) % fcount;
      Ptr<RdmaQueuePair> qp = qpGrp->Get(idx);

      if (!paused[qp->m_pg] &&
          qp->GetBytesLeft() > 0 &&
          !qp->IsWinBound())
        {
          if (qp->m_nextAvail.GetTimeStep() >
              Simulator::Now().GetTimeStep())
            {
              continue;
            }

          if (!gateAllowCb.IsNull () && !gateAllowCb (qp))
            {
              if (!gateNextTimeCb.IsNull () && nextGateWake != 0)
                {
                  Time t = gateNextTimeCb (qp);
                  if (t > Simulator::Now () && t < *nextGateWake)
                    {
                      *nextGateWake = t;
                    }
                }
              continue;
            }

          res = idx;
          break;
        }
      else if (qp->IsFinished())
        {
          minFinishId = idx < minFinishId ? idx : minFinishId;
        }
    }

  // Clear finished QPs.
  // This preserves the original behavior in qbb-net-device.cc.
  if (minFinishId < 0xffffffff)
    {
      int nxt = minFinishId;
      auto &qps = qpGrp->m_qps;

      for (int i = minFinishId + 1; i < static_cast<int>(fcount); i++)
        {
          if (!qps[i]->IsFinished())
            {
              if (i == res)
                {
                  res = nxt;
                }

              qps[nxt] = qps[i];
              nxt++;
            }
        }

      qps.resize(nxt);
    }

  return res;
  
}

} // namespace ns3