#include "bitnet_rn/bitnet_engine.hpp"

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <iostream>

#include "bitnet_rn/errors.hpp"
#include "bitnet_rn/model_compatibility.hpp"
#include "bitnet_rn/platform_metrics.hpp"

namespace bitnetrn {

namespace {

bool canFallbackFromGpuLoad(const BitNetException & error) {
  return error.code() == ErrorCode::RuntimeUnavailable ||
      error.code() == ErrorCode::NativeBackendUnavailable ||
      error.code() == ErrorCode::ModelIncompatible ||
      error.code() == ErrorCode::Internal ||
      isSafeGpuFallbackError(error);
}

std::string fallbackWarning(const std::string & phase, const std::exception & error) {
  return "GPU " + phase + " failed; falling back to CPU. Reason: " + error.what();
}

void logRuntimeWarning(const std::string & message) {
  std::clog << "[BitNet] " << message << std::endl;
}

}  // namespace

const char * errorCodeName(ErrorCode code) noexcept {
  switch (code) {
    case ErrorCode::InvalidArgument:
      return "BITNET_INVALID_ARGUMENT";
    case ErrorCode::ModelNotFound:
      return "BITNET_MODEL_NOT_FOUND";
    case ErrorCode::ModelIncompatible:
      return "BITNET_MODEL_INCOMPATIBLE";
    case ErrorCode::RuntimeUnavailable:
      return "BITNET_RUNTIME_UNAVAILABLE";
    case ErrorCode::InferenceBusy:
      return "BITNET_INFERENCE_BUSY";
    case ErrorCode::InferenceCancelled:
      return "BITNET_INFERENCE_CANCELLED";
    case ErrorCode::NativeBackendUnavailable:
      return "BITNET_NATIVE_UNAVAILABLE";
    case ErrorCode::Internal:
      return "BITNET_RUNTIME_ERROR";
  }
  return "BITNET_UNKNOWN";
}

BitNetEngine::BitNetEngine() = default;

BitNetEngine::~BitNetEngine() {
  unloadModel();
}

void BitNetEngine::loadModel(const ModelLoadOptions & options) {
  if (options.path.empty()) {
    throw BitNetException(ErrorCode::InvalidArgument, "BITNET_INVALID_ARGUMENT: model path is required");
  }

  if (!std::filesystem::exists(options.path)) {
    throw BitNetException(ErrorCode::ModelNotFound, "BITNET_MODEL_NOT_FOUND: " + options.path);
  }

  auto capabilities = detectRuntimeCapabilities();
  auto selection = selectRuntime(options.runtime, capabilities);

  std::unique_lock<std::mutex> lock(mutex_);
  if (busy_.load()) {
    throw BitNetException(ErrorCode::InferenceBusy, "BITNET_INFERENCE_BUSY: cannot reload while inference is active");
  }
  warnings_.clear();
  if (options.runtime == RuntimeKind::Auto && selection.selected == RuntimeKind::Cpu && !capabilities.gpu.available &&
      !capabilities.gpu.reason.empty()) {
    warnings_.push_back("AUTO selected CPU because GPU is unavailable. Reason: " + capabilities.gpu.reason);
  }
  logRuntimeWarning("runtime selected for load: " + runtimeKindToString(selection.selected) + " (" + selection.reason + ")");

  ModelLoadOptions normalized = options;
  normalized.requestedRuntime = options.runtime;
  normalized.runtime = selection.selected;
  normalized.threads = resolveInferenceThreadCount(options.threads);

  auto loadWithRuntime = [&](RuntimeKind runtime) {
    auto compatibility = requireBitNetCompatibleModel(options.path);
    if (!compatibility.tokenizerPreOverride.empty()) {
      warnings_.push_back(
          "Model GGUF is missing tokenizer.ggml.pre; applying native tokenizer override tokenizer.ggml.pre=" +
          compatibility.tokenizerPreOverride + ".");
    }
    auto backend = createBackend(runtime);
    ModelLoadOptions runtimeOptions = normalized;
    runtimeOptions.runtime = runtime;
    runtimeOptions.tokenizerPreOverride = compatibility.tokenizerPreOverride;
    backend->load(runtimeOptions);
    return std::make_pair(std::shared_ptr<IBitNetBackend>(std::move(backend)), runtimeOptions);
  };

  std::shared_ptr<IBitNetBackend> backend;
  try {
    auto loaded = loadWithRuntime(selection.selected);
    backend = std::move(loaded.first);
    normalized = loaded.second;
  } catch (const BitNetException & error) {
    if (options.runtime == RuntimeKind::Auto && selection.selected == RuntimeKind::Gpu && canFallbackFromGpuLoad(error)) {
      const auto warning = fallbackWarning("initialization", error);
      warnings_.push_back(warning);
      logRuntimeWarning(warning);
      auto loaded = loadWithRuntime(RuntimeKind::Cpu);
      backend = std::move(loaded.first);
      normalized = loaded.second;
    } else {
      throw;
    }
  }

  backend_ = std::move(backend);
  // Model loading is expensive; keep the model resident until explicit unload
  // so chat turns avoid repeated allocation and GGUF weight paging.
  loadOptions_ = normalized;
  runtimeUsed_ = normalized.runtime;
  loaded_ = true;
  cancelled_.store(false);
}

void BitNetEngine::unloadModel() noexcept {
  cancelInference();
  std::shared_ptr<IBitNetBackend> backend;
  {
    std::unique_lock<std::mutex> lock(mutex_);
    backend = std::move(backend_);
    loaded_ = false;
  }
  if (backend) {
    backend->unload();
  }
}

void BitNetEngine::generateTokens(const GenerationParams & params,
                                  const TokenCallback & onToken,
                                  const MetricsCallback & onMetrics,
                                  const WarningCallback & onWarning) {
  if (params.prompt.empty()) {
    throw BitNetException(ErrorCode::InvalidArgument, "BITNET_INVALID_ARGUMENT: prompt is required");
  }
  if (params.maxTokens <= 0) {
    throw BitNetException(ErrorCode::InvalidArgument, "BITNET_INVALID_ARGUMENT: maxTokens must be greater than zero");
  }

  bool expected = false;
  if (!busy_.compare_exchange_strong(expected, true)) {
    // Concurrent decoding competes for the same memory bandwidth and model
    // weights, and a loaded llama context has a shared KV cache. Keep one active
    // generation per model for predictable latency.
    throw BitNetException(ErrorCode::InferenceBusy, "BITNET_INFERENCE_BUSY: max concurrency is one generation per model");
  }

  std::shared_ptr<void> busyGuard(nullptr, [this](void *) {
    busy_.store(false);
  });

  std::shared_ptr<IBitNetBackend> backend;
  ModelLoadOptions loadOptions;
  RuntimeKind runtimeAtStart = RuntimeKind::Cpu;
  {
    std::unique_lock<std::mutex> lock(mutex_);
    if (!loaded_ || backend_ == nullptr) {
      throw BitNetException(ErrorCode::ModelNotFound, "BITNET_MODEL_NOT_FOUND: model is not loaded");
    }
    backend = backend_;
    loadOptions = loadOptions_;
    runtimeAtStart = runtimeUsed_;
  }

  cancelled_.store(false);
  const auto startedAt = std::chrono::steady_clock::now();
  std::chrono::steady_clock::time_point firstTokenAt;
  std::int32_t generated = 0;
  std::int32_t promptTokenCount = -1;

  auto generateWithBackend = [&](const std::shared_ptr<IBitNetBackend> & selectedBackend) {
    if (!selectedBackend) {
      throw BitNetException(ErrorCode::ModelNotFound, "BITNET_MODEL_NOT_FOUND: model is not loaded");
    }
    return selectedBackend->generate(
        params,
        cancelled_,
        [&](const std::string & token) {
          if (cancelled_.load()) {
            return false;
          }
          if (generated == 0) {
            firstTokenAt = std::chrono::steady_clock::now();
          }
          generated += 1;
          return onToken(token);
        });
  };

  try {
    promptTokenCount = generateWithBackend(backend);
  } catch (const std::exception & error) {
    if (runtimeAtStart == RuntimeKind::Gpu && generated == 0 && isSafeGpuFallbackError(error)) {
      const auto warning = fallbackWarning("runtime", error);
      onWarning(warning);
      logRuntimeWarning(warning);

      std::unique_lock<std::mutex> lock(mutex_);
      if (!loaded_ || backend_ == nullptr) {
        throw;
      }
      backend_->unload();
      auto cpuBackend = createBackend(RuntimeKind::Cpu);
      ModelLoadOptions cpuOptions = loadOptions;
      cpuOptions.runtime = RuntimeKind::Cpu;
      cpuBackend->load(cpuOptions);
      backend_ = std::shared_ptr<IBitNetBackend>(std::move(cpuBackend));
      loadOptions_ = cpuOptions;
      runtimeUsed_ = RuntimeKind::Cpu;
      backend = backend_;
      loadOptions = loadOptions_;
      lock.unlock();

      if (cancelled_.load()) {
        throw BitNetException(ErrorCode::InferenceCancelled, "BITNET_INFERENCE_CANCELLED: generation cancelled");
      }
      promptTokenCount = generateWithBackend(backend);
    } else {
      if (runtimeAtStart == RuntimeKind::Gpu && generated > 0) {
        const auto warning =
            "GPU runtime failed after streaming began. CPU retry was skipped to avoid duplicate tokens. Reason: " +
            std::string(error.what());
        onWarning(warning);
        logRuntimeWarning(warning);
      }
      throw;
    }
  }

  if (cancelled_.load()) {
    throw BitNetException(ErrorCode::InferenceCancelled, "BITNET_INFERENCE_CANCELLED: generation cancelled");
  }

  const auto endedAt = std::chrono::steady_clock::now();
  const double latencyMs = std::chrono::duration<double, std::milli>(endedAt - startedAt).count();
  const double seconds = std::max(0.001, latencyMs / 1000.0);

  InferenceMetrics metrics;
  metrics.modelId = loadOptions.id;
  metrics.runtimeUsed = loadOptions.runtime;
  metrics.promptTokens = promptTokenCount;
  metrics.generatedTokens = generated;
  metrics.tokensPerSecond = static_cast<double>(generated) / seconds;
  metrics.latencyMs = latencyMs;
  metrics.memoryUsageBytes = currentMemoryUsageBytes();
  metrics.threadCount = loadOptions.threads;
  metrics.firstTokenLatencyMs =
      generated > 0 ? std::chrono::duration<double, std::milli>(firstTokenAt - startedAt).count() : 0.0;
  onMetrics(metrics);
}

void BitNetEngine::cancelInference() noexcept {
  cancelled_.store(true);
  std::shared_ptr<IBitNetBackend> backend;
  {
    std::unique_lock<std::mutex> lock(mutex_);
    backend = backend_;
  }
  if (backend) {
    backend->cancel();
  }
}

RuntimeKind BitNetEngine::runtimeUsed() const noexcept {
  return runtimeUsed_;
}

std::string BitNetEngine::modelId() const {
  std::unique_lock<std::mutex> lock(mutex_);
  return loadOptions_.id;
}

std::vector<std::string> BitNetEngine::warnings() const {
  std::unique_lock<std::mutex> lock(mutex_);
  return warnings_;
}

bool BitNetEngine::isBusy() const noexcept {
  return busy_.load();
}

}  // namespace bitnetrn
