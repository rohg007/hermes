#include "bitnet_rn/backend.hpp"

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <memory>
#include <sstream>
#include <thread>
#include <vector>

#include "bitnet_rn/errors.hpp"

namespace bitnetrn {

namespace {

class TestStubBackend final : public IBitNetBackend {
 public:
  void load(const ModelLoadOptions & options) override {
    if (!std::filesystem::exists(options.path)) {
      throw BitNetException(ErrorCode::ModelNotFound, "BITNET_MODEL_NOT_FOUND: " + options.path);
    }
    modelPath_ = options.path;
  }

  void unload() noexcept override {
    modelPath_.clear();
  }

  void cancel() noexcept override {}

  std::int32_t generate(const GenerationParams & params,
                        const std::atomic_bool & cancelled,
                        const TokenCallback & onToken) override {
    std::vector<std::string> pieces = {
        "BitNet ", "test ", "backend ", "is ", "active. ",
        "Link ", "microsoft/BitNet ", "for ", "real ", "inference."};

    const auto limit = std::min<std::size_t>(pieces.size(), static_cast<std::size_t>(params.maxTokens));
    for (std::size_t i = 0; i < limit; ++i) {
      if (cancelled.load()) {
        return -1;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(12));
      if (!onToken(pieces[i])) {
        return -1;
      }
    }
    return -1;
  }

 private:
  std::string modelPath_;
};

}  // namespace

std::unique_ptr<IBitNetBackend> createTestStubBackend() {
  return std::make_unique<TestStubBackend>();
}

}  // namespace bitnetrn
