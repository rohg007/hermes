#include <jni.h>

#include <chrono>
#include <cstdint>
#include <string>

#include "bitnet_rn/errors.hpp"
#include "bitnet_rn/native_facade.hpp"
#include "bitnet_rn/utf8.hpp"

namespace {

void appendUtf16(std::u16string & out, std::uint32_t codePoint) {
  if (codePoint <= 0xffff) {
    out.push_back(static_cast<char16_t>(codePoint));
    return;
  }

  codePoint -= 0x10000;
  out.push_back(static_cast<char16_t>(0xd800 + ((codePoint >> 10) & 0x3ff)));
  out.push_back(static_cast<char16_t>(0xdc00 + (codePoint & 0x3ff)));
}

std::u16string toUtf16ReplacingInvalid(const std::string & value) {
  std::u16string out;
  out.reserve(value.size());
  std::size_t index = 0;
  while (index < value.size()) {
    appendUtf16(out, bitnetrn::nextUtf8CodePointReplacingInvalid(value, index));
  }
  return out;
}

std::string toString(JNIEnv * env, jstring value) {
  if (value == nullptr) {
    return "";
  }
  const char * chars = env->GetStringUTFChars(value, nullptr);
  std::string result(chars == nullptr ? "" : chars);
  if (chars != nullptr) {
    env->ReleaseStringUTFChars(value, chars);
  }
  return result;
}

jstring toJString(JNIEnv * env, const std::string & value) {
  const auto utf16 = toUtf16ReplacingInvalid(value);
  return env->NewString(reinterpret_cast<const jchar *>(utf16.data()), static_cast<jsize>(utf16.size()));
}

void throwJava(JNIEnv * env, const std::string & message) {
  jclass exceptionClass = env->FindClass("java/lang/RuntimeException");
  if (exceptionClass == nullptr) {
    return;
  }
  jmethodID constructor = env->GetMethodID(exceptionClass, "<init>", "(Ljava/lang/String;)V");
  if (constructor == nullptr) {
    env->ThrowNew(exceptionClass, "BitNet native error");
    return;
  }

  jstring detail = toJString(env, message);
  jobject exception = env->NewObject(exceptionClass, constructor, detail);
  if (detail != nullptr) {
    env->DeleteLocalRef(detail);
  }
  if (exception != nullptr) {
    env->Throw(static_cast<jthrowable>(exception));
    env->DeleteLocalRef(exception);
  } else {
    env->ThrowNew(exceptionClass, "BitNet native error");
  }
}

void throwJava(JNIEnv * env, const bitnetrn::BitNetException & error) {
  const std::string code = bitnetrn::errorCodeName(error.code());
  const std::string message = error.what();
  const std::string prefix = code + ": ";
  throwJava(env, message.rfind(prefix, 0) == 0 ? message : prefix + message);
}

}  // namespace

extern "C" JNIEXPORT jstring JNICALL
Java_com_bitnetrn_BitNetModule_nativeGetRuntimeCapabilities(JNIEnv * env, jclass) {
  try {
    return toJString(env, bitnetrn::runtimeCapabilitiesToJson(bitnetrn::NativeFacade::shared().capabilities()));
  } catch (const bitnetrn::BitNetException & error) {
    throwJava(env, error);
  } catch (const std::exception & error) {
    throwJava(env, error.what());
  }
  return nullptr;
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_bitnetrn_BitNetModule_nativeLoadModel(JNIEnv * env,
                                               jclass,
                                               jstring modelPath,
                                               jstring modelId,
                                               jstring runtime,
                                               jint contextSize,
                                               jint threads,
                                               jboolean keepInMemory) {
  try {
    bitnetrn::ModelLoadOptions options;
    options.id = toString(env, modelId);
    options.runtime = bitnetrn::runtimeKindFromString(toString(env, runtime));
    options.contextSize = contextSize;
    options.threads = threads;
    options.keepInMemory = keepInMemory == JNI_TRUE;

    auto result = bitnetrn::NativeFacade::shared().loadModel(toString(env, modelPath), options);
    return toJString(env, bitnetrn::loadModelResultToJson(result));
  } catch (const bitnetrn::BitNetException & error) {
    throwJava(env, error);
  } catch (const std::exception & error) {
    throwJava(env, error.what());
  }
  return nullptr;
}

extern "C" JNIEXPORT void JNICALL
Java_com_bitnetrn_BitNetModule_nativeUnloadModel(JNIEnv * env, jclass, jstring modelHandle) {
  try {
    bitnetrn::NativeFacade::shared().unloadModel(toString(env, modelHandle));
  } catch (const bitnetrn::BitNetException & error) {
    throwJava(env, error);
  } catch (const std::exception & error) {
    throwJava(env, error.what());
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_bitnetrn_BitNetModule_nativeStartGeneration(JNIEnv * env,
                                                     jclass,
                                                     jstring modelHandle,
                                                     jstring prompt,
                                                     jstring systemPrompt,
                                                     jstring chatTemplate,
                                                     jdouble temperature,
                                                     jint topK,
                                                     jdouble topP,
                                                     jint maxTokens,
                                                     jint seed,
                                                     jdouble repeatPenalty,
                                                     jboolean useChatTemplate) {
  try {
    bitnetrn::GenerationParams params;
    params.prompt = toString(env, prompt);
    params.systemPrompt = toString(env, systemPrompt);
    params.chatTemplate = toString(env, chatTemplate);
    params.temperature = temperature;
    params.topK = topK;
    params.topP = topP;
    params.maxTokens = maxTokens;
    params.seed = seed;
    params.repeatPenalty = repeatPenalty;
    params.useChatTemplate = useChatTemplate == JNI_TRUE;

    return toJString(
        env,
        bitnetrn::NativeFacade::shared().startGeneration(toString(env, modelHandle), params));
  } catch (const bitnetrn::BitNetException & error) {
    throwJava(env, error);
  } catch (const std::exception & error) {
    throwJava(env, error.what());
  }
  return nullptr;
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_bitnetrn_BitNetModule_nativeNextTokenBatch(JNIEnv * env,
                                                    jclass,
                                                    jstring generationHandle,
                                                    jint maxTokens,
                                                    jint timeoutMs) {
  try {
    auto events = bitnetrn::NativeFacade::shared().nextTokenBatch(
        toString(env, generationHandle),
        static_cast<std::size_t>(maxTokens),
        std::chrono::milliseconds(timeoutMs));
    return toJString(env, bitnetrn::nativeEventsToJson(events));
  } catch (const bitnetrn::BitNetException & error) {
    throwJava(env, error);
  } catch (const std::exception & error) {
    throwJava(env, error.what());
  }
  return nullptr;
}

extern "C" JNIEXPORT void JNICALL
Java_com_bitnetrn_BitNetModule_nativeCancelGeneration(JNIEnv * env, jclass, jstring generationHandle) {
  try {
    bitnetrn::NativeFacade::shared().cancelGeneration(toString(env, generationHandle));
  } catch (const bitnetrn::BitNetException & error) {
    throwJava(env, error);
  } catch (const std::exception & error) {
    throwJava(env, error.what());
  }
}
