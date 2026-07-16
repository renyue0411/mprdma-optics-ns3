/* -*- Mode:C++; c-file-style:"gnu"; indent-tabs-mode:nil; -*- */

#include <iostream>
#include <string>

#include "ns3/ocs-rdma-simulation.h"

int
main(int argc, char *argv[])
{
  if (argc < 2)
  {
    std::cerr << "Error: require a config file" << std::endl;
    return 1;
  }

  const std::string traceSuffix = argc > 2 ? argv[2] : std::string();

  ns3::OcsRdmaSimulation simulation;
  return simulation.RunStaticExperiment(argv[1], traceSuffix);
}
