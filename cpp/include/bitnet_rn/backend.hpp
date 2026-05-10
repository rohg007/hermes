#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>

#include "bitnet_rn/runtime.hpp"

namespace bitnetrn {

struct ModelLoadOptions {
  std::string id;
  std::string path;
  RuntimeKind requestedRuntime = RuntimeKind::Cpu;
  RuntimeKind runtime = RuntimeKind::Cpu;
  std::int32_t contextSize = 2048;
  std::int32_t threads = 0;
  bool keepInMemory = true;
  std::string tokenizerPreOverride;
};

struct GenerationParams {
  std::string prompt;
  std::string systemPrompt;
  std::string chatTemplate;
  double temperature = 0.8;
  std::int32_t topK = 40;
  double topP = 0.95;
  std::int32_t maxTokens = 512;
  std::int32_t seed = -1;
  double repeatPenalty = 1.1;
  bool useChatTemplate = false;
};

using TokenCallback = std::function<bool(const std::string & token)>;

class IBitNetBackend {
 public:
  virtual ~IBitNetBackend() = default;

  virtual void load(const ModelLoadOptions & options) = 0;
  virtual void unload() noexcept = 0;
  virtual void cancel() noexcept = 0;
  virtual std::int32_t generate(const GenerationParams & params,
                                const std::atomic_bool & cancelled,
                                const TokenCallback & onToken) = 0;
};

std::int32_t resolveInferenceThreadCount(std::int32_t requested);
std::unique_ptr<IBitNetBackend> createBackend(RuntimeKind runtime);
bool isSafeGpuFallbackError(const std::exception & error) noexcept;

}  // namespace bitnetrn
