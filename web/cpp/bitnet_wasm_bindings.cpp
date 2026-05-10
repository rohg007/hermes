#include <chrono>
#include <exception>
#include <sstream>
#include <string>
#include <vector>

#include <emscripten/bind.h>

#include "bitnet_rn/backend.hpp"
#include "bitnet_rn/errors.hpp"
#include "bitnet_rn/native_facade.hpp"

namespace {

constexpr const char * kErrorHandlePrefix = "__BITNET_ERROR__:";

std::string jsonEscape(const std::string & value) {
  std::ostringstream out;
  static constexpr char kHex[] = "0123456789abcdef";
  for (const unsigned char ch : value) {
    switch (ch) {
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
        if (ch < 0x20) {
          out << "\\u00" << kHex[(ch >> 4) & 0x0f] << kHex[ch & 0x0f];
        } else {
          out << static_cast<char>(ch);
        }
    }
  }
  return out.str();
}

bool hasBitNetPrefix(const std::string & message) {
  return message.rfind("BITNET_", 0) == 0;
}

std::string formatException(const bitnetrn::BitNetException & error) {
  const std::string message = error.what();
  if (hasBitNetPrefix(message)) {
    return message;
  }
  return std::string(bitnetrn::errorCodeName(error.code())) + ": " + message;
}

std::string formatException(const std::exception & error) {
  const std::string message = error.what();
  if (hasBitNetPrefix(message)) {
    return message;
  }
  return "BITNET_RUNTIME_ERROR: " + message;
}

std::string errorJsonObject(const std::string & message) {
  return "{\"error\":\"" + jsonEscape(message) + "\"}";
}

std::string errorJsonEvents(const std::string & message) {
  return "[{\"type\":\"error\",\"error\":\"" + jsonEscape(message) + "\"}]";
}

std::string errorHandle(const std::string & message) {
  return std::string(kErrorHandlePrefix) + message;
}

std::string loadModelJson(const std::string & path,
                          const std::string & id,
                          const std::string & runtime,
                          int contextSize,
                          int threads,
                          bool keepInMemory) {
  try {
    bitnetrn::ModelLoadOptions options;
    options.id = id.empty() ? path : id;
    options.runtime = bitnetrn::runtimeKindFromString(runtime);
    options.contextSize = contextSize;
    options.threads = threads;
    options.keepInMemory = keepInMemory;
    return bitnetrn::loadModelResultToJson(bitnetrn::NativeFacade::shared().loadModel(path, options));
  } catch (const bitnetrn::BitNetException & error) {
    return errorJsonObject(formatException(error));
  } catch (const std::exception & error) {
    return errorJsonObject(formatException(error));
  } catch (...) {
    return errorJsonObject("BITNET_RUNTIME_ERROR: unknown native exception while loading model");
  }
}

std::string unloadModelJson(const std::string & handle) {
  try {
    bitnetrn::NativeFacade::shared().unloadModel(handle);
    return "{}";
  } catch (const bitnetrn::BitNetException & error) {
    return errorJsonObject(formatException(error));
  } catch (const std::exception & error) {
    return errorJsonObject(formatException(error));
  } catch (...) {
    return errorJsonObject("BITNET_RUNTIME_ERROR: unknown native exception while unloading model");
  }
}

std::string startGenerationJson(const std::string & modelHandle,
                                const std::string & prompt,
                                const std::string & systemPrompt,
                                const std::string & chatTemplate,
                                double temperature,
                                int topK,
                                double topP,
                                int maxTokens,
                                int seed,
                                double repeatPenalty,
                                bool useChatTemplate) {
  try {
    bitnetrn::GenerationParams params;
    params.prompt = prompt;
    params.systemPrompt = systemPrompt;
    params.chatTemplate = chatTemplate;
    params.temperature = temperature;
    params.topK = topK;
    params.topP = topP;
    params.maxTokens = maxTokens;
    params.seed = seed;
    params.repeatPenalty = repeatPenalty;
    params.useChatTemplate = useChatTemplate;
    return bitnetrn::NativeFacade::shared().startGeneration(modelHandle, params);
  } catch (const bitnetrn::BitNetException & error) {
    return errorHandle(formatException(error));
  } catch (const std::exception & error) {
    return errorHandle(formatException(error));
  } catch (...) {
    return errorHandle("BITNET_RUNTIME_ERROR: unknown native exception while starting generation");
  }
}

std::string generateBlockingJson(const std::string & modelHandle,
                                 const std::string & prompt,
                                 const std::string & systemPrompt,
                                 const std::string & chatTemplate,
                                 double temperature,
                                 int topK,
                                 double topP,
                                 int maxTokens,
                                 int seed,
                                 double repeatPenalty,
                                 bool useChatTemplate,
                                 emscripten::val onEvent) {
  try {
    bitnetrn::GenerationParams params;
    params.prompt = prompt;
    params.systemPrompt = systemPrompt;
    params.chatTemplate = chatTemplate;
    params.temperature = temperature;
    params.topK = topK;
    params.topP = topP;
    params.maxTokens = maxTokens;
    params.seed = seed;
    params.repeatPenalty = repeatPenalty;
    params.useChatTemplate = useChatTemplate;

    bitnetrn::NativeFacade::shared().generateBlocking(
        modelHandle,
        params,
        [&](const bitnetrn::NativeTokenEvent & event) {
          std::vector<bitnetrn::NativeTokenEvent> events;
          events.push_back(event);
          auto keepGoing = onEvent(bitnetrn::nativeEventsToJson(events));
          if (keepGoing.typeOf().as<std::string>() == "boolean") {
            return keepGoing.as<bool>();
          }
          return true;
        });
    return "{}";
  } catch (const bitnetrn::BitNetException & error) {
    return errorJsonObject(formatException(error));
  } catch (const std::exception & error) {
    return errorJsonObject(formatException(error));
  } catch (...) {
    return errorJsonObject("BITNET_RUNTIME_ERROR: unknown native exception while generating");
  }
}

std::string nextTokenBatchJson(const std::string & generationHandle, int maxTokens, int timeoutMs) {
  try {
    auto events = bitnetrn::NativeFacade::shared().nextTokenBatch(
        generationHandle,
        static_cast<std::size_t>(maxTokens),
        std::chrono::milliseconds(timeoutMs));
    return bitnetrn::nativeEventsToJson(events);
  } catch (const bitnetrn::BitNetException & error) {
    return errorJsonEvents(formatException(error));
  } catch (const std::exception & error) {
    return errorJsonEvents(formatException(error));
  } catch (...) {
    return errorJsonEvents("BITNET_RUNTIME_ERROR: unknown native exception while reading generation");
  }
}

std::string cancelGenerationJson(const std::string & generationHandle) {
  try {
    bitnetrn::NativeFacade::shared().cancelGeneration(generationHandle);
    return "{}";
  } catch (const bitnetrn::BitNetException & error) {
    return errorJsonObject(formatException(error));
  } catch (const std::exception & error) {
    return errorJsonObject(formatException(error));
  } catch (...) {
    return errorJsonObject("BITNET_RUNTIME_ERROR: unknown native exception while cancelling generation");
  }
}

std::string getRuntimeCapabilitiesJson() {
  try {
    return bitnetrn::runtimeCapabilitiesToJson(bitnetrn::NativeFacade::shared().capabilities());
  } catch (const bitnetrn::BitNetException & error) {
    return errorJsonObject(formatException(error));
  } catch (const std::exception & error) {
    return errorJsonObject(formatException(error));
  } catch (...) {
    return errorJsonObject("BITNET_RUNTIME_ERROR: unknown native exception while detecting runtime capabilities");
  }
}

}  // namespace

EMSCRIPTEN_BINDINGS(bitnet_wasm) {
  emscripten::function("getRuntimeCapabilitiesJson", &getRuntimeCapabilitiesJson);
  emscripten::function("loadModelJson", &loadModelJson);
  emscripten::function("unloadModelJson", &unloadModelJson);
  emscripten::function("startGenerationJson", &startGenerationJson);
  emscripten::function("generateBlockingJson", &generateBlockingJson);
  emscripten::function("nextTokenBatchJson", &nextTokenBatchJson);
  emscripten::function("cancelGenerationJson", &cancelGenerationJson);
}
