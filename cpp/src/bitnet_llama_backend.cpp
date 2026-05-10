#include "bitnet_rn/backend.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cstdio>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "bitnet_rn/errors.hpp"

#if defined(BITNET_RN_HAS_BITNET)
#include "llama.h"
#endif

namespace bitnetrn {

std::unique_ptr<IBitNetBackend> createTestStubBackend();

namespace {

std::int32_t detectedCpuThreadCount() {
#if defined(__EMSCRIPTEN__)
  return 1;
#else
  const auto detected = std::thread::hardware_concurrency();
  return static_cast<std::int32_t>(detected == 0 ? 2u : detected);
#endif
}

}  // namespace

std::int32_t resolveInferenceThreadCount(std::int32_t requested) {
#if defined(__EMSCRIPTEN__)
  (void) requested;
  // Web inference is limited by single-threaded WASM in the stable path. SIMD
  // helps vector work, but pthreads stay disabled until the ggml threadpool path
  // is stable across browsers.
  return 1;
#else
  const auto detected = detectedCpuThreadCount();
  if (requested > 0) {
    return std::max<std::int32_t>(1, std::min<std::int32_t>(requested, detected));
  }

  // BitNet inference is memory-bound and mobile CPUs use big.LITTLE cores.
  // Using fewer threads avoids memory-bandwidth contention and thermal
  // throttling; apps can still override this after device-specific benchmarks.
  if (detected <= 1) {
    return 1;
  }
  if (detected <= 4) {
    return 2;
  }
  if (detected <= 6) {
    return 3;
  }
  return 4;
#endif
}

namespace {

class UnavailableBackend final : public IBitNetBackend {
 public:
  void load(const ModelLoadOptions &) override {
    throw BitNetException(
        ErrorCode::NativeBackendUnavailable,
        "BITNET_NATIVE_UNAVAILABLE: BitNet.cpp is not linked. Run yarn bitnet:init, then rebuild the app.");
  }

  void unload() noexcept override {}
  void cancel() noexcept override {}

  std::int32_t generate(const GenerationParams &, const std::atomic_bool &, const TokenCallback &) override {
    throw BitNetException(
        ErrorCode::NativeBackendUnavailable,
        "BITNET_NATIVE_UNAVAILABLE: BitNet.cpp is not linked. Run yarn bitnet:init, then rebuild the app.");
    return -1;
  }
};

#if defined(BITNET_RN_HAS_BITNET)

void initLlamaOnce() {
  static std::once_flag flag;
  std::call_once(flag, [] {
    llama_backend_init();
  });
}

std::uint32_t normalizeSeed(std::int32_t seed) {
  return seed < 0 ? 0xFFFFFFFFu : static_cast<std::uint32_t>(seed);
}

void setStringOverride(llama_model_kv_override & override, const char * key, const char * value) {
  override.tag = LLAMA_KV_OVERRIDE_TYPE_STR;
  std::snprintf(override.key, sizeof(override.key), "%s", key);
  std::snprintf(override.val_str, sizeof(override.val_str), "%s", value);
}

std::string applyChatTemplate(const llama_model * model,
                              const std::string & systemPrompt,
                              const std::string & userPrompt,
                              const std::string & customTemplate) {
  std::vector<llama_chat_message> messages;
  messages.reserve(systemPrompt.empty() ? 1 : 2);
  if (!systemPrompt.empty()) {
    messages.push_back({"system", systemPrompt.c_str()});
  }
  messages.push_back({"user", userPrompt.c_str()});

  const char * templatePtr = customTemplate.empty() ? nullptr : customTemplate.c_str();
  bool fallbackToChatMl = false;
  int32_t size = llama_chat_apply_template(
      model,
      templatePtr,
      messages.data(),
      messages.size(),
      true,
      nullptr,
      0);
  if (size < 0) {
    if (templatePtr != nullptr) {
      throw BitNetException(ErrorCode::InvalidArgument, "BITNET_INVALID_ARGUMENT: unsupported chat template");
    }
    fallbackToChatMl = true;
    size = llama_chat_apply_template(
        nullptr,
        "chatml",
        messages.data(),
        messages.size(),
        true,
        nullptr,
        0);
  }
  if (size < 0) {
    throw BitNetException(ErrorCode::Internal, "BITNET_RUNTIME_ERROR: failed to apply chat template");
  }

  std::vector<char> buffer(static_cast<std::size_t>(size) + 1);
  size = llama_chat_apply_template(
      fallbackToChatMl ? nullptr : model,
      fallbackToChatMl ? "chatml" : templatePtr,
      messages.data(),
      messages.size(),
      true,
      buffer.data(),
      static_cast<std::int32_t>(buffer.size()));
  if (size < 0) {
    throw BitNetException(ErrorCode::Internal, "BITNET_RUNTIME_ERROR: failed to apply chat template");
  }
  return std::string(buffer.data(), static_cast<std::size_t>(size));
}

std::string buildPrompt(const llama_model * model, const GenerationParams & params) {
  if (!params.useChatTemplate) {
    return params.prompt;
  }

  return applyChatTemplate(model, params.systemPrompt, params.prompt, params.chatTemplate);
}

class LlamaBitNetBackend : public IBitNetBackend {
 public:
  explicit LlamaBitNetBackend(RuntimeKind runtime) : runtime_(runtime) {}

