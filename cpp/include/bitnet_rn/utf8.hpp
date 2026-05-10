#pragma once

#include <cstdint>
#include <string>

namespace bitnetrn {

inline bool isUtf8Continuation(unsigned char value) {
  return (value & 0xc0) == 0x80;
}

inline std::uint32_t nextUtf8CodePointReplacingInvalid(const std::string & value, std::size_t & index) {
  static constexpr std::uint32_t kReplacement = 0xfffd;
  const auto size = value.size();
  const auto lead = static_cast<unsigned char>(value[index]);

  if (lead < 0x80) {
    index += 1;
    return lead;
  }

  std::uint32_t codePoint = 0;
  std::size_t needed = 0;
  std::uint32_t minimum = 0;
  if (lead >= 0xc2 && lead <= 0xdf) {
    codePoint = lead & 0x1f;
    needed = 1;
    minimum = 0x80;
  } else if (lead >= 0xe0 && lead <= 0xef) {
    codePoint = lead & 0x0f;
    needed = 2;
    minimum = 0x800;
  } else if (lead >= 0xf0 && lead <= 0xf4) {
    codePoint = lead & 0x07;
    needed = 3;
    minimum = 0x10000;
  } else {
    index += 1;
    return kReplacement;
  }

  if (index + needed >= size) {
    index += 1;
    return kReplacement;
  }

  for (std::size_t offset = 1; offset <= needed; ++offset) {
    const auto byte = static_cast<unsigned char>(value[index + offset]);
    if (!isUtf8Continuation(byte)) {
      index += 1;
      return kReplacement;
    }
    codePoint = (codePoint << 6) | (byte & 0x3f);
  }

  if (codePoint < minimum || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    index += 1;
    return kReplacement;
  }

  index += needed + 1;
  return codePoint;
}

}  // namespace bitnetrn
