#ifndef LFB_DATABASE_H
#define LFB_DATABASE_H

#include <string>
#include <vector>
#include <memory>
#include <mutex>
#include <sqlite3.h>
#include "types.h"

namespace lfb {

class Database {
public:
    explicit Database(const std::string& dbPath);
    ~Database();

    // Database operations
    bool open();
    void close();
    bool isOpen() const { return db_ != nullptr; }
    
    // Item operations
    void upsertItems(const std::vector<ItemRecord>& items);
    std::vector<ItemRecord> getChildren(
        const std::string* parent,
        int limit = 200,
        int offset = 0,
        const std::string& sort = "size_desc",
        bool includeFiles = true
    );
    std::vector<ItemRecord> getRoots(int limit = 200, const std::string& sort = "size_desc");
    std::vector<ItemRecord> getTop(const std::string& type, int limit = 100);
    ItemRecord* getItemByPath(const std::string& path);
    
    // Database management
    void reset();
    void vacuum();
    void beginTransaction();
    void commitTransaction();
    void rollbackTransaction();

private:
    std::string dbPath_;
    sqlite3* db_;
    std::mutex mutex_;
    
    // Prepared statements (cached for performance)
    sqlite3_stmt* stmtUpsert_;
    sqlite3_stmt* stmtGetByPath_;
    sqlite3_stmt* stmtGetChildren_;
    sqlite3_stmt* stmtGetTop_;
    
    void createSchema();
    void prepareStatements();
    void finalizeStatements();
    bool exec(const std::string& sql);
};

} // namespace lfb

#endif // LFB_DATABASE_H