  ~LlamaBitNetBackend() override {
    unload();
  }

  void load(const ModelLoadOptions & options) override {
    initLlamaOnce();

    if (!std::filesystem::exists(options.path)) {
      throw BitNetException(ErrorCode::ModelNotFound, "BITNET_MODEL_NOT_FOUND: " + options.path);
    }
    if (options.contextSize <= 0) {
      throw BitNetException(ErrorCode::InvalidArgument, "BITNET_INVALID_ARGUMENT: contextSize must be greater than zero");
    }

    std::lock_guard<std::mutex> lock(mutex_);
    unloadLocked();

    llama_model_params modelParams = llama_model_default_params();
    modelParams.n_gpu_layers = runtime_ == RuntimeKind::Gpu ? 999 : 0;
#if defined(__EMSCRIPTEN__)
    // Browser-backed files from WORKERFS cannot be mmap'ed. Force streamed
    // file reads for the web build while leaving mobile/native defaults intact.
    modelParams.use_mmap = false;
#endif
    std::array<llama_model_kv_override, 2> kvOverrides{};
    if (!options.tokenizerPreOverride.empty()) {
      setStringOverride(kvOverrides[0], "tokenizer.ggml.pre", options.tokenizerPreOverride.c_str());
      modelParams.kv_overrides = kvOverrides.data();
    }

    model_ = llama_load_model_from_file(options.path.c_str(), modelParams);
    if (model_ == nullptr) {
      throw BitNetException(
          ErrorCode::Internal,
          runtime_ == RuntimeKind::Gpu
              ? "BITNET_RUNTIME_ERROR: GPU model initialization failed in llama_load_model_from_file"
              : "BITNET_RUNTIME_ERROR: llama_load_model_from_file failed");
    }

    llama_context_params contextParams = llama_context_default_params();
    contextParams.n_ctx = static_cast<std::uint32_t>(options.contextSize);
    contextParams.n_threads = resolveInferenceThreadCount(options.threads);
    contextParams.n_threads_batch = contextParams.n_threads;
    // BitNet.cpp's own runner forces -b 1 for I2_S inference. Keep the mobile
    // baseline conservative and optimize after correctness is established.
    contextParams.n_batch = 1;
    contextParams.n_ubatch = contextParams.n_batch;

    ctx_ = llama_new_context_with_model(model_, contextParams);
    if (ctx_ == nullptr) {
      unloadLocked();
      throw BitNetException(
          ErrorCode::Internal,
          runtime_ == RuntimeKind::Gpu
              ? "BITNET_RUNTIME_ERROR: GPU context initialization failed in llama_new_context_with_model"
              : "BITNET_RUNTIME_ERROR: llama_new_context_with_model failed");
    }
  }

  void unload() noexcept override {
    std::lock_guard<std::mutex> lock(mutex_);
    unloadLocked();
  }

  void cancel() noexcept override {
    cancelled_.store(true);
  }

