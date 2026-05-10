#pragma once

#include <cstdint>
#include <string>

namespace bitnetrn {

enum class RuntimeKind {
  Auto,
  Cpu,
  Gpu
};

struct CpuCapabilities {
  bool available = true;
  std::string arch;
  bool neon = false;
  bool avx2 = false;
  std::int32_t threadCount = 1;
};

struct AcceleratorCapabilities {
  bool available = false;
  bool compiled = false;
  std::string api;
  std::string reason;
};

struct RuntimeCapabilities {
  CpuCapabilities cpu;
  AcceleratorCapabilities gpu;
};

struct RuntimeSelection {
  RuntimeKind requested = RuntimeKind::Cpu;
  RuntimeKind selected = RuntimeKind::Cpu;
  std::string reason;
};

RuntimeCapabilities detectRuntimeCapabilities();
RuntimeSelection selectRuntime(RuntimeKind requested, const RuntimeCapabilities & capabilities);
std::string runtimeKindToString(RuntimeKind runtime);
RuntimeKind runtimeKindFromString(const std::string & value);

}  // namespace bitnetrn
