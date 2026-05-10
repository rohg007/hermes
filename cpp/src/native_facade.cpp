#include "bitnet_rn/native_facade.hpp"

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <sstream>
#include <thread>
#include <utility>

#include "bitnet_rn/errors.hpp"
#include "bitnet_rn/utf8.hpp"

namespace bitnetrn {

namespace {

void appendJsonHex4(std::ostringstream & out, std::uint32_t value) {
  static constexpr char kHex[] = "0123456789abcdef";
  out << "\\u";
  out << kHex[(value >> 12) & 0x0f];
  out << kHex[(value >> 8) & 0x0f];
  out << kHex[(value >> 4) & 0x0f];
  out << kHex[value & 0x0f];
}

void appendJsonCodePoint(std::ostringstream & out, std::uint32_t codePoint) {
  if (codePoint <= 0xffff) {
    appendJsonHex4(out, codePoint);
    return;
  }

  codePoint -= 0x10000;
  appendJsonHex4(out, 0xd800 + ((codePoint >> 10) & 0x3ff));
  appendJsonHex4(out, 0xdc00 + (codePoint & 0x3ff));
}

std::string jsonEscape(const std::string & value) {
  std::ostringstream out;
  std::size_t index = 0;
  while (index < value.size()) {
    const auto codePoint = nextUtf8CodePointReplacingInvalid(value, index);
    switch (codePoint) {
      case '"':
        out << "\\\"";
        break;
      case '\\':
        out << "\\\\";
        break;
      case '\b':
        out << "\\b";
        break;
      case '\f':
        out << "\\f";
        break;
      case '\n':
        out << "\\n";
        break;
      case '\r':
        out << "\\r";
        break;
      case '\t':
        out << "\\t";
        break;
      default:
        if (codePoint < 0x20) {
          appendJsonHex4(out, codePoint);
        } else if (codePoint < 0x80) {
          out << static_cast<char>(codePoint);
        } else {
          appendJsonCodePoint(out, codePoint);
        }
    }
  }
  return out.str();
}

std::string eventTypeToString(NativeEventType type) {
  switch (type) {
    case NativeEventType::Token:
      return "token";
    case NativeEventType::Metrics:
      return "metrics";
    case NativeEventType::Warning:
      return "warning";
    case NativeEventType::End:
      return "end";
    case NativeEventType::Error:
      return "error";
    case NativeEventType::Cancelled:
      return "cancelled";
  }
  return "error";
}

std::string exceptionMessage(const BitNetException & error) {
  return std::string(errorCodeName(error.code())) + ": " + error.what();
}

void joinOrDetachWorker(std::thread & worker) noexcept {
  if (!worker.joinable()) {
    return;
  }
  if (worker.get_id() == std::this_thread::get_id()) {
    worker.detach();
    return;
  }
  try {
    worker.join();
  } catch (...) {
    if (worker.joinable()) {
      worker.detach();
    }
  }
}

class TokenEventBatcher {
 public:
  using Sink = std::function<bool(NativeTokenEvent event)>;
  using IsActive = std::function<bool()>;

  TokenEventBatcher(Sink sink, IsActive isActive)
      : sink_(std::move(sink)), isActive_(std::move(isActive)), lastFlush_(std::chrono::steady_clock::now()) {}

  bool append(const std::string & token) {
    if (!isActive_()) {
      return false;
    }
    pendingText_ += token;
    pendingTokens_ += 1;
    const auto now = std::chrono::steady_clock::now();
    if (pendingTokens_ >= kFlushTokenCount || now - lastFlush_ >= kFlushInterval) {
      return flush();
    }
    return true;
  }

  bool flush() {
    if (pendingText_.empty()) {
      return isActive_();
    }
    if (!isActive_()) {
      pendingText_.clear();
      pendingTokens_ = 0;
      return false;
    }

    NativeTokenEvent event;
    event.type = NativeEventType::Token;
    event.text = std::move(pendingText_);
    pendingText_.clear();
    pendingTokens_ = 0;
    lastFlush_ = std::chrono::steady_clock::now();
    return sink_(std::move(event)) && isActive_();
  }

 private:
  // BitNet emits many tiny token pieces. Batching lowers RN bridge / worker
  // wakeups while keeping streaming responsive for chat UI.
  static constexpr std::size_t kFlushTokenCount = 8;
  static constexpr std::chrono::milliseconds kFlushInterval{32};

  Sink sink_;
  IsActive isActive_;
  std::string pendingText_;
  std::size_t pendingTokens_ = 0;
  std::chrono::steady_clock::time_point lastFlush_;
};

}  // namespace

struct NativeFacade::ModelSession {
  std::string handle;
  std::string id;
  std::string path;
  std::unique_ptr<BitNetEngine> engine;
};

struct NativeFacade::GenerationSession {
  std::string handle;
  std::weak_ptr<ModelSession> model;
  std::mutex mutex;
  std::condition_variable cv;
  std::deque<NativeTokenEvent> events;
  std::thread worker;
  bool terminal = false;
  bool cancelRequested = false;