  std::int32_t generate(const GenerationParams & params,
                        const std::atomic_bool & externalCancelled,
                        const TokenCallback & onToken) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (model_ == nullptr || ctx_ == nullptr) {
      throw BitNetException(ErrorCode::ModelNotFound, "BITNET_MODEL_NOT_FOUND: model is not loaded");
    }

    cancelled_.store(false);
    const std::string prompt = buildPrompt(model_, params);
    std::vector<llama_token> promptTokens = tokenize(prompt);
    if (promptTokens.empty()) {
      throw BitNetException(ErrorCode::InvalidArgument, "BITNET_INVALID_ARGUMENT: prompt produced no tokens");
    }
    if (promptTokens.size() >= static_cast<std::size_t>(llama_n_ctx(ctx_))) {
      throw BitNetException(
          ErrorCode::InvalidArgument,
          "BITNET_INVALID_ARGUMENT: prompt is longer than the configured context window");
    }
    const auto promptTokenCount = static_cast<std::int32_t>(promptTokens.size());

    llama_kv_cache_clear(ctx_);
    llama_sampler * sampler = createSampler(params);
    std::unique_ptr<llama_sampler, decltype(&llama_sampler_free)> samplerGuard(sampler, llama_sampler_free);

    std::int32_t position = 0;
    const std::int32_t promptBatchSize = std::max<std::int32_t>(1, std::min<std::int32_t>(64, llama_n_batch(ctx_)));
    for (std::size_t offset = 0; offset < promptTokens.size(); offset += static_cast<std::size_t>(promptBatchSize)) {
      const auto chunk = static_cast<std::int32_t>(
          std::min<std::size_t>(static_cast<std::size_t>(promptBatchSize), promptTokens.size() - offset));
      llama_batch promptBatch = llama_batch_get_one(promptTokens.data() + offset, chunk, position, 0);
      if (llama_decode(ctx_, promptBatch) != 0) {
        throw BitNetException(ErrorCode::Internal, "BITNET_RUNTIME_ERROR: prompt decode failed");
      }
      for (std::int32_t i = 0; i < chunk; ++i) {
        llama_sampler_accept(sampler, promptTokens[offset + static_cast<std::size_t>(i)]);
      }
      position += chunk;
    }

    for (std::int32_t i = 0; i < params.maxTokens; ++i) {
      if (externalCancelled.load() || cancelled_.load()) {
        return promptTokenCount;
      }

      llama_token token = llama_sampler_sample(sampler, ctx_, -1);

      if (isEndToken(token)) {
        return promptTokenCount;
      }
      llama_sampler_accept(sampler, token);

      std::string piece = tokenToPiece(token);
      if (!piece.empty() && !onToken(piece)) {
        return promptTokenCount;
      }

      llama_batch nextBatch = llama_batch_get_one(&token, 1, position, 0);
      if (llama_decode(ctx_, nextBatch) != 0) {
        throw BitNetException(ErrorCode::Internal, "BITNET_RUNTIME_ERROR: token decode failed");
      }
      position += 1;
    }
    return promptTokenCount;
  }

 private:
  std::vector<llama_token> tokenize(const std::string & text) {
    std::vector<llama_token> tokens(std::max<std::size_t>(16, text.size() + 8));
    int count = llama_tokenize(
        model_,
        text.c_str(),
        static_cast<std::int32_t>(text.size()),
        tokens.data(),
        static_cast<std::int32_t>(tokens.size()),
        true,
        true);

    if (count < 0) {
      tokens.resize(static_cast<std::size_t>(-count));
      count = llama_tokenize(
          model_,
          text.c_str(),
          static_cast<std::int32_t>(text.size()),
          tokens.data(),
          static_cast<std::int32_t>(tokens.size()),
          true,
          true);
    }
    if (count < 0) {
      throw BitNetException(ErrorCode::Internal, "BITNET_RUNTIME_ERROR: llama_tokenize failed");
    }

    tokens.resize(static_cast<std::size_t>(count));
    return tokens;
  }

  bool isEndToken(llama_token token) const {
    return llama_token_is_eog(model_, token);
  }

