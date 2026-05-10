require "json"
require "pathname"
require "fileutils"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

bitnet_truthy = lambda do |value|
  return false if value.nil?
  normalized = value.to_s.strip.downcase
  ["1", "true", "yes", "on"].include?(normalized)
end

bitnet_find_config = lambda do
  explicit = ENV["BITNET_CONFIG"]
  candidates = []
  candidates << explicit if explicit && !explicit.empty?
  candidates += [
    File.expand_path("../bitnet.config.json", Dir.pwd),
    File.expand_path("../../bitnet.config.json", Dir.pwd),
    File.expand_path("../../../bitnet.config.json", Dir.pwd),
    File.expand_path("bitnet.config.json", Dir.pwd),
    File.expand_path("bitnet.config.json", __dir__),
    File.expand_path("../bitnet.config.json", __dir__),
    File.expand_path("../../bitnet.config.json", __dir__),
    File.expand_path("../../../bitnet.config.json", __dir__),
    File.expand_path("../../../../bitnet.config.json", __dir__)
  ]
  candidates.find { |candidate| File.file?(candidate) }
end

bitnet_resolve = lambda do |config_path, value|
  return nil if value.nil? || value.to_s.empty?
  value = value.to_s
  return value if Pathname.new(value).absolute?
  File.expand_path(value, File.dirname(config_path))
end

bitnet_warn = lambda do |message|
  if defined?(Pod::UI)
    Pod::UI.warn(message)
  else
    warn(message)
  end
end

bitnet_info = lambda do |message|
  if defined?(Pod::UI)
    Pod::UI.puts(message)
  else
    puts(message)
  end
end

bitnet_link_source = lambda do |source, destination|
  raise "[BitNet] Required BitNet.cpp source is missing: #{source}" unless File.file?(source)
  FileUtils.mkdir_p(File.dirname(destination))
  FileUtils.rm_f(destination)
  FileUtils.ln_s(source, destination)
end

