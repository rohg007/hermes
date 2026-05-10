cmake_minimum_required(VERSION 3.22)

project(bitnetrn_web LANGUAGES C CXX)

option(ENABLE_GPU "Enable optional WebGPU build flags." OFF)
set(WASM_PTHREAD_POOL_SIZE "0" CACHE STRING "Reserved for future Emscripten pthread experiments. The production web build is single-threaded WASM.")
set(BITNET_CPP_DIR "" CACHE PATH "Path to a local microsoft/BitNet checkout.")

if(EMSCRIPTEN)
  add_compile_options("-fexceptions")
  # Web inference runs in a dedicated Worker but stays single-threaded in WASM.
  # SIMD improves vector operations, though it remains slower than native NEON.
  add_compile_options("-msimd128")
  add_link_options("-fexceptions")
  add_link_options("-msimd128")
endif()

add_subdirectory("${CMAKE_CURRENT_LIST_DIR}/../cpp" "${CMAKE_CURRENT_BINARY_DIR}/bitnetrn_core")

add_executable(bitnet_wasm cpp/bitnet_wasm_bindings.cpp)
target_compile_features(bitnet_wasm PRIVATE cxx_std_17)
target_include_directories(bitnet_wasm PRIVATE
  "${CMAKE_CURRENT_LIST_DIR}/../cpp/include"
)
target_link_libraries(bitnet_wasm PRIVATE bitnetrn_core embind)

target_link_options(bitnet_wasm PRIVATE
  "-sMODULARIZE=1"
  "-sEXPORT_ES6=1"
  "-sEXPORT_NAME=createBitNetWasmModule"
  "-sENVIRONMENT=worker"
  "-sALLOW_MEMORY_GROWTH=1"
  "-sFILESYSTEM=1"
  "-sEXPORTED_RUNTIME_METHODS=['FS']"
  "-sDISABLE_EXCEPTION_CATCHING=0"
  "-lworkerfs.js"
)

if(NOT WASM_PTHREAD_POOL_SIZE STREQUAL "0")
  message(WARNING "WASM pthreads are intentionally disabled; ignoring WASM_PTHREAD_POOL_SIZE=${WASM_PTHREAD_POOL_SIZE}.")
endif()

if(ENABLE_GPU)
  target_compile_definitions(bitnet_wasm PRIVATE BITNET_RN_ENABLE_WEBGPU=1)
  target_link_options(bitnet_wasm PRIVATE "-sUSE_WEBGPU=1")
endif()
