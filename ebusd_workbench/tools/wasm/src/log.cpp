// Replacement of lib/utils/log.cpp for the WebAssembly build: plain text on stderr, no syslog/files.
#include "lib/utils/log.h"
#include <cstdarg>
#include <cstdio>
#include <cstring>

namespace ebusd {

static const char* facilityNames[] = {"main", "network", "bus", "device", "update", "other", nullptr};
static const char* levelNames[] = {"none", "error", "notice", "info", "debug", nullptr};
static LogLevel s_levels[lf_COUNT] = {ll_notice, ll_notice, ll_notice, ll_notice, ll_notice, ll_notice};

LogFacility parseLogFacility(const char* facility) {
  for (int i = 0; facilityNames[i]; i++) if (strcmp(facility, facilityNames[i]) == 0) return (LogFacility)i;
  return lf_COUNT;
}
int parseLogFacilities(const char* facilities) {
  if (strcmp(facilities, "all") == 0) return (1 << lf_COUNT) - 1;
  LogFacility f = parseLogFacility(facilities);
  return f == lf_COUNT ? -1 : (1 << f);
}
const char* getLogFacilityStr(LogFacility facility) { return facility < lf_COUNT ? facilityNames[facility] : "?"; }
LogLevel parseLogLevel(const char* level) {
  for (int i = 0; levelNames[i]; i++) if (strcmp(level, levelNames[i]) == 0) return (LogLevel)i;
  return ll_COUNT;
}
const char* getLogLevelStr(LogLevel level) { return level < ll_COUNT ? levelNames[level] : "?"; }
bool setFacilitiesLogLevel(int facilities, LogLevel level) {
  for (int i = 0; i < lf_COUNT; i++) if (facilities & (1 << i)) s_levels[i] = level;
  return true;
}
LogLevel getFacilityLogLevel(LogFacility facility) { return facility < lf_COUNT ? s_levels[facility] : ll_none; }
bool setLogFile(const char*) { return true; }
void closeLogFile() {}
bool needsLog(const LogFacility facility, const LogLevel level) {
  return facility < lf_COUNT && s_levels[facility] >= level;
}
static void write(const char* facility, LogLevel level, const char* message, va_list ap) {
  fprintf(stderr, "[%s %s] ", facility, getLogLevelStr(level));
  vfprintf(stderr, message, ap);
  fputc('\n', stderr);
}
void logWrite(const LogFacility facility, const LogLevel level, const char* message, ...) {
  va_list ap;
  va_start(ap, message);
  write(getLogFacilityStr(facility), level, message, ap);
  va_end(ap);
}
void logWrite(const char* facility, const LogLevel level, const char* message, ...) {
  va_list ap;
  va_start(ap, message);
  write(facility, level, message, ap);
  va_end(ap);
}

}  // namespace ebusd
