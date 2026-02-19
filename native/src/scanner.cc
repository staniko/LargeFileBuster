#include "scanner.h"
#include <filesystem>
#include <chrono>
#include <algorithm>
#include <iostream>
#include <thread>

#ifdef _WIN32
#include <windows.h>
#else
#include <sys/stat.h>
#include <dirent.h>
#endif

namespace fs = std::filesystem;

namespace lfb {

Scanner::Scanner() : itemsScanned_(0), lastProgressUpdate_(0) {}
Scanner::~Scanner() {}

static std::string toIsoString(int64_t epochMs) {
    auto tp = std::chrono::system_clock::time_point(std::chrono::milliseconds(epochMs));
    auto time = std::chrono::system_clock::to_time_t(tp);
    std::tm tm;
#ifdef _WIN32
    gmtime_s(&tm, &time);
#else
    gmtime_r(&time, &tm);
#endif
    char buf[32];
    strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S", &tm);
    return std::string(buf) + ".000Z";
}

static int64_t fileTimeMs(const fs::file_time_type& ft) {
    auto sctp = std::chrono::time_point_cast<std::chrono::system_clock::duration>(
        ft - fs::file_time_type::clock::now() + std::chrono::system_clock::now()
    );
    return std::chrono::duration_cast<std::chrono::milliseconds>(sctp.time_since_epoch()).count();
}

static std::string getParent(const std::string& path) {
    fs::path p(path);
    if (p.has_parent_path()) {
        auto parent = p.parent_path().string();
        if (parent.empty() || parent == path) return "";
        return parent;
    }
    return "";
}

ScanResult Scanner::statDirShallow(const std::string& dirPath) {
    ScanResult result{0, 0, 0, 0};
    
    try {
        for (const auto& entry : fs::directory_iterator(dirPath, fs::directory_options::skip_permission_denied)) {
            try {
                if (entry.is_regular_file()) {
                    auto size = entry.file_size();
                    result.sizeBytes += size;
                    result.fileCount++;
                    auto lwt = fileTimeMs(entry.last_write_time());
                    result.latestMs = std::max(result.latestMs, lwt);
                } else if (entry.is_directory()) {
                    result.folderCount++;
                }
            } catch (...) {
                // Skip inaccessible entries
            }
        }
    } catch (...) {
        // Skip inaccessible directories
    }
    
    return result;
}

std::vector<ItemRecord> Scanner::scanShallow(const std::string& startPath, const std::string& runId) {
    std::vector<ItemRecord> items;
    
    try {
        int64_t totalSize = 0;
        int totalFiles = 0;
        int totalFolders = 0;
        int64_t latest = 0;

        for (const auto& entry : fs::directory_iterator(startPath, fs::directory_options::skip_permission_denied)) {
            try {
                std::string childPath = entry.path().string();
                
                if (entry.is_regular_file()) {
                    auto size = entry.file_size();
                    auto lwt = fileTimeMs(entry.last_write_time());
                    totalSize += size;
                    totalFiles++;
                    latest = std::max(latest, lwt);
                    
                    ItemRecord rec;
                    rec.path = childPath;
                    rec.parent = startPath;
                    rec.type = "File";
                    rec.sizeBytes = size;
                    rec.fileCount = 1;
                    rec.folderCount = 0;
                    rec.lastWriteUtc = toIsoString(lwt);
                    rec.scannedUtc = "";
                    rec.depth = 1;
                    rec.runId = runId;
                    items.push_back(rec);
                    
                } else if (entry.is_directory()) {
                    auto dirStats = statDirShallow(childPath);
                    totalSize += dirStats.sizeBytes;
                    totalFolders++;
                    latest = std::max(latest, dirStats.latestMs);
                    
                    ItemRecord rec;
                    rec.path = childPath;
                    rec.parent = startPath;
                    rec.type = "Folder";
                    rec.sizeBytes = dirStats.sizeBytes;
                    rec.fileCount = dirStats.fileCount;
                    rec.folderCount = dirStats.folderCount;
                    rec.lastWriteUtc = toIsoString(dirStats.latestMs > 0 ? dirStats.latestMs : 
                        std::chrono::duration_cast<std::chrono::milliseconds>(
                            std::chrono::system_clock::now().time_since_epoch()).count());
                    rec.scannedUtc = "";
                    rec.depth = 1;
                    rec.runId = runId;
                    items.push_back(rec);
                }
            } catch (...) {
                continue;
            }
        }
        
        // Add root folder record
        try {
            auto rootEntry = fs::directory_entry(startPath);
            if (rootEntry.exists()) {
                auto rootLwt = fileTimeMs(rootEntry.last_write_time());
                latest = std::max(latest, rootLwt);
            }
        } catch (...) {}
        
        ItemRecord rootRec;
        rootRec.path = startPath;
        rootRec.parent = getParent(startPath);
        rootRec.type = "Folder";
        rootRec.sizeBytes = totalSize;
        rootRec.fileCount = totalFiles;
        rootRec.folderCount = totalFolders;
        rootRec.lastWriteUtc = toIsoString(latest > 0 ? latest : 
            std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::system_clock::now().time_since_epoch()).count());
        rootRec.scannedUtc = "";
        rootRec.depth = 0;
        rootRec.runId = runId;
        items.push_back(rootRec);
        
    } catch (...) {
        // Return whatever we collected
    }
    