  void push(NativeTokenEvent event) {
    {
      std::unique_lock<std::mutex> lock(mutex);
      // Bound the native queue so JS backpressure does not let streaming events
      // grow without limit while the decode thread owns large model state.
      cv.wait(lock, [this, &event] {
        return events.size() < 128 || cancelRequested || event.type != NativeEventType::Token;
      });
      if (cancelRequested && event.type == NativeEventType::Token) {
        return;
      }
      if (event.type == NativeEventType::End || event.type == NativeEventType::Error ||
          event.type == NativeEventType::Cancelled) {
        terminal = true;
      }
      events.push_back(std::move(event));
    }
    cv.notify_all();
  }
};

NativeFacade & NativeFacade::shared() {
  // Intentional process-lifetime singleton. ASAN/Valgrind may report this
  // allocation as leaked; deleting it during Android process teardown can trip
  // static destructor ordering and self-join hazards. Models can still be
  // explicitly unloaded through the SDK API.
  static NativeFacade * facade = new NativeFacade();
  return *facade;
}

NativeFacade::~NativeFacade() {
  std::vector<std::shared_ptr<GenerationSession>> generations;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    for (const auto & pair : generations_) {
      generations.push_back(pair.second);
    }
  }

  for (const auto & generation : generations) {
    {
      std::lock_guard<std::mutex> lock(generation->mutex);
      generation->cancelRequested = true;
    }
    if (auto model = generation->model.lock()) {
      model->engine->cancelInference();
    }
  }
  for (const auto & generation : generations) {
    joinOrDetachWorker(generation->worker);
  }
}

RuntimeCapabilities NativeFacade::capabilities() const {
  return detectRuntimeCapabilities();
}

LoadModelResult NativeFacade::loadModel(const std::string & modelPath, const ModelLoadOptions & options) {
  ModelLoadOptions normalized = options;
  normalized.path = modelPath;
  if (normalized.id.empty()) {
    normalized.id = modelPath;
  }

  auto engine = std::make_unique<BitNetEngine>();
  engine->loadModel(normalized);

  auto session = std::make_shared<ModelSession>();
  {
    std::lock_guard<std::mutex> lock(mutex_);
    session->handle = "model-" + std::to_string(nextModelId_++);
  }
  session->id = normalized.id;
  session->path = modelPath;
  session->engine = std::move(engine);

  LoadModelResult result;
  result.handle = session->handle;
  result.id = session->id;
  result.path = session->path;
  result.runtimeUsed = session->engine->runtimeUsed();
  result.warnings = session->engine->warnings();

  {
    std::lock_guard<std::mutex> lock(mutex_);
    models_[session->handle] = session;
  }

  return result;
}

void NativeFacade::unloadModel(const std::string & modelHandle) {
  auto model = getModel(modelHandle);

  std::vector<std::shared_ptr<GenerationSession>> ownedGenerations;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    for (const auto & pair : generations_) {
      if (pair.second->model.lock() == model) {
        ownedGenerations.push_back(pair.second);
      }
    }
    models_.erase(modelHandle);
  }

  for (const auto & generation : ownedGenerations) {
    {
      std::lock_guard<std::mutex> lock(generation->mutex);
      generation->cancelRequested = true;
    }
    model->engine->cancelInference();
  }

  for (const auto & generation : ownedGenerations) {
    joinOrDetachWorker(generation->worker);
    std::lock_guard<std::mutex> lock(mutex_);
    generations_.erase(generation->handle);
  }

  model->engine->unloadModel();
}

