#ifndef LFB_SCANNER_H
#define LFB_SCANNER_H

#include <string>
#include <vector>
#include <memory>
#include <atomic>
#include <functional>
#include "types.h"

namespace lfb {

class Scanner {
public:
    Scanner();
    ~Scanner();

    // Shallow scan - synchronous, fast for single directory
    std::vector<ItemRecord> scanShallow(const std::string& startPath, const std::string& runId);

    // Full recursive scan - async with progress callback
    using ProgressCallback = std::function<void(const ScanProgress&)>;
    ScanResult scanFullAsync(
        const std::string& startPath,
        int depth,
        const std::string& runId,
        std::atomic<bool>& cancelled,
        ProgressCallback progressCb,
        const std::string& skipScannedAfter = ""
    );

    // Get aggregate stats for directory (used internally)
    ScanResult statDirShallow(const std::string& dirPath);

private:
    std::atomic<int> itemsScanned_;
    std::atomic<int> lastProgressUpdate_;
    
    static constexpr int YIELD_INTERVAL = 1000;  // Increased from 200 for better performance
    static constexpr int PROGRESS_INTERVAL = 5000; // Report progress less frequently
    static constexpr int64_t MIN_FILE_SIZE_FOR_DB = 100 * 1024; // 100 KB
};

} // namespace lfb

#endif // LFB_SCANNER_H