  llama_sampler * createSampler(const GenerationParams & params) {
    if (params.temperature <= 0.0) {
      return llama_sampler_init_greedy();
    }

    llama_sampler_chain_params chainParams = llama_sampler_chain_default_params();
    llama_sampler * chain = llama_sampler_chain_init(chainParams);
    llama_sampler_chain_add(
        chain,
        llama_sampler_init_penalties(
            llama_n_vocab(model_),
            llama_token_eos(model_),
            llama_token_nl(model_),
            64,
            static_cast<float>(params.repeatPenalty),
            0.0f,
            0.0f,
            false,
            false));
    llama_sampler_chain_add(chain, llama_sampler_init_top_k(std::max(1, params.topK)));
    llama_sampler_chain_add(chain, llama_sampler_init_top_p(static_cast<float>(params.topP), 1));
    llama_sampler_chain_add(chain, llama_sampler_init_temp(static_cast<float>(params.temperature)));
    llama_sampler_chain_add(chain, llama_sampler_init_dist(normalizeSeed(params.seed)));
    return chain;
  }

  std::string tokenToPiece(llama_token token) {
    std::string piece(64, '\0');
    int size = llama_token_to_piece(model_, token, piece.data(), static_cast<std::int32_t>(piece.size()), 0, false);
    if (size < 0) {
      piece.resize(static_cast<std::size_t>(-size));
      size = llama_token_to_piece(model_, token, piece.data(), static_cast<std::int32_t>(piece.size()), 0, false);
    }
    if (size <= 0) {
      return "";
    }
    piece.resize(static_cast<std::size_t>(size));
    return piece;
  }

  void unloadLocked() noexcept {
    if (ctx_ != nullptr) {
      llama_free(ctx_);
      ctx_ = nullptr;
    }
    if (model_ != nullptr) {
      llama_free_model(model_);
      model_ = nullptr;
    }
  }

  std::mutex mutex_;
  llama_model * model_ = nullptr;
  llama_context * ctx_ = nullptr;
  RuntimeKind runtime_ = RuntimeKind::Cpu;
  std::atomic_bool cancelled_{false};
};

class CPUBackend final : public LlamaBitNetBackend {
 public:
  CPUBackend() : LlamaBitNetBackend(RuntimeKind::Cpu) {}
};

class GPUBackend final : public LlamaBitNetBackend {
 public:
  GPUBackend() : LlamaBitNetBackend(RuntimeKind::Gpu) {}
};

#endif

}  // namespace

std::unique_ptr<IBitNetBackend> createBackend(RuntimeKind runtime) {
  if (runtime != RuntimeKind::Cpu && runtime != RuntimeKind::Gpu) {
    throw BitNetException(
        ErrorCode::RuntimeUnavailable,
        "BITNET_RUNTIME_UNAVAILABLE: unsupported runtime requested");
  }

#if defined(BITNET_RN_HAS_BITNET)
  if (runtime == RuntimeKind::Gpu) {
#if defined(BITNET_RN_ENABLE_GPU)
    return std::make_unique<GPUBackend>();
#else
    throw BitNetException(ErrorCode::RuntimeUnavailable, "BITNET_RUNTIME_UNAVAILABLE: GPU support was not compiled");
#endif
  }
  return std::make_unique<CPUBackend>();
#elif defined(BITNET_RN_ENABLE_STUB)
  if (runtime == RuntimeKind::Gpu) {
    throw BitNetException(ErrorCode::RuntimeUnavailable, "BITNET_RUNTIME_UNAVAILABLE: GPU support is unavailable in the test stub backend");
  }
  return createTestStubBackend();
#else
  return std::make_unique<UnavailableBackend>();
#endif
}

bool isSafeGpuFallbackError(const std::exception & error) noexcept {
  const std::string message = error.what();
  const auto contains = [&message](const char * needle) {
    return message.find(needle) != std::string::npos;
  };
  return contains("GPU") || contains("gpu") || contains("Metal") || contains("metal") ||
      contains("Vulkan") || contains("vulkan") || contains("OpenCL") || contains("opencl") ||
      contains("OOM") || contains("out of memory") || contains("llama_decode") ||
      contains("llama_init_from_model") || contains("llama_model_load_from_file");
}

}  // namespace bitnetrn