std::string NativeFacade::startGeneration(const std::string & modelHandle, const GenerationParams & params) {
  auto model = getModel(modelHandle);
  auto generation = std::make_shared<GenerationSession>();
  generation->model = model;

  {
    std::lock_guard<std::mutex> lock(mutex_);
    generation->handle = "generation-" + std::to_string(nextGenerationId_++);
    generations_[generation->handle] = generation;
  }

  generation->worker = std::thread([model, generation, params] {
    auto isActive = [generation] {
      std::lock_guard<std::mutex> lock(generation->mutex);
      return !generation->cancelRequested;
    };
    auto pushEvent = [generation](NativeTokenEvent event) {
      generation->push(std::move(event));
      return true;
    };
    TokenEventBatcher tokenBatcher(pushEvent, isActive);

    try {
      model->engine->generateTokens(
          params,
          [&tokenBatcher](const std::string & token) {
            return tokenBatcher.append(token);
          },
          [&tokenBatcher, generation](const InferenceMetrics & metrics) {
            tokenBatcher.flush();
            NativeTokenEvent event;
            event.type = NativeEventType::Metrics;
            event.metrics = metrics;
            generation->push(std::move(event));
          },
          [&tokenBatcher, generation](const std::string & warning) {
            tokenBatcher.flush();
            NativeTokenEvent event;
            event.type = NativeEventType::Warning;
            event.warning = warning;
            generation->push(std::move(event));
          });

      tokenBatcher.flush();
      NativeTokenEvent end;
      end.type = NativeEventType::End;
      generation->push(std::move(end));
    } catch (const BitNetException & error) {
      tokenBatcher.flush();
      NativeTokenEvent event;
      event.type = error.code() == ErrorCode::InferenceCancelled ? NativeEventType::Cancelled : NativeEventType::Error;
      event.error = exceptionMessage(error);
      generation->push(std::move(event));
    } catch (const std::exception & error) {
      tokenBatcher.flush();
      NativeTokenEvent event;
      event.type = NativeEventType::Error;
      event.error = error.what();
      generation->push(std::move(event));
    } catch (...) {
      tokenBatcher.flush();
      NativeTokenEvent event;
      event.type = NativeEventType::Error;
      event.error = "BITNET_RUNTIME_ERROR: unknown native exception";
      generation->push(std::move(event));
    }
  });

  return generation->handle;
}

std::vector<NativeTokenEvent> NativeFacade::nextTokenBatch(const std::string & generationHandle,
                                                           std::size_t maxTokens,
                                                           std::chrono::milliseconds timeout) {
  auto generation = getGeneration(generationHandle);
  std::vector<NativeTokenEvent> batch;
  batch.reserve(maxTokens == 0 ? 1 : maxTokens);

  {
    std::unique_lock<std::mutex> lock(generation->mutex);
    generation->cv.wait_for(lock, timeout, [&generation] {
      return !generation->events.empty() || generation->terminal;
    });

    while (!generation->events.empty() && batch.size() < std::max<std::size_t>(1, maxTokens)) {
      batch.push_back(std::move(generation->events.front()));
      generation->events.pop_front();
      if (batch.back().type == NativeEventType::End || batch.back().type == NativeEventType::Error ||
          batch.back().type == NativeEventType::Cancelled) {
        break;
      }
    }
    generation->cv.notify_all();
  }

  bool shouldCleanup = false;
  {
    std::lock_guard<std::mutex> lock(generation->mutex);
    shouldCleanup = generation->terminal && generation->events.empty();
  }
  if (shouldCleanup) {
    joinOrDetachWorker(generation->worker);
    std::lock_guard<std::mutex> lock(mutex_);
    generations_.erase(generationHandle);
  }

  return batch;
}

void NativeFacade::cancelGeneration(const std::string & generationHandle) {
  auto generation = getGeneration(generationHandle);
  {
    std::lock_guard<std::mutex> lock(generation->mutex);
    generation->cancelRequested = true;
  }
  generation->cv.notify_all();
  if (auto model = generation->model.lock()) {
    model->engine->cancelInference();
  }
}

void NativeFacade::generateBlocking(const std::string & modelHandle,
                                    const GenerationParams & params,
                                    const NativeEventCallback & onEvent) {
  auto model = getModel(modelHandle);
  bool cancelled = false;

  auto emit = [&](NativeTokenEvent event) {
    if (!onEvent(event)) {
      cancelled = true;
      return false;
    }
    return true;
  };
  TokenEventBatcher tokenBatcher(emit, [&cancelled] {
    return !cancelled;
  });

  try {
    model->engine->generateTokens(
        params,
        [&](const std::string & token) {
          return tokenBatcher.append(token);
        },
        [&](const InferenceMetrics & metrics) {
          tokenBatcher.flush();
          NativeTokenEvent event;
          event.type = NativeEventType::Metrics;
          event.metrics = metrics;
          emit(std::move(event));
        },
        [&](const std::string & warning) {
          tokenBatcher.flush();
          NativeTokenEvent event;
          event.type = NativeEventType::Warning;
          event.warning = warning;
          emit(std::move(event));
        });

    tokenBatcher.flush();
    NativeTokenEvent terminal;
    terminal.type = cancelled ? NativeEventType::Cancelled : NativeEventType::End;
    emit(std::move(terminal));
  } catch (const BitNetException & error) {
    tokenBatcher.flush();
    NativeTokenEvent event;
    event.type = error.code() == ErrorCode::InferenceCancelled ? NativeEventType::Cancelled : NativeEventType::Error;
    event.error = exceptionMessage(error);
    emit(std::move(event));
  } catch (const std::exception & error) {
    tokenBatcher.flush();
    NativeTokenEvent event;
    event.type = NativeEventType::Error;
    event.error = error.what();
    emit(std::move(event));
  } catch (...) {
    tokenBatcher.flush();
    NativeTokenEvent event;
    event.type = NativeEventType::Error;
    event.error = "BITNET_RUNTIME_ERROR: unknown native exception";
    emit(std::move(event));
  }
}

