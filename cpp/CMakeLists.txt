cmake_minimum_required(VERSION 3.22)

project(bitnetrn_core LANGUAGES C CXX)

option(BITNET_RN_ENABLE_STUB "Enable deterministic non-production backend for tests." OFF)
option(ENABLE_GPU "Enable conditional BitNet GPU runtime integration." OFF)
option(BITNET_RN_OPTIMIZE_NATIVE "Use release-style optimization flags for native benchmark builds." ON)
set(BITNET_CPP_DIR "" CACHE PATH "Path to a local microsoft/BitNet checkout.")
set(BITNET_CPP_REQUIRED_HEADER "include/bitnet-lut-kernels.h")

if(BITNET_RN_OPTIMIZE_NATIVE)
  message(STATUS "BitNet RN native optimization enabled")
  string(APPEND CMAKE_C_FLAGS_DEBUG " -O3 -DNDEBUG")
  string(APPEND CMAKE_CXX_FLAGS_DEBUG " -O3 -DNDEBUG")
  string(APPEND CMAKE_C_FLAGS_RELWITHDEBINFO " -O3 -DNDEBUG")
  string(APPEND CMAKE_CXX_FLAGS_RELWITHDEBINFO " -O3 -DNDEBUG")
endif()

set(BITNET_RN_CORE_SOURCES
  src/bitnet_engine.cpp
  src/bitnet_llama_backend.cpp
  src/model_compatibility.cpp
  src/bitnet_test_stub_backend.cpp
  src/native_facade.cpp
  src/platform_metrics.cpp
  src/runtime_selector.cpp
)

add_library(bitnetrn_core STATIC ${BITNET_RN_CORE_SOURCES})
target_compile_features(bitnetrn_core PUBLIC cxx_std_17)
target_include_directories(bitnetrn_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)

if(BITNET_RN_ENABLE_STUB)
  target_compile_definitions(bitnetrn_core PUBLIC BITNET_RN_ENABLE_STUB=1)
endif()

if(ENABLE_GPU)
  target_compile_definitions(bitnetrn_core PUBLIC BITNET_RN_ENABLE_GPU=1)
endif()

