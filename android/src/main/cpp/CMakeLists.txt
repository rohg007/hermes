cmake_minimum_required(VERSION 3.22)

project(bitnetrn_android LANGUAGES C CXX)

add_subdirectory(
  "${CMAKE_CURRENT_LIST_DIR}/../../../../cpp"
  "${CMAKE_CURRENT_BINARY_DIR}/bitnetrn_core"
)

add_library(bitnetrn SHARED bitnet_jni.cpp)
target_compile_features(bitnetrn PRIVATE cxx_std_17)
target_include_directories(bitnetrn PRIVATE
  "${CMAKE_CURRENT_LIST_DIR}/../../../../cpp/include"
)
target_link_libraries(bitnetrn
  bitnetrn_core
  android
  dl
  log
)