std::shared_ptr<NativeFacade::ModelSession> NativeFacade::getModel(const std::string & handle) {
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = models_.find(handle);
  if (it == models_.end()) {
    throw BitNetException(ErrorCode::ModelNotFound, "BITNET_MODEL_NOT_FOUND: invalid model handle " + handle);
  }
  return it->second;
}

std::shared_ptr<NativeFacade::GenerationSession> NativeFacade::getGeneration(const std::string & handle) {
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = generations_.find(handle);
  if (it == generations_.end()) {
    throw BitNetException(ErrorCode::ModelNotFound, "BITNET_MODEL_NOT_FOUND: invalid generation handle " + handle);
  }
  return it->second;
}

std::string nativeEventsToJson(const std::vector<NativeTokenEvent> & events) {
  std::ostringstream out;
  out << "[";
  for (std::size_t i = 0; i < events.size(); ++i) {
    const auto & event = events[i];
    if (i > 0) {
      out << ",";
    }
    out << "{\"type\":\"" << eventTypeToString(event.type) << "\"";
    if (event.type == NativeEventType::Token) {
      out << ",\"text\":\"" << jsonEscape(event.text) << "\"";
    } else if (event.type == NativeEventType::Warning) {
      out << ",\"warning\":\"" << jsonEscape(event.warning) << "\"";
    } else if (event.type == NativeEventType::Error || event.type == NativeEventType::Cancelled) {
      out << ",\"error\":\"" << jsonEscape(event.error) << "\"";
    } else if (event.type == NativeEventType::Metrics) {
      out << ",\"metrics\":{";
      out << "\"modelId\":\"" << jsonEscape(event.metrics.modelId) << "\",";
      out << "\"runtimeUsed\":\"" << runtimeKindToString(event.metrics.runtimeUsed) << "\",";
      if (event.metrics.promptTokens >= 0) {
        out << "\"promptTokens\":" << event.metrics.promptTokens << ",";
      }
      out << "\"generatedTokens\":" << event.metrics.generatedTokens << ",";
      out << "\"tokensPerSecond\":" << event.metrics.tokensPerSecond << ",";
      out << "\"latencyMs\":" << event.metrics.latencyMs << ",";
      out << "\"firstTokenLatencyMs\":" << event.metrics.firstTokenLatencyMs << ",";
      out << "\"memoryUsageBytes\":" << event.metrics.memoryUsageBytes << ",";
      out << "\"memoryUsageMB\":" << (static_cast<double>(event.metrics.memoryUsageBytes) / 1024.0 / 1024.0) << ",";
      out << "\"threadCount\":" << event.metrics.threadCount;
      out << "}";
    }
    out << "}";
  }
  out << "]";
  return out.str();
}

std::string loadModelResultToJson(const LoadModelResult & result) {
  std::ostringstream out;
  out << "{";
  out << "\"handle\":\"" << jsonEscape(result.handle) << "\",";
  out << "\"id\":\"" << jsonEscape(result.id) << "\",";
  out << "\"path\":\"" << jsonEscape(result.path) << "\",";
  out << "\"runtimeUsed\":\"" << runtimeKindToString(result.runtimeUsed) << "\",";
  out << "\"warnings\":[";
  for (std::size_t i = 0; i < result.warnings.size(); ++i) {
    if (i > 0) {
      out << ",";
    }
    out << "\"" << jsonEscape(result.warnings[i]) << "\"";
  }
  out << "]";
  out << "}";
  return out.str();
}

std::string runtimeCapabilitiesToJson(const RuntimeCapabilities & capabilities) {
  std::ostringstream out;
  out << "{";
  out << "\"cpu\":{";
  out << "\"available\":" << (capabilities.cpu.available ? "true" : "false") << ",";
  out << "\"arch\":\"" << jsonEscape(capabilities.cpu.arch) << "\",";
  out << "\"neon\":" << (capabilities.cpu.neon ? "true" : "false") << ",";
  out << "\"avx2\":" << (capabilities.cpu.avx2 ? "true" : "false") << ",";
  out << "\"threadCount\":" << capabilities.cpu.threadCount;
  out << "},";
  out << "\"gpu\":{";
  out << "\"available\":" << (capabilities.gpu.available ? "true" : "false") << ",";
  out << "\"compiled\":" << (capabilities.gpu.compiled ? "true" : "false") << ",";
  out << "\"api\":\"" << jsonEscape(capabilities.gpu.api) << "\",";
  out << "\"reason\":\"" << jsonEscape(capabilities.gpu.reason) << "\"";
  out << "}";
  out << "}";
  return out.str();
}

}  // namespace bitnetrn
