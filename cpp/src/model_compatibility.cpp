#include "bitnet_rn/model_compatibility.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <limits>
#include <sstream>
#include <unordered_map>

#include "bitnet_rn/errors.hpp"

namespace bitnetrn {

namespace {

constexpr std::uint64_t kMaxMetadataStringBytes = 1024 * 1024;
constexpr std::uint64_t kMaxMetadataArrayElements = 1024 * 1024;
constexpr std::uint32_t kGgufTypeUint8 = 0;
constexpr std::uint32_t kGgufTypeInt8 = 1;
constexpr std::uint32_t kGgufTypeUint16 = 2;
constexpr std::uint32_t kGgufTypeInt16 = 3;
constexpr std::uint32_t kGgufTypeUint32 = 4;
constexpr std::uint32_t kGgufTypeInt32 = 5;
constexpr std::uint32_t kGgufTypeFloat32 = 6;
constexpr std::uint32_t kGgufTypeBool = 7;
constexpr std::uint32_t kGgufTypeString = 8;
constexpr std::uint32_t kGgufTypeArray = 9;
constexpr std::uint32_t kGgufTypeUint64 = 10;
constexpr std::uint32_t kGgufTypeInt64 = 11;
constexpr std::uint32_t kGgufTypeFloat64 = 12;

struct MetadataValue {
  std::string stringValue;
  std::uint64_t uintValue = 0;
  bool hasString = false;
  bool hasUint = false;
};

template <typename T>
T readScalar(std::ifstream & in, const std::string & label) {
  T value{};
  in.read(reinterpret_cast<char *>(&value), sizeof(T));
  if (!in) {
    throw BitNetException(ErrorCode::ModelIncompatible, "truncated GGUF while reading " + label);
  }
  return value;
}

std::string readString(std::ifstream & in, const std::string & label) {
  const auto length = readScalar<std::uint64_t>(in, label + " length");
  if (length > kMaxMetadataStringBytes) {
    throw BitNetException(ErrorCode::ModelIncompatible, "GGUF " + label + " is unreasonably large");
  }

  std::string value(static_cast<std::size_t>(length), '\0');
  if (length > 0) {
    in.read(value.data(), static_cast<std::streamsize>(length));
    if (!in) {
      throw BitNetException(ErrorCode::ModelIncompatible, "truncated GGUF while reading " + label);
    }
  }
  return value;
}

void skipBytes(std::ifstream & in, std::uint64_t bytes, const std::string & label) {
  if (bytes > static_cast<std::uint64_t>(std::numeric_limits<std::streamoff>::max())) {
    throw BitNetException(ErrorCode::ModelIncompatible, "GGUF " + label + " is too large");
  }
  in.seekg(static_cast<std::streamoff>(bytes), std::ios::cur);
  if (!in) {
    throw BitNetException(ErrorCode::ModelIncompatible, "truncated GGUF while skipping " + label);
  }
}

std::uint64_t scalarSize(std::uint32_t type) {
  switch (type) {
    case kGgufTypeUint8:
    case kGgufTypeInt8:
    case kGgufTypeBool:
      return 1;
    case kGgufTypeUint16:
    case kGgufTypeInt16:
      return 2;
    case kGgufTypeUint32:
    case kGgufTypeInt32:
    case kGgufTypeFloat32:
      return 4;
    case kGgufTypeUint64:
    case kGgufTypeInt64:
    case kGgufTypeFloat64:
      return 8;
    default:
      throw BitNetException(ErrorCode::ModelIncompatible, "unsupported GGUF metadata value type");
  }
}

void skipArray(std::ifstream & in) {
  const auto elementType = readScalar<std::uint32_t>(in, "GGUF array element type");
  const auto count = readScalar<std::uint64_t>(in, "GGUF array element count");
  if (count > kMaxMetadataArrayElements) {
    throw BitNetException(ErrorCode::ModelIncompatible, "GGUF metadata array is unreasonably large");
  }

  if (elementType == kGgufTypeString) {
    for (std::uint64_t i = 0; i < count; ++i) {
      (void)readString(in, "GGUF string array value");
    }
    return;
  }
  if (elementType == kGgufTypeArray) {
    for (std::uint64_t i = 0; i < count; ++i) {
      skipArray(in);
    }
    return;
  }

  skipBytes(in, scalarSize(elementType) * count, "GGUF metadata array");
}

MetadataValue readMetadataValue(std::ifstream & in, std::uint32_t type) {
  MetadataValue value;
  switch (type) {
    case kGgufTypeString:
      value.stringValue = readString(in, "GGUF metadata string");
      value.hasString = true;
      return value;
    case kGgufTypeUint8:
      value.uintValue = readScalar<std::uint8_t>(in, "GGUF metadata uint8");
      value.hasUint = true;
      return value;
    case kGgufTypeUint16:
      value.uintValue = readScalar<std::uint16_t>(in, "GGUF metadata uint16");
      value.hasUint = true;
      return value;
    case kGgufTypeUint32:
      value.uintValue = readScalar<std::uint32_t>(in, "GGUF metadata uint32");
      value.hasUint = true;
      return value;
    case kGgufTypeUint64:
      value.uintValue = readScalar<std::uint64_t>(in, "GGUF metadata uint64");
      value.hasUint = true;
      return value;
    case kGgufTypeInt8:
    case kGgufTypeInt16:
    case kGgufTypeInt32:
    case kGgufTypeInt64:
    case kGgufTypeFloat32:
    case kGgufTypeFloat64:
    case kGgufTypeBool:
      skipBytes(in, scalarSize(type), "GGUF metadata scalar");
      return value;
    case kGgufTypeArray:
      skipArray(in);
      return value;
    default:
      throw BitNetException(ErrorCode::ModelIncompatible, "unsupported GGUF metadata value type");
  }
}

std::string lower(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return value;
}

std::string metadataString(const std::unordered_map<std::string, MetadataValue> & metadata, const std::string & key) {
  const auto value = metadata.find(key);
  if (value == metadata.end() || !value->second.hasString) {
    return "";
  }
  return value->second.stringValue;
}

bool hasNonEmptyStringMetadata(const std::unordered_map<std::string, MetadataValue> & metadata,
                               const std::string & key) {
  const auto value = metadata.find(key);
  if (value == metadata.end() || !value->second.hasString) {
    return false;
  }
  return std::any_of(value->second.stringValue.begin(), value->second.stringValue.end(), [](unsigned char ch) {
    return !std::isspace(ch);
  });
}

bool contains(const std::string & value, const std::string & needle) {
  return value.find(needle) != std::string::npos;
}

bool isKnownMicrosoftBitNetModel(const ModelCompatibilityReport & report, const std::string & path) {
  const auto arch = lower(report.architecture);
  const auto name = lower(report.modelName);
  const auto file = lower(std::filesystem::path(path).filename().string());
  return arch == "bitnet-b1.58" || name == "bitnet2b" || contains(name, "bitnet-b1.58-2b-4t") ||
      file == "ggml-model-i2_s.gguf";
}

void applyCompatibilityRules(ModelCompatibilityReport & report, const std::string & path) {
  const auto arch = lower(report.architecture);
  const auto name = lower(report.modelName);
  const auto file = lower(std::filesystem::path(path).filename().string());
  const auto tokenizerModel = lower(report.tokenizerModel);
  const auto detected = arch + " " + name + " " + file;

  if (!contains(detected, "bitnet")) {
    report.compatible = false;
    report.reason =
        "Only BitNet GGUF models are supported. Use microsoft/BitNet-b1.58-2B-4T-gguf with ggml-model-i2_s.gguf.";
    return;
  }

  if (tokenizerModel == "gpt2" && !report.hasTokenizerPre) {
    if (isKnownMicrosoftBitNetModel(report, path)) {
      report.tokenizerPreOverride = "llama3";
    } else {
      report.compatible = false;
      report.reason =
          "BitNet GGUF is missing tokenizer.ggml.pre metadata. Use microsoft/BitNet-b1.58-2B-4T-gguf or regenerate the model with current BitNet.cpp tools.";
      return;
    }
  }

  report.compatible = true;
  report.reason = "BitNet GGUF metadata detected.";
}

std::string reportDetails(const ModelCompatibilityReport & report) {
  std::ostringstream out;
  if (!report.modelName.empty()) {
    out << " model=" << report.modelName << ".";
  }
  if (!report.architecture.empty()) {
    out << " architecture=" << report.architecture << ".";
  }
  if (!report.tokenizerModel.empty()) {
    out << " tokenizer=" << report.tokenizerModel << ".";
  }
  return out.str();
}

}  // namespace

ModelCompatibilityReport inspectModelCompatibility(const std::string & path) {
  if (!std::filesystem::exists(path)) {
    throw BitNetException(ErrorCode::ModelNotFound, "BITNET_MODEL_NOT_FOUND: " + path);
  }
  if (!std::filesystem::is_regular_file(path)) {
    throw BitNetException(ErrorCode::ModelIncompatible, "BITNET_MODEL_INCOMPATIBLE: model path is not a file");
  }

  std::ifstream in(path, std::ios::binary);
  if (!in) {
    throw BitNetException(ErrorCode::ModelIncompatible, "unable to open model file " + path);
  }

  std::array<char, 4> magic{};
  in.read(magic.data(), static_cast<std::streamsize>(magic.size()));
  if (!in || magic[0] != 'G' || magic[1] != 'G' || magic[2] != 'U' || magic[3] != 'F') {
    ModelCompatibilityReport report;
    report.compatible = false;
    report.reason = "Model file is not a GGUF file. BitNet.cpp requires a BitNet GGUF model.";
    return report;
  }

  ModelCompatibilityReport report;
  report.ggufVersion = readScalar<std::uint32_t>(in, "GGUF version");
  if (report.ggufVersion < 2 || report.ggufVersion > 3) {
    report.compatible = false;
    report.reason = "Unsupported GGUF version " + std::to_string(report.ggufVersion) + ". Expected GGUF v2 or v3.";
    return report;
  }

  report.tensorCount = readScalar<std::uint64_t>(in, "GGUF tensor count");
  const auto metadataCount = readScalar<std::uint64_t>(in, "GGUF metadata count");
  if (report.tensorCount == 0) {
    report.compatible = false;
    report.reason = "GGUF contains no tensors.";
    return report;
  }

  std::unordered_map<std::string, MetadataValue> metadata;
  for (std::uint64_t i = 0; i < metadataCount; ++i) {
    const auto key = readString(in, "GGUF metadata key");
    const auto type = readScalar<std::uint32_t>(in, "GGUF metadata type");
    auto value = readMetadataValue(in, type);
    if (value.hasString || value.hasUint) {
      metadata.emplace(key, std::move(value));
    }
  }

  report.architecture = metadataString(metadata, "general.architecture");
  report.modelName = metadataString(metadata, "general.name");
  report.tokenizerModel = metadataString(metadata, "tokenizer.ggml.model");
  report.tokenizerPre = metadataString(metadata, "tokenizer.ggml.pre");
  report.hasTokenizerPre = hasNonEmptyStringMetadata(metadata, "tokenizer.ggml.pre");

  applyCompatibilityRules(report, path);
  return report;
}

ModelCompatibilityReport requireBitNetCompatibleModel(const std::string & path) {
  auto report = inspectModelCompatibility(path);
  if (report.compatible) {
    return report;
  }

  throw BitNetException(ErrorCode::ModelIncompatible, report.reason + reportDetails(report));
}

}  // namespace bitnetrn
