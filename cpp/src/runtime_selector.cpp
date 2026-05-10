#include "bitnet_rn/runtime.hpp"

#include <algorithm>
#include <sstream>
#include <thread>

#if !defined(__EMSCRIPTEN__)
#include <dlfcn.h>
#endif

#include "bitnet_rn/errors.hpp"

namespace bitnetrn {

namespace {

[[maybe_unused]] bool canOpenLibrary(const char * name) {
#if defined(__EMSCRIPTEN__)
  (void)name;
  return false;
#else
  void * handle = dlopen(name, RTLD_LAZY | RTLD_LOCAL);
  if (handle == nullptr) {
    return false;
  }
  dlclose(handle);
  return true;
#endif
}

[[maybe_unused]] bool isArm64() {
#if defined(__aarch64__) || defined(_M_ARM64)
  return true;
#else
  return false;
#endif
}

[[maybe_unused]] bool hasMetalDevice() {
#if defined(__APPLE__)
  using CreateDevice = void * (*)();
  auto createDevice = reinterpret_cast<CreateDevice>(dlsym(RTLD_DEFAULT, "MTLCreateSystemDefaultDevice"));
  if (createDevice == nullptr) {
    return false;
  }
  return createDevice() != nullptr;
#else
  return false;
#endif
}

}  // namespace

RuntimeCapabilities detectRuntimeCapabilities() {
  RuntimeCapabilities capabilities;

#if defined(__aarch64__) || defined(_M_ARM64)
  capabilities.cpu.arch = "arm64";
#elif defined(__arm__) || defined(_M_ARM)
  capabilities.cpu.arch = "arm";
#elif defined(__x86_64__) || defined(_M_X64)
  capabilities.cpu.arch = "x86_64";
#elif defined(__i386__) || defined(_M_IX86)
  capabilities.cpu.arch = "x86";
#else
  capabilities.cpu.arch = "unknown";
#endif

#if defined(__ARM_NEON) || defined(__ARM_NEON__) || defined(__aarch64__) || defined(_M_ARM64)
  capabilities.cpu.neon = true;
#endif

#if defined(__AVX2__)
  capabilities.cpu.avx2 = true;
#endif

  const auto threads = std::thread::hardware_concurrency();
  capabilities.cpu.threadCount = static_cast<std::int32_t>(std::max(1u, threads));

  capabilities.gpu.compiled = false;
#if defined(BITNET_RN_ENABLE_GPU)
  capabilities.gpu.compiled = true;
#endif

#if defined(BITNET_RN_PLATFORM_ANDROID)
  const bool abiOk = isArm64();
  const bool vulkan = canOpenLibrary("libvulkan.so");
  capabilities.gpu.api = vulkan ? "vulkan" : "";
  capabilities.gpu.available = false;
  if (!capabilities.gpu.compiled) {
    capabilities.gpu.reason = "GPU support was not compiled. Build with ENABLE_GPU=true.";
  } else if (!abiOk) {
    capabilities.gpu.reason = "Android GPU runtime requires arm64-v8a.";
  } else if (!vulkan) {
    capabilities.gpu.reason = "No Vulkan runtime library was detected.";
  } else {
    capabilities.gpu.reason =
        "Android Vulkan was detected, but the current BitNet I2_S model is kept on CPU because upstream ggml "
        "Vulkan can abort during context creation for this path.";
  }
#elif defined(BITNET_RN_PLATFORM_APPLE)
  capabilities.gpu.api = "metal";
  const bool metal = hasMetalDevice();
  capabilities.gpu.available = capabilities.gpu.compiled && metal;
  if (!capabilities.gpu.compiled) {
    capabilities.gpu.reason = "GPU support was not compiled. Build with ENABLE_GPU=true.";
  } else if (!metal) {
    capabilities.gpu.reason = "Metal device is not available.";
  } else {
    capabilities.gpu.reason = "GPU runtime is available through Metal.";
  }
#else
  capabilities.gpu.reason = "GPU runtime is not available on this platform build.";
#endif

  return capabilities;
}

RuntimeSelection selectRuntime(RuntimeKind requested, const RuntimeCapabilities & capabilities) {
  RuntimeSelection selection;
  selection.requested = requested;

  if (requested == RuntimeKind::Auto) {
    if (capabilities.gpu.available) {
      selection.selected = RuntimeKind::Gpu;
      selection.reason = "auto selected GPU";
      return selection;
    }
    if (capabilities.cpu.available) {
      selection.selected = RuntimeKind::Cpu;
      selection.reason = std::string("auto selected CPU") +
          (capabilities.gpu.reason.empty() ? std::string("") : std::string(": ") + capabilities.gpu.reason);
      return selection;
    }
    throw BitNetException(ErrorCode::RuntimeUnavailable, "BITNET_RUNTIME_UNAVAILABLE: no supported runtime found");
  }

  if (requested == RuntimeKind::Cpu) {
    if (!capabilities.cpu.available) {
      throw BitNetException(ErrorCode::RuntimeUnavailable, "BITNET_RUNTIME_UNAVAILABLE: CPU runtime is unavailable");
    }
    selection.selected = RuntimeKind::Cpu;
    selection.reason = "CPU runtime selected";
    return selection;
  }

  if (requested == RuntimeKind::Gpu) {
    if (!capabilities.gpu.available) {
      throw BitNetException(
          ErrorCode::RuntimeUnavailable,
          "BITNET_RUNTIME_UNAVAILABLE: GPU runtime is unavailable. " + capabilities.gpu.reason);
    }
    selection.selected = RuntimeKind::Gpu;
    selection.reason = "GPU runtime selected";
    return selection;
  }

  throw BitNetException(ErrorCode::RuntimeUnavailable, "BITNET_RUNTIME_UNAVAILABLE: unknown runtime requested");
}

std::string runtimeKindToString(RuntimeKind runtime) {
  switch (runtime) {
    case RuntimeKind::Auto:
      return "auto";
    case RuntimeKind::Cpu:
      return "cpu";
    case RuntimeKind::Gpu:
      return "gpu";
  }
  return "cpu";
}

RuntimeKind runtimeKindFromString(const std::string & value) {
  if (value.empty()) {
    return RuntimeKind::Cpu;
  }
  if (value == "auto") {
    return RuntimeKind::Auto;
  }
  if (value == "cpu") {
    return RuntimeKind::Cpu;
  }
  if (value == "gpu") {
    return RuntimeKind::Gpu;
  }
  throw BitNetException(ErrorCode::InvalidArgument, "BITNET_INVALID_ARGUMENT: unknown runtime " + value);
}

}  // namespace bitnetrn
