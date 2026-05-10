#pragma once

#include <atomic>
#include <chrono>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "bitnet_rn/backend.hpp"
#include "bitnet_rn/runtime.hpp"

namespace bitnetrn {

struct InferenceMetrics {
  std::string modelId;
  RuntimeKind runtimeUsed = RuntimeKind::Cpu;
  // -1 means unavailable. JSON serialization omits unavailable prompt-token
  // counts so JS does not see a misleading sentinel value.
  std::int32_t promptTokens = -1;
  std::int32_t generatedTokens = 0;
  double tokensPerSecond = 0.0;
  double latencyMs = 0.0;
  double firstTokenLatencyMs = 0.0;
  std::uint64_t memoryUsageBytes = 0;
  std::int32_t threadCount = 1;
};

using MetricsCallback = std::function<void(const InferenceMetrics & metrics)>;
using WarningCallback = std::function<void(const std::string & warning)>;

class BitNetEngine {
 public:
  BitNetEngine();
  ~BitNetEngine();

  BitNetEngine(const BitNetEngine &) = delete;
  BitNetEngine & operator=(const BitNetEngine &) = delete;

  void loadModel(const ModelLoadOptions & options);
  void unloadModel() noexcept;

  void generateTokens(const GenerationParams & params,
                      const TokenCallback & onToken,
                      const MetricsCallback & onMetrics,
                      const WarningCallback & onWarning);

  void cancelInference() noexcept;

  RuntimeKind runtimeUsed() const noexcept;
  std::string modelId() const;
  std::vector<std::string> warnings() const;
  bool isBusy() const noexcept;

 private:
  mutable std::mutex mutex_;
  // Generation keeps a stable backend reference while runtime fallback may swap
  // backend_. This avoids raw-pointer lifetime races around GPU-to-CPU retry.
  std::shared_ptr<IBitNetBackend> backend_;
  ModelLoadOptions loadOptions_;
  std::vector<std::string> warnings_;
  RuntimeKind runtimeUsed_ = RuntimeKind::Cpu;
  std::atomic_bool cancelled_{false};
  std::atomic_bool busy_{false};
  bool loaded_ = false;
};

}  // namespace bitnetrn