    return items;
}

ScanResult Scanner::scanFullAsync(
    const std::string& startPath,
    int depth,
    const std::string& runId,
    std::atomic<bool>& cancelled,
    ProgressCallback progressCb,
    const std::string& skipScannedAfter
) {
    ScanResult result{0, 0, 0, 0};
    
    if (cancelled.load()) {
        return result;
    }
    
    try {
        std::vector<ItemRecord> batchItems;
        
        for (const auto& entry : fs::directory_iterator(startPath, fs::directory_options::skip_permission_denied)) {
            if (cancelled.load()) {
                break;
            }
            
            try {
                std::string childPath = entry.path().string();
                
                if (entry.is_regular_file()) {
                    auto size = entry.file_size();
                    auto lwt = fileTimeMs(entry.last_write_time());
                    result.sizeBytes += size;
                    result.fileCount++;
                    result.latestMs = std::max(result.latestMs, lwt);
                    
                    itemsScanned_++;
                    
                    // Only store large files
                    if (size >= MIN_FILE_SIZE_FOR_DB) {
                        ItemRecord rec;
                        rec.path = childPath;
                        rec.parent = startPath;
                        rec.type = "File";
                        rec.sizeBytes = size;
                        rec.fileCount = 1;
                        rec.folderCount = 0;
                        rec.lastWriteUtc = toIsoString(lwt);
                        rec.scannedUtc = toIsoString(std::chrono::duration_cast<std::chrono::milliseconds>(
                            std::chrono::system_clock::now().time_since_epoch()).count());
                        rec.depth = depth + 1;
                        rec.runId = runId;
                        batchItems.push_back(rec);
                    }
                    
                } else if (entry.is_directory()) {
                    // TODO: Check skipScannedAfter logic with DB
                    
                    // Recurse
                    auto subResult = scanFullAsync(childPath, depth + 1, runId, cancelled, progressCb, skipScannedAfter);
                    result.sizeBytes += subResult.sizeBytes;
                    result.fileCount += subResult.fileCount;
                    result.folderCount += subResult.folderCount + 1;
                    result.latestMs = std::max(result.latestMs, subResult.latestMs);
                }
                
                // Progress reporting
                int current = itemsScanned_.load();
                int lastUpdate = lastProgressUpdate_.load();
                if (current - lastUpdate >= PROGRESS_INTERVAL) {
                    if (lastProgressUpdate_.compare_exchange_strong(lastUpdate, current)) {
                        ScanProgress progress;
                        progress.runId = runId;
                        progress.itemsScanned = current;
                        progress.currentPath = startPath;
                        progress.state = "running";
                        if (progressCb) {
                            progressCb(progress);
                        }
                    }
                }
                
            } catch (...) {
                continue;
            }
        }
        
        // TODO: Batch persist to database
        // For now, just track items in memory
        
    } catch (...) {
        // Return partial result
    }
    
    return result;
}

} // namespace lfb
