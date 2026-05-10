#pragma once

#include <stdexcept>
#include <string>

namespace bitnetrn {

enum class ErrorCode {
  InvalidArgument,
  ModelNotFound,
  ModelIncompatible,
  RuntimeUnavailable,
  InferenceBusy,
  InferenceCancelled,
  NativeBackendUnavailable,
  Internal
};

class BitNetException : public std::runtime_error {
 public:
  BitNetException(ErrorCode code, const std::string & message)
      : std::runtime_error(message), code_(code) {}

  ErrorCode code() const noexcept { return code_; }

 private:
  ErrorCode code_;
};

const char * errorCodeName(ErrorCode code) noexcept;

}  // namespace bitnetrn
