/* -*- Mode:C++; c-file-style:"gnu"; indent-tabs-mode:nil; -*- */
#ifndef OCS_RDMA_SIMULATION_H
#define OCS_RDMA_SIMULATION_H

#include <stdint.h>
#include <string>

#include "ns3/callback.h"

namespace ns3 {

/**
 * Shared orchestration layer for the OCS/RDMA simulation backend.
 *
 * The mechanism implementations remain in their existing model classes
 * (OcsNode, RdmaOcsController, RdmaUserspaceTransport and
 * RdmaMultipathTransport). This class owns the common simulation assembly
 * used by the standalone experiment entry point and, later, the ASTRA-sim
 * adapter.
 */
class OcsRdmaSimulation
{
public:
  /**
   * Completion notification for a dynamically submitted RDMA flow.
   * Arguments are src carrier node, dst carrier node, bytes, tag and source
   * port.  The callback is intentionally ASTRA-independent; the ASTRA adapter
   * can translate this notification into its send/receive callbacks.
   */
  typedef Callback<void, uint32_t, uint32_t, uint64_t, uint32_t, uint16_t>
      FlowCompletionCallback;

  OcsRdmaSimulation();

  /**
   * Build the OCS/RDMA topology and install all existing transport mechanisms
   * without starting Simulator::Run().  This is the entry used by ASTRA-sim.
   */
  bool Initialize(const std::string &configFile,
                  const std::string &traceSuffix = std::string());

  /**
   * Submit one RDMA flow at the current simulation time.  srcToken and
   * dstToken use the same logical endpoint syntax as the existing flow file,
   * so the current multiplane scheduler remains in the data path.
   *
   * \return allocated source port, which uniquely identifies this QP for the
   *         selected source/destination carrier pair
   */
  uint16_t SubmitFlow(
      const std::string &srcToken,
      const std::string &dstToken,
      uint64_t bytes,
      uint32_t tag,
      FlowCompletionCallback completion = FlowCompletionCallback(),
      uint32_t priorityGroup = 3,
      uint32_t destinationPort = 100);

  bool IsInitialized() const;

  /**
   * Run the existing file-driven OCS/RDMA experiment without changing its
   * configuration format or runtime behavior.
   */
  int RunStaticExperiment(const std::string &configFile,
                          const std::string &traceSuffix = std::string());

private:
  int ConfigureAndMaybeRun(const std::string &configFile,
                           const std::string &traceSuffix,
                           bool loadStaticFlows,
                           bool runSimulator);

  bool m_initialized;
};

} // namespace ns3

#endif // OCS_RDMA_SIMULATION_H
