#ifndef LFB_TYPES_H
#define LFB_TYPES_H

#include <string>
#include <cstdint>
#include <vector>

namespace lfb {

struct ItemRecord {
    std::string path;
    std::string parent;
    std::string type;
    int64_t sizeBytes;
    int fileCount;
    int folderCount;
    std::string lastWriteUtc;
    std::string scannedUtc;
    int depth;
    std::string runId;
};

struct ScanProgress {
    std::string runId;
    int itemsScanned;
    std::string currentPath;
    std::string state;
    std::string message;
};

struct ScanResult {
    int64_t sizeBytes;
    int fileCount;
    int folderCount;
    int64_t latestMs;
};

} // namespace lfb

#endif // LFB_TYPES_H
