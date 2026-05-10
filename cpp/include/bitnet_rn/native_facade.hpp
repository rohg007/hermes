#pragma once

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include "bitnet_rn/backend.hpp"
#include "bitnet_rn/bitnet_engine.hpp"
#include "bitnet_rn/runtime.hpp"

namespace bitnetrn {

enum class NativeEventType {
  Token,
  Metrics,
  Warning,
  End,
  Error,
  Cancelled
};

struct NativeTokenEvent {
  NativeEventType type = NativeEventType::Token;
  std::string text;
  std::string error;
  std::string warning;
  InferenceMetrics metrics;
};

struct LoadModelResult {
  std::string handle;
  std::string id;
  std::string path;
  RuntimeKind runtimeUsed = RuntimeKind::Cpu;
  std::vector<std::string> warnings;
};

using NativeEventCallback = std::function<bool(const NativeTokenEvent & event)>;

class NativeFacade {
 public:
  static NativeFacade & shared();

  RuntimeCapabilities capabilities() const;

  LoadModelResult loadModel(const std::string & modelPath, const ModelLoadOptions & options);
  void unloadModel(const std::string & modelHandle);

  std::string startGeneration(const std::string & modelHandle, const GenerationParams & params);
  std::vector<NativeTokenEvent> nextTokenBatch(const std::string & generationHandle,
                                               std::size_t maxTokens,
                                               std::chrono::milliseconds timeout);
  void cancelGeneration(const std::string & generationHandle);
  void generateBlocking(const std::string & modelHandle,
                        const GenerationParams & params,
                        const NativeEventCallback & onEvent);

 private:
  NativeFacade() = default;
  ~NativeFacade();

  struct ModelSession;
  struct GenerationSession;

  std::shared_ptr<ModelSession> getModel(const std::string & handle);
  std::shared_ptr<GenerationSession> getGeneration(const std::string & handle);

  mutable std::mutex mutex_;
  std::uint64_t nextModelId_ = 1;
  std::uint64_t nextGenerationId_ = 1;
  std::unordered_map<std::string, std::shared_ptr<ModelSession>> models_;
  std::unordered_map<std::string, std::shared_ptr<GenerationSession>> generations_;
};

std::string nativeEventsToJson(const std::vector<NativeTokenEvent> & events);
std::string loadModelResultToJson(const LoadModelResult & result);
std::string runtimeCapabilitiesToJson(const RuntimeCapabilities & capabilities);

}  // namespace bitnetrn
