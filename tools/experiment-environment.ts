import { arch, availableParallelism, cpus, platform, release } from "node:os";

export interface ExperimentEnvironment {
  nodeVersion: string;
  platform: string;
  operatingSystemRelease: string;
  architecture: string;
  availableParallelism: number;
  cpuModel: string;
}

export function captureExperimentEnvironment(): ExperimentEnvironment {
  return {
    nodeVersion: process.version,
    platform: platform(),
    operatingSystemRelease: release(),
    architecture: arch(),
    availableParallelism: availableParallelism(),
    cpuModel: cpus()[0]?.model.trim() || "unknown",
  };
}
