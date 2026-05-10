#pragma once

#include <cstdint>
#include <string>

namespace bitnetrn {

struct ModelCompatibilityReport {
  bool compatible = false;
  std::string reason;
  std::string architecture;
  std::string modelName;
  std::string tokenizerModel;
  std::string tokenizerPre;
  std::string tokenizerPreOverride;
  bool hasTokenizerPre = false;
  std::uint32_t ggufVersion = 0;
  std::uint64_t tensorCount = 0;
};

ModelCompatibilityReport inspectModelCompatibility(const std::string & path);

ModelCompatibilityReport requireBitNetCompatibleModel(const std::string & path);

}  // namespace bitnetrn
