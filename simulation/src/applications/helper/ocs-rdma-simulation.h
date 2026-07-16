/* -*- Mode:C++; c-file-style:"gnu"; indent-tabs-mode:nil; -*- */
#ifndef OCS_RDMA_SIMULATION_H
#define OCS_RDMA_SIMULATION_H

#include <string>

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
  OcsRdmaSimulation();

  /**
   * Run the existing file-driven OCS/RDMA experiment without changing its
   * configuration format or runtime behavior.
   *
   * \param configFile path to the existing mix/config_ocs.txt style file
   * \param traceSuffix optional suffix formerly supplied as argv[2]
   * \return zero on success, non-zero on invalid input
   */
  int RunStaticExperiment(const std::string &configFile,
                          const std::string &traceSuffix = std::string());
};

} // namespace ns3

#endif // OCS_RDMA_SIMULATION_H