if(BITNET_CPP_DIR AND EXISTS "${BITNET_CPP_DIR}/CMakeLists.txt" AND EXISTS "${BITNET_CPP_DIR}/${BITNET_CPP_REQUIRED_HEADER}")
  set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
  set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
  set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
  set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
  if(ANDROID)
    # Match llama.cpp mobile builds: avoid libomp on Android and let ggml use
    # its internal worker pool. This keeps the APK smaller and avoids OpenMP
    # aborts surfacing from worker threads during BitNet decode failures.
    set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
  endif()
  if(ENABLE_GPU AND ANDROID)
    # llama.cpp's Vulkan CMake builds vulkan-shaders-gen for the target ABI.
    # During Android cross-compiles that binary cannot run on the host, so we
    # provide a host-built generator and route CMake's emulator hook to it.
    unset(BITNET_RN_HOST_CXX CACHE)
    set(BITNET_RN_HOST_CXX_FLAGS)
    if(CMAKE_HOST_APPLE)
      set(BITNET_RN_HOST_CXX "/usr/bin/clang++")
      execute_process(
        COMMAND xcrun --sdk macosx --show-sdk-path
        OUTPUT_VARIABLE BITNET_RN_MACOSX_SDK
        OUTPUT_STRIP_TRAILING_WHITESPACE
        ERROR_QUIET
      )
      if(BITNET_RN_MACOSX_SDK)
        list(APPEND BITNET_RN_HOST_CXX_FLAGS -isysroot "${BITNET_RN_MACOSX_SDK}")
      endif()
    endif()
    if(NOT BITNET_RN_HOST_CXX)
      find_program(BITNET_RN_HOST_CXX NAMES clang++ c++ g++ NO_CMAKE_FIND_ROOT_PATH)
    endif()
    if(NOT BITNET_RN_HOST_CXX)
      message(FATAL_ERROR "ENABLE_GPU=ON for Android requires a host C++ compiler to build vulkan-shaders-gen.")
    endif()

    set(BITNET_RN_HOST_TOOLS_DIR "${CMAKE_CURRENT_BINARY_DIR}/host-tools")
    set(BITNET_RN_HOST_VULKAN_SHADERS_GEN "${BITNET_RN_HOST_TOOLS_DIR}/vulkan-shaders-gen")
    set(BITNET_RN_VULKAN_EMULATOR "${BITNET_RN_HOST_TOOLS_DIR}/run-vulkan-shaders-gen.sh")
    file(MAKE_DIRECTORY "${BITNET_RN_HOST_TOOLS_DIR}")
    execute_process(
      COMMAND "${BITNET_RN_HOST_CXX}" -std=c++17 -O2 -pthread
        ${BITNET_RN_HOST_CXX_FLAGS}
        "${BITNET_CPP_DIR}/3rdparty/llama.cpp/ggml/src/vulkan-shaders/vulkan-shaders-gen.cpp"
        -o "${BITNET_RN_HOST_VULKAN_SHADERS_GEN}"
      RESULT_VARIABLE BITNET_RN_HOST_VULKAN_SHADERS_GEN_RESULT
      OUTPUT_VARIABLE BITNET_RN_HOST_VULKAN_SHADERS_GEN_OUTPUT
      ERROR_VARIABLE BITNET_RN_HOST_VULKAN_SHADERS_GEN_ERROR
    )
    if(NOT BITNET_RN_HOST_VULKAN_SHADERS_GEN_RESULT EQUAL 0)
      message(FATAL_ERROR
        "Failed to build host vulkan-shaders-gen: ${BITNET_RN_HOST_VULKAN_SHADERS_GEN_ERROR}"
      )
    endif()
    file(WRITE "${BITNET_RN_VULKAN_EMULATOR}" "#!/bin/sh\nTARGET=\"$1\"\nshift\ncase \"$(basename \"$TARGET\")\" in\n  vulkan-shaders-gen) exec \"${BITNET_RN_HOST_VULKAN_SHADERS_GEN}\" \"$@\" ;;\n  *) exec \"$TARGET\" \"$@\" ;;\nesac\n")
    file(CHMOD "${BITNET_RN_VULKAN_EMULATOR}"
      PERMISSIONS OWNER_READ OWNER_WRITE OWNER_EXECUTE GROUP_READ GROUP_EXECUTE WORLD_READ WORLD_EXECUTE)
    set(CMAKE_CROSSCOMPILING_EMULATOR "${BITNET_RN_VULKAN_EMULATOR}" CACHE STRING "" FORCE)
    set_property(GLOBAL PROPERTY RULE_LAUNCH_CUSTOM
      "${CMAKE_COMMAND} -E env PATH=${BITNET_RN_HOST_TOOLS_DIR}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")

    set(BITNET_RN_ANDROID_GLSLC_CANDIDATES)
    foreach(BITNET_RN_NDK_DIR IN ITEMS "${CMAKE_ANDROID_NDK}" "${ANDROID_NDK}" "$ENV{ANDROID_NDK_HOME}" "$ENV{ANDROID_NDK_ROOT}")
      if(BITNET_RN_NDK_DIR)
        list(APPEND BITNET_RN_ANDROID_GLSLC_CANDIDATES
          "${BITNET_RN_NDK_DIR}/shader-tools/darwin-x86_64/glslc"
          "${BITNET_RN_NDK_DIR}/shader-tools/linux-x86_64/glslc"
          "${BITNET_RN_NDK_DIR}/shader-tools/windows-x86_64/glslc.exe"
        )
      endif()
    endforeach()
    foreach(BITNET_RN_ANDROID_GLSLC_CANDIDATE IN LISTS BITNET_RN_ANDROID_GLSLC_CANDIDATES)
      if(EXISTS "${BITNET_RN_ANDROID_GLSLC_CANDIDATE}")
        set(Vulkan_GLSLC_EXECUTABLE "${BITNET_RN_ANDROID_GLSLC_CANDIDATE}" CACHE FILEPATH "" FORCE)
        break()
      endif()
    endforeach()
    unset(BITNET_RN_VULKAN_HPP_INCLUDE_DIR CACHE)
    foreach(BITNET_RN_VULKAN_HPP_CANDIDATE IN ITEMS /opt/homebrew/include /usr/local/include)
      if(EXISTS "${BITNET_RN_VULKAN_HPP_CANDIDATE}/vulkan/vulkan.hpp")
        set(BITNET_RN_VULKAN_HPP_INCLUDE_DIR "${BITNET_RN_VULKAN_HPP_CANDIDATE}")
        break()
      endif()
    endforeach()
    if(BITNET_RN_VULKAN_HPP_INCLUDE_DIR)
      include_directories(SYSTEM "${BITNET_RN_VULKAN_HPP_INCLUDE_DIR}")
      set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -I${BITNET_RN_VULKAN_HPP_INCLUDE_DIR}")
    endif()

    set(GGML_VULKAN ON CACHE BOOL "" FORCE)
  elseif(ENABLE_GPU AND APPLE)
    set(GGML_METAL ON CACHE BOOL "" FORCE)
  endif()

  add_subdirectory("${BITNET_CPP_DIR}" "${CMAKE_CURRENT_BINARY_DIR}/bitnet.cpp" EXCLUDE_FROM_ALL)

  target_compile_definitions(bitnetrn_core PUBLIC BITNET_RN_HAS_BITNET=1)
  target_include_directories(bitnetrn_core PRIVATE
    "${BITNET_CPP_DIR}"
    "${BITNET_CPP_DIR}/include"
    "${BITNET_CPP_DIR}/3rdparty/llama.cpp/include"
    "${BITNET_CPP_DIR}/3rdparty/llama.cpp/common"
    "${BITNET_CPP_DIR}/3rdparty/llama.cpp/ggml/include"
    "${BITNET_CPP_DIR}/3rdparty/llama.cpp/ggml/src"
  )
  target_link_libraries(bitnetrn_core PUBLIC llama)
elseif(BITNET_CPP_DIR AND EXISTS "${BITNET_CPP_DIR}/CMakeLists.txt")
  set(BITNET_CPP_INCOMPLETE_MESSAGE
      "BitNet.cpp checkout at ${BITNET_CPP_DIR} is missing ${BITNET_CPP_REQUIRED_HEADER}. Run yarn bitnet:init --update, or build with BITNET_RN_ENABLE_STUB=ON for smoke tests.")
  if(BITNET_RN_ENABLE_STUB)
    message(WARNING "${BITNET_CPP_INCOMPLETE_MESSAGE} Falling back to the deterministic stub backend.")
  else()
    message(FATAL_ERROR "${BITNET_CPP_INCOMPLETE_MESSAGE}")
  endif()
endif()

if(ANDROID)
  target_compile_definitions(bitnetrn_core PUBLIC BITNET_RN_PLATFORM_ANDROID=1)
elseif(APPLE)
  target_compile_definitions(bitnetrn_core PUBLIC BITNET_RN_PLATFORM_APPLE=1)
endif()

find_package(Threads REQUIRED)
target_link_libraries(bitnetrn_core PUBLIC Threads::Threads)
