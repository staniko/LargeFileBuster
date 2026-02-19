#include "database.h"
#include <iostream>
#include <cstring>
#include <filesystem>

namespace fs = std::filesystem;

namespace lfb {

Database::Database(const std::string& dbPath)
    : dbPath_(dbPath)
    , db_(nullptr)
    , stmtUpsert_(nullptr)
    , stmtGetByPath_(nullptr)
    , stmtGetChildren_(nullptr)
    , stmtGetTop_(nullptr) {
}

Database::~Database() {
    close();
}

bool Database::open() {
    std::lock_guard<std::mutex> lock(mutex_);
    
    if (db_) return true;
    
    // Ensure directory exists
    fs::path dbFilePath(dbPath_);
    if (dbFilePath.has_parent_path()) {
        fs::create_directories(dbFilePath.parent_path());
    }
    
    int rc = sqlite3_open(dbPath_.c_str(), &db_);
    if (rc != SQLITE_OK) {
        std::cerr << "Failed to open database: " << sqlite3_errmsg(db_) << std::endl;
        sqlite3_close(db_);
        db_ = nullptr;
        return false;
    }
    
    // Set performance pragmas
    exec("PRAGMA journal_mode = WAL");           // Write-Ahead Logging for better concurrency
    exec("PRAGMA synchronous = NORMAL");         // Faster, still safe
    exec("PRAGMA cache_size = -64000");          // 64MB cache
    exec("PRAGMA temp_store = MEMORY");          // Temp tables in memory
    exec("PRAGMA mmap_size = 268435456");        // 256MB memory-mapped I/O
    exec("PRAGMA page_size = 4096");             // Optimal page size
    
    createSchema();
    prepareStatements();
    
    return true;
}

void Database::close() {
    std::lock_guard<std::mutex> lock(mutex_);
    
    if (db_) {
        finalizeStatements();
        sqlite3_close(db_);
        db_ = nullptr;
    }
}

void Database::createSchema() {
    const char* schema = R"SQL(
        CREATE TABLE IF NOT EXISTS items (
            path TEXT PRIMARY KEY,
            parent TEXT,
            type TEXT NOT NULL,
            sizeBytes INTEGER NOT NULL,
            fileCount INTEGER NOT NULL,
            folderCount INTEGER NOT NULL,
            lastWriteUtc TEXT NOT NULL,
            scannedUtc TEXT NOT NULL,
            depth INTEGER NOT NULL,
            runId TEXT NOT NULL
        );
        
        CREATE INDEX IF NOT EXISTS idx_items_parent ON items(parent);
        CREATE INDEX IF NOT EXISTS idx_items_size ON items(sizeBytes DESC);
        CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
        CREATE INDEX IF NOT EXISTS idx_items_parent_type ON items(parent, type);
        CREATE INDEX IF NOT EXISTS idx_items_parent_size ON items(parent, sizeBytes DESC);
    )SQL";
    
    exec(schema);
}

void Database::prepareStatements() {
    const char* sqlUpsert = R"SQL(
        INSERT INTO items (path, parent, type, sizeBytes, fileCount, folderCount, lastWriteUtc, scannedUtc, depth, runId)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
            parent=excluded.parent,
            type=excluded.type,
            sizeBytes=excluded.sizeBytes,
            fileCount=excluded.fileCount,
            folderCount=excluded.folderCount,
            lastWriteUtc=excluded.lastWriteUtc,
            scannedUtc=CASE WHEN excluded.scannedUtc = '' THEN items.scannedUtc ELSE excluded.scannedUtc END,
            depth=excluded.depth,
            runId=excluded.runId
    )SQL";
    
    sqlite3_prepare_v2(db_, sqlUpsert, -1, &stmtUpsert_, nullptr);
    
    const char* sqlGetByPath = "SELECT * FROM items WHERE path = ? LIMIT 1";
    sqlite3_prepare_v2(db_, sqlGetByPath, -1, &stmtGetByPath_, nullptr);
}

void Database::finalizeStatements() {
    if (stmtUpsert_) sqlite3_finalize(stmtUpsert_);
    if (stmtGetByPath_) sqlite3_finalize(stmtGetByPath_);
    if (stmtGetChildren_) sqlite3_finalize(stmtGetChildren_);
    if (stmtGetTop_) sqlite3_finalize(stmtGetTop_);
    
    stmtUpsert_ = nullptr;
    stmtGetByPath_ = nullptr;
    stmtGetChildren_ = nullptr;
    stmtGetTop_ = nullptr;
}