Pod::Spec.new do |s|
  s.name         = "BitNet"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.license      = package["license"]
  s.author       = { "BitNet React Native SDK" => "sdk@example.com" }
  s.homepage     = "https://github.com/microsoft/BitNet"
  s.platforms    = { :ios => "13.4" }
  s.source       = { :git => "https://example.com/bitnet-react-native.git", :tag => "#{s.version}" }

  base_source_files = [
    "ios/**/*.{h,m,mm}",
    "cpp/include/**/*.hpp",
    "cpp/src/*.cpp"
  ]

  s.public_header_files = "ios/**/*.h"
  s.requires_arc = true
  s.library = "c++"
  s.dependency "React-Core"
  s.dependency "React-Codegen"
  s.dependency "ReactCommon/turbomodule/core"

  header_paths = [
    "$(PODS_TARGET_SRCROOT)/cpp/include"
  ]

  config_path = bitnet_find_config.call
  config = config_path ? JSON.parse(File.read(config_path)) : {}
  bitnet_info.call("[BitNet] Using config #{config_path}") if config_path

  configured_bitnet_path = bitnet_resolve.call(config_path, config["bitnetPath"]) if config_path
  configured_ios = config["ios"].is_a?(Hash) ? config["ios"] : {}

  configured_ios_libs = []
  if config_path
    raw_ios_libs = configured_ios["bitnetStaticLibs"] || configured_ios["staticLibs"]
    raw_ios_libs = [raw_ios_libs].flatten if raw_ios_libs
    raw_ios_libs ||= [configured_ios["bitnetStaticLib"] || configured_ios["staticLib"]]
    configured_ios_libs = raw_ios_libs.compact.map { |lib| bitnet_resolve.call(config_path, lib) }.compact
  end

  candidate_bitnet_dirs = [
    ENV["BITNET_CPP_DIR"],
    configured_bitnet_path,
    File.expand_path("../third_party/BitNet", Dir.pwd),
    File.expand_path("../../third_party/BitNet", Dir.pwd),
    File.expand_path("../../../third_party/BitNet", Dir.pwd),
    File.expand_path("../BitNet", Dir.pwd),
    File.expand_path("../../BitNet", Dir.pwd),
    File.expand_path("../../../BitNet", Dir.pwd),
    File.expand_path("../third_party/BitNet", __dir__),
    File.expand_path("../../third_party/BitNet", __dir__),
    File.expand_path("../../../third_party/BitNet", __dir__),
    File.expand_path("../../../../third_party/BitNet", __dir__)
  ].compact.uniq

  env_ios_libs = []
  if ENV["BITNET_CPP_IOS_LIBS"] && !ENV["BITNET_CPP_IOS_LIBS"].empty?
    env_ios_libs = ENV["BITNET_CPP_IOS_LIBS"].split(/[,:]/).map(&:strip).reject(&:empty?)
  elsif ENV["BITNET_CPP_IOS_LIB"] && !ENV["BITNET_CPP_IOS_LIB"].empty?
    env_ios_libs = [ENV["BITNET_CPP_IOS_LIB"]]
  end
  bitnet_cpp_ios_libs = env_ios_libs.empty? ? configured_ios_libs : env_ios_libs
  enable_gpu = ENV["ENABLE_GPU"] || config["enableGPU"] || config["enableGpu"]
  enable_stub = ENV["BITNET_RN_ENABLE_STUB"] || config["enableStub"] || config["stub"]

  bitnet_complete = lambda do |candidate|
    File.file?(File.join(candidate, "CMakeLists.txt")) &&
      File.file?(File.join(candidate, "include", "bitnet-lut-kernels.h"))
  end

  bitnet_cpp_dir = candidate_bitnet_dirs.find { |candidate| bitnet_complete.call(candidate) }
  bitnet_incomplete_dir = bitnet_cpp_dir ? nil : candidate_bitnet_dirs.find { |candidate| File.file?(File.join(candidate, "CMakeLists.txt")) }
  unless bitnet_cpp_dir
    if bitnet_incomplete_dir && bitnet_truthy.call(enable_stub)
      bitnet_info.call("[BitNet] BitNet.cpp checkout at #{bitnet_incomplete_dir} is incomplete; using deterministic stub backend.")
    elsif bitnet_incomplete_dir
      bitnet_warn.call("[BitNet] BitNet.cpp checkout at #{bitnet_incomplete_dir} is missing include/bitnet-lut-kernels.h. Run `yarn bitnet:setup --update`, fix bitnet.config.json bitnetPath, or enable the deterministic stub for smoke tests.")
    elsif bitnet_truthy.call(enable_stub)
      bitnet_info.call("[BitNet] BitNet.cpp checkout was not found; using deterministic stub backend.")
    else
      bitnet_warn.call("[BitNet] BitNet.cpp checkout was not found. Set bitnet.config.json bitnetPath, BITNET_CPP_DIR, or BITNET_CONFIG.")
    end
  end

  s.frameworks = "Metal" if bitnet_truthy.call(enable_gpu)

  if bitnet_cpp_dir && !bitnet_cpp_dir.empty?
    header_paths += [
      "#{bitnet_cpp_dir}",
      "#{bitnet_cpp_dir}/include",
      "#{bitnet_cpp_dir}/3rdparty/llama.cpp/include",
      "#{bitnet_cpp_dir}/3rdparty/llama.cpp/common",
      "#{bitnet_cpp_dir}/3rdparty/llama.cpp/src",
      "#{bitnet_cpp_dir}/3rdparty/llama.cpp/ggml/include",
      "#{bitnet_cpp_dir}/3rdparty/llama.cpp/ggml/src"
    ]
  end

  build_bitnet_from_source = bitnet_cpp_dir &&
    !bitnet_cpp_dir.empty? &&
    bitnet_cpp_ios_libs.empty? &&
    !bitnet_truthy.call(enable_stub)

  if build_bitnet_from_source
    bitnet_info.call("[BitNet] Building iOS BitNet.cpp backend from #{bitnet_cpp_dir}.")
    generated_root = File.join(__dir__, "ios", "generated-bitnet-src")
    FileUtils.rm_rf(generated_root)

    generated_sources = [
      ["3rdparty/llama.cpp/src/llama.cpp", "llama/llama.cpp"],
      ["3rdparty/llama.cpp/src/llama-vocab.cpp", "llama/llama-vocab.cpp"],
      ["3rdparty/llama.cpp/src/llama-grammar.cpp", "llama/llama-grammar.cpp"],
      ["3rdparty/llama.cpp/src/llama-sampling.cpp", "llama/llama-sampling.cpp"],
      ["3rdparty/llama.cpp/src/unicode.cpp", "llama/unicode.cpp"],
      ["3rdparty/llama.cpp/src/unicode-data.cpp", "llama/unicode-data.cpp"],
      ["3rdparty/llama.cpp/ggml/src/ggml.c", "ggml/ggml.c"],
      ["3rdparty/llama.cpp/ggml/src/ggml-alloc.c", "ggml/ggml-alloc.c"],
      ["3rdparty/llama.cpp/ggml/src/ggml-backend.cpp", "ggml/ggml-backend.cpp"],
      ["3rdparty/llama.cpp/ggml/src/ggml-quants.c", "ggml/ggml-quants.c"],
      ["3rdparty/llama.cpp/ggml/src/ggml-aarch64.c", "ggml/ggml-aarch64.c"],
      ["src/ggml-bitnet-lut.cpp", "bitnet/ggml-bitnet-lut.cpp"],
      ["src/ggml-bitnet-mad.cpp", "bitnet/ggml-bitnet-mad.cpp"]
    ]
    generated_sources.each do |source, destination|
      bitnet_link_source.call(
        File.join(bitnet_cpp_dir, source),
        File.join(generated_root, destination)
      )
    end

    base_source_files += ["ios/generated-bitnet-src/**/*.{c,cpp}"]
  elsif !bitnet_cpp_ios_libs.empty?
    bitnet_info.call("[BitNet] Linking iOS BitNet.cpp backend libraries: #{bitnet_cpp_ios_libs.join(", ")}.")
    s.vendored_libraries = bitnet_cpp_ios_libs
  end

  s.source_files = base_source_files

  flags = "$(inherited) -fexceptions -frtti"
  flags += " -DBITNET_RN_ENABLE_STUB=1" if bitnet_truthy.call(enable_stub)
  flags += " -DBITNET_RN_ENABLE_GPU=1" if bitnet_truthy.call(enable_gpu)
  has_real_backend = ENV["BITNET_RN_HAS_BITNET"] == "1" ||
    build_bitnet_from_source ||
    (bitnet_cpp_dir && !bitnet_cpp_dir.empty? && !bitnet_cpp_ios_libs.empty?)
  flags += " -DBITNET_RN_HAS_BITNET=1" if has_real_backend
  flags += " -DGGML_BITNET_ARM_TL1=1 -DGGML_USE_CPU=1" if build_bitnet_from_source

  c_flags = "$(inherited)"
  c_flags += " -DGGML_BITNET_ARM_TL1=1 -DGGML_USE_CPU=1" if build_bitnet_from_source

  s.pod_target_xcconfig = {
    "CLANG_CXX_LANGUAGE_STANDARD" => "c++17",
    "CLANG_CXX_LIBRARY" => "libc++",
    "EXCLUDED_ARCHS[sdk=iphonesimulator*]" => "x86_64",
    "HEADER_SEARCH_PATHS" => header_paths.map { |p| "\"#{p}\"" }.join(" "),
    "OTHER_CFLAGS" => c_flags,
    "OTHER_CPLUSPLUSFLAGS" => flags
  }
end
