#include "bitnet_rn/platform_metrics.hpp"

#if defined(__APPLE__)
#include <mach/mach.h>
#elif defined(__ANDROID__) || defined(__linux__)
#include <unistd.h>
#include <cstdio>
#endif

namespace bitnetrn {

std::uint64_t currentMemoryUsageBytes() noexcept {
#if defined(__APPLE__)
  mach_task_basic_info info;
  mach_msg_type_number_t count = MACH_TASK_BASIC_INFO_COUNT;
  if (task_info(mach_task_self(), MACH_TASK_BASIC_INFO, reinterpret_cast<task_info_t>(&info), &count) == KERN_SUCCESS) {
    return static_cast<std::uint64_t>(info.resident_size);
  }
  return 0;
#elif defined(__ANDROID__) || defined(__linux__)
  long rssPages = 0;
  FILE * statm = std::fopen("/proc/self/statm", "r");
  if (statm == nullptr) {
    return 0;
  }
  if (std::fscanf(statm, "%*s %ld", &rssPages) != 1) {
    std::fclose(statm);
    return 0;
  }
  std::fclose(statm);
  const auto pageSize = static_cast<std::uint64_t>(sysconf(_SC_PAGESIZE));
  return static_cast<std::uint64_t>(rssPages) * pageSize;
#else
  return 0;
#endif
}

}  // namespace bitnetrn