bool Database::exec(const std::string& sql) {
    char* errMsg = nullptr;
    int rc = sqlite3_exec(db_, sql.c_str(), nullptr, nullptr, &errMsg);
    if (rc != SQLITE_OK) {
        std::cerr << "SQL error: " << errMsg << std::endl;
        sqlite3_free(errMsg);
        return false;
    }
    return true;
}

void Database::beginTransaction() {
    exec("BEGIN TRANSACTION");
}

void Database::commitTransaction() {
    exec("COMMIT");
}

void Database::rollbackTransaction() {
    exec("ROLLBACK");
}

void Database::upsertItems(const std::vector<ItemRecord>& items) {
    std::lock_guard<std::mutex> lock(mutex_);
    
    if (!db_ || items.empty()) return;
    
    beginTransaction();
    
    for (const auto& item : items) {
        if (item.type != "File" && item.type != "Folder") continue;
        
        sqlite3_reset(stmtUpsert_);
        sqlite3_bind_text(stmtUpsert_, 1, item.path.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(stmtUpsert_, 2, item.parent.empty() ? nullptr : item.parent.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(stmtUpsert_, 3, item.type.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_int64(stmtUpsert_, 4, item.sizeBytes);
        sqlite3_bind_int(stmtUpsert_, 5, item.fileCount);
        sqlite3_bind_int(stmtUpsert_, 6, item.folderCount);
        sqlite3_bind_text(stmtUpsert_, 7, item.lastWriteUtc.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(stmtUpsert_, 8, item.scannedUtc.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_int(stmtUpsert_, 9, item.depth);
        sqlite3_bind_text(stmtUpsert_, 10, item.runId.c_str(), -1, SQLITE_TRANSIENT);
        
        int rc = sqlite3_step(stmtUpsert_);
        if (rc != SQLITE_DONE) {
            std::cerr << "Upsert failed: " << sqlite3_errmsg(db_) << std::endl;
        }
    }
    
    commitTransaction();
}

ItemRecord* Database::getItemByPath(const std::string& path) {
    std::lock_guard<std::mutex> lock(mutex_);
    
    if (!db_) return nullptr;
    
    sqlite3_reset(stmtGetByPath_);
    sqlite3_bind_text(stmtGetByPath_, 1, path.c_str(), -1, SQLITE_TRANSIENT);
    
    if (sqlite3_step(stmtGetByPath_) == SQLITE_ROW) {
        ItemRecord* rec = new ItemRecord();
        rec->path = reinterpret_cast<const char*>(sqlite3_column_text(stmtGetByPath_, 0));
        const char* parent = reinterpret_cast<const char*>(sqlite3_column_text(stmtGetByPath_, 1));
        rec->parent = parent ? parent : "";
        rec->type = reinterpret_cast<const char*>(sqlite3_column_text(stmtGetByPath_, 2));
        rec->sizeBytes = sqlite3_column_int64(stmtGetByPath_, 3);
        rec->fileCount = sqlite3_column_int(stmtGetByPath_, 4);
        rec->folderCount = sqlite3_column_int(stmtGetByPath_, 5);
        rec->lastWriteUtc = reinterpret_cast<const char*>(sqlite3_column_text(stmtGetByPath_, 6));
        rec->scannedUtc = reinterpret_cast<const char*>(sqlite3_column_text(stmtGetByPath_, 7));
        rec->depth = sqlite3_column_int(stmtGetByPath_, 8);
        rec->runId = reinterpret_cast<const char*>(sqlite3_column_text(stmtGetByPath_, 9));
        return rec;
    }
    
    return nullptr;
}

std::vector<ItemRecord> Database::getChildren(
    const std::string* parent,
    int limit,
    int offset,
    const std::string& sort,
    bool includeFiles
) {
    std::lock_guard<std::mutex> lock(mutex_);
    
    std::vector<ItemRecord> results;
    if (!db_) return results;
    
    std::string sortClause = (sort == "name_asc") ? "ORDER BY path ASC" : "ORDER BY sizeBytes DESC";
    std::string typeFilter = includeFiles ? "" : "AND type = 'Folder'";
    std::string whereClause = parent ? "parent = ?" : "parent IS NULL";
    
    std::string sql = "SELECT * FROM items WHERE " + whereClause + " " + typeFilter + " " + sortClause + " LIMIT ? OFFSET ?";
    
    sqlite3_stmt* stmt = nullptr;
    sqlite3_prepare_v2(db_, sql.c_str(), -1, &stmt, nullptr);
    
    int paramIdx = 1;
    if (parent) {
        sqlite3_bind_text(stmt, paramIdx++, parent->c_str(), -1, SQLITE_TRANSIENT);
    }
    sqlite3_bind_int(stmt, paramIdx++, limit);
    sqlite3_bind_int(stmt, paramIdx++, offset);
    
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        ItemRecord rec;
        rec.path = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
        const char* parentPtr = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
        rec.parent = parentPtr ? parentPtr : "";
        rec.type = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 2));
        rec.sizeBytes = sqlite3_column_int64(stmt, 3);
        rec.fileCount = sqlite3_column_int(stmt, 4);
        rec.folderCount = sqlite3_column_int(stmt, 5);
        rec.lastWriteUtc = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 6));
        rec.scannedUtc = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 7));
        rec.depth = sqlite3_column_int(stmt, 8);
        rec.runId = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 9));
        results.push_back(rec);
    }
    
    sqlite3_finalize(stmt);
    return results;
}

std::vector<ItemRecord> Database::getRoots(int limit, const std::string& sort) {
    std::lock_guard<std::mutex> lock(mutex_);
    
    std::vector<ItemRecord> results;
    if (!db_) return results;
    
    std::string sortClause = (sort == "name_asc") ? "ORDER BY path ASC" : "ORDER BY sizeBytes DESC";
    
    std::string sql = R"SQL(
        SELECT * FROM items
        WHERE parent IS NULL
           OR (
             parent NOT IN (SELECT path FROM items)
             AND NOT EXISTS (
               SELECT 1 FROM items r
               WHERE r.parent IS NULL
                 AND items.path LIKE r.path || '%'
             )
           )
    )SQL" + sortClause + " LIMIT ?";
    
    sqlite3_stmt* stmt = nullptr;
    sqlite3_prepare_v2(db_, sql.c_str(), -1, &stmt, nullptr);
    sqlite3_bind_int(stmt, 1, limit);
    
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        ItemRecord rec;
        rec.path = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
        const char* parentPtr = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
        rec.parent = parentPtr ? parentPtr : "";
        rec.type = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 2));
        rec.sizeBytes = sqlite3_column_int64(stmt, 3);
        rec.fileCount = sqlite3_column_int(stmt, 4);
        rec.folderCount = sqlite3_column_int(stmt, 5);
        rec.lastWriteUtc = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 6));
        rec.scannedUtc = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 7));
        rec.depth = sqlite3_column_int(stmt, 8);
        rec.runId = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 9));
        results.push_back(rec);
    }
    
    sqlite3_finalize(stmt);
    return results;
}

std::vector<ItemRecord> Database::getTop(const std::string& type, int limit) {
    std::lock_guard<std::mutex> lock(mutex_);
    
    std::vector<ItemRecord> results;
    if (!db_) return results;
    
    const char* sql = "SELECT * FROM items WHERE type = ? ORDER BY sizeBytes DESC LIMIT ?";
    
    sqlite3_stmt* stmt = nullptr;
    sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr);
    sqlite3_bind_text(stmt, 1, type.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(stmt, 2, limit);
    
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        ItemRecord rec;
        rec.path = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
        const char* parentPtr = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
        rec.parent = parentPtr ? parentPtr : "";
        rec.type = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 2));
        rec.sizeBytes = sqlite3_column_int64(stmt, 3);
        rec.fileCount = sqlite3_column_int(stmt, 4);
        rec.folderCount = sqlite3_column_int(stmt, 5);
        rec.lastWriteUtc = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 6));
        rec.scannedUtc = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 7));
        rec.depth = sqlite3_column_int(stmt, 8);
        rec.runId = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 9));
        results.push_back(rec);
    }
    
    sqlite3_finalize(stmt);
    return results;
}

void Database::reset() {
    std::lock_guard<std::mutex> lock(mutex_);
    
    if (db_) {
        exec("DROP TABLE IF EXISTS items");
        createSchema();
    }
}

void Database::vacuum() {
    std::lock_guard<std::mutex> lock(mutex_);
    
    if (db_) {
        exec("VACUUM");
    }
}

} // namespace lfb
