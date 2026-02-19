#include <napi.h>
#include "scanner.h"
#include "database.h"
#include <memory>
#include <atomic>
#include <thread>
#include <mutex>
#include <map>
#include <random>
#include <sstream>
#include <iomanip>

using namespace Napi;

// Global database instance
static std::unique_ptr<lfb::Database> globalDb;
static std::string globalDbPath;

// Active scan tracking
struct ActiveScan {
    std::atomic<bool> cancelled{false};
    std::thread thread;
};
static std::map<std::string, std::shared_ptr<ActiveScan>> activeScans;
static std::mutex activeScansMutex;

// Helper to generate UUID (simple version without external dependencies)
std::string generateUUID() {
    static std::random_device rd;
    static std::mt19937_64 gen(rd());
    static std::uniform_int_distribution<uint64_t> dis;
    
    std::ostringstream oss;
    oss << std::hex << std::setfill('0');
    oss << std::setw(8) << (dis(gen) & 0xFFFFFFFF) << "-";
    oss << std::setw(4) << (dis(gen) & 0xFFFF) << "-";
    oss << std::setw(4) << ((dis(gen) & 0x0FFF) | 0x4000) << "-";
    oss << std::setw(4) << ((dis(gen) & 0x3FFF) | 0x8000) << "-";
    oss << std::setw(12) << (dis(gen) & 0xFFFFFFFFFFFF);
    return oss.str();
}

// Helper to convert C++ ItemRecord to JS object
Object itemRecordToJS(const Napi::Env& env, const lfb::ItemRecord& rec) {
    Object obj = Object::New(env);
    obj.Set("path", String::New(env, rec.path));
    obj.Set("parent", rec.parent.empty() ? env.Null() : Value(String::New(env, rec.parent)));
    obj.Set("type", String::New(env, rec.type));
    obj.Set("sizeBytes", Number::New(env, rec.sizeBytes));
    obj.Set("fileCount", Number::New(env, rec.fileCount));
    obj.Set("folderCount", Number::New(env, rec.folderCount));
    obj.Set("lastWriteUtc", String::New(env, rec.lastWriteUtc));
    obj.Set("scannedUtc", String::New(env, rec.scannedUtc));
    obj.Set("depth", Number::New(env, rec.depth));
    obj.Set("runId", String::New(env, rec.runId));
    return obj;
}

// Open/initialize database
Value OpenDatabase(const CallbackInfo& info) {
    Env env = info.Env();
    
    if (info.Length() < 1 || !info[0].IsString()) {
        TypeError::New(env, "Database path required").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    std::string dbPath = info[0].As<String>().Utf8Value();
    
    globalDb = std::make_unique<lfb::Database>(dbPath);
    globalDbPath = dbPath;
    
    if (!globalDb->open()) {
        Error::New(env, "Failed to open database").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    Object result = Object::New(env);
    result.Set("success", Boolean::New(env, true));
    result.Set("dbPath", String::New(env, dbPath));
    return result;
}

// Close database
Value CloseDatabase(const CallbackInfo& info) {
    Env env = info.Env();
    
    if (globalDb) {
        globalDb->close();
        globalDb.reset();
    }
    
    return Boolean::New(env, true);
}

// Reset database
Value ResetDatabase(const CallbackInfo& info) {
    Env env = info.Env();
    
    if (!globalDb) {
        Error::New(env, "Database not open").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    globalDb->reset();
    
    return Boolean::New(env, true);
}

// Upsert items
Value UpsertItems(const CallbackInfo& info) {
    Env env = info.Env();
    
    if (!globalDb) {
        Error::New(env, "Database not open").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    if (info.Length() < 1 || !info[0].IsArray()) {
        TypeError::New(env, "Items array required").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    Array jsItems = info[0].As<Array>();
    std::vector<lfb::ItemRecord> items;
    
    for (uint32_t i = 0; i < jsItems.Length(); i++) {
        Value val = jsItems.Get(i);
        if (!val.IsObject()) continue;
        
        Object obj = val.As<Object>();
        lfb::ItemRecord rec;
        
        rec.path = obj.Get("path").As<String>().Utf8Value();
        Value parentVal = obj.Get("parent");
        rec.parent = parentVal.IsNull() ? "" : parentVal.As<String>().Utf8Value();
        rec.type = obj.Get("type").As<String>().Utf8Value();
        rec.sizeBytes = obj.Get("sizeBytes").As<Number>().Int64Value();
        rec.fileCount = obj.Get("fileCount").As<Number>().Int32Value();
        rec.folderCount = obj.Get("folderCount").As<Number>().Int32Value();
        rec.lastWriteUtc = obj.Get("lastWriteUtc").As<String>().Utf8Value();
        rec.scannedUtc = obj.Get("scannedUtc").As<String>().Utf8Value();
        rec.depth = obj.Get("depth").As<Number>().Int32Value();
        rec.runId = obj.Get("runId").As<String>().Utf8Value();
        
        items.push_back(rec);
    }
    
    globalDb->upsertItems(items);
    
    return Boolean::New(env, true);
}

// Get children
Value GetChildren(const CallbackInfo& info) {
    Env env = info.Env();
    
    if (!globalDb) {
        Error::New(env, "Database not open").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    std::string* parent = nullptr;
    std::string parentStr;
    if (info.Length() >= 1 && info[0].IsString()) {
        parentStr = info[0].As<String>().Utf8Value();
        parent = &parentStr;
    }
    
    int limit = 200;
    if (info.Length() >= 2 && info[1].IsNumber()) {
        limit = info[1].As<Number>().Int32Value();
    }
    
    int offset = 0;
    if (info.Length() >= 3 && info[2].IsNumber()) {
        offset = info[2].As<Number>().Int32Value();
    }
    
    std::string sort = "size_desc";
    if (info.Length() >= 4 && info[3].IsString()) {
        sort = info[3].As<String>().Utf8Value();
    }
    
    bool includeFiles = true;
    if (info.Length() >= 5 && info[4].IsBoolean()) {
        includeFiles = info[4].As<Boolean>().Value();
    }
    
    std::vector<lfb::ItemRecord> results = globalDb->getChildren(parent, limit, offset, sort, includeFiles);
    
    Object response = Object::New(env);
    Array items = Array::New(env, results.size());
    
    for (size_t i = 0; i < results.size(); i++) {
        items.Set(i, itemRecordToJS(env, results[i]));
    }
    
    response.Set("items", items);
    response.Set("total", Number::New(env, results.size()));
    
    return response;
}

// Get item by path
Value GetItemByPath(const CallbackInfo& info) {
    Env env = info.Env();
    
    if (!globalDb) {
        Error::New(env, "Database not open").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    if (info.Length() < 1 || !info[0].IsString()) {
        TypeError::New(env, "Path required").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    std::string path = info[0].As<String>().Utf8Value();
    lfb::ItemRecord* rec = globalDb->getItemByPath(path);
    
    if (!rec) {
        return env.Null();
    }
    
    Object result = itemRecordToJS(env, *rec);
    delete rec;
    
    return result;
}

// Get roots
Value GetRoots(const CallbackInfo& info) {
    Env env = info.Env();
    
    if (!globalDb) {
        Error::New(env, "Database not open").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    int limit = 200;
    if (info.Length() >= 1 && info[0].IsNumber()) {
        limit = info[0].As<Number>().Int32Value();
    }
    
    std::string sort = "size_desc";
    if (info.Length() >= 2 && info[1].IsString()) {
        sort = info[1].As<String>().Utf8Value();
    }
    
    std::vector<lfb::ItemRecord> results = globalDb->getRoots(limit, sort);
    
    Object response = Object::New(env);
    Array items = Array::New(env, results.size());
    
    for (size_t i = 0; i < results.size(); i++) {
        items.Set(i, itemRecordToJS(env, results[i]));
    }
    
    response.Set("items", items);
    response.Set("total", Number::New(env, results.size()));
    
    return response;
}

// Get top items
Value GetTop(const CallbackInfo& info) {
    Env env = info.Env();
    
    if (!globalDb) {
        Error::New(env, "Database not open").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    if (info.Length() < 1 || !info[0].IsString()) {
        TypeError::New(env, "Type required").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    std::string type = info[0].As<String>().Utf8Value();
    
    int limit = 100;
    if (info.Length() >= 2 && info[1].IsNumber()) {
        limit = info[1].As<Number>().Int32Value();
    }
    
    std::vector<lfb::ItemRecord> results = globalDb->getTop(type, limit);
    
    Array items = Array::New(env, results.size());
    for (size_t i = 0; i < results.size(); i++) {
        items.Set(i, itemRecordToJS(env, results[i]));
    }
    
    return items;
}

// Scan shallow (synchronous)
Value ScanShallow(const CallbackInfo& info) {
    Env env = info.Env();
    
    if (info.Length() < 1 || !info[0].IsString()) {
        TypeError::New(env, "Start path required").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    std::string startPath = info[0].As<String>().Utf8Value();
    std::string runId = generateUUID();
    
    lfb::Scanner scanner;
    std::vector<lfb::ItemRecord> items = scanner.scanShallow(startPath, runId);
    
    // Upsert to database
    if (globalDb && !items.empty()) {
        globalDb->upsertItems(items);
    }
    
    return String::New(env, runId);
}

// Module initialization
Object Init(Env env, Object exports) {
    exports.Set("openDatabase", Function::New(env, OpenDatabase));
    exports.Set("closeDatabase", Function::New(env, CloseDatabase));
    exports.Set("resetDatabase", Function::New(env, ResetDatabase));
    exports.Set("upsertItems", Function::New(env, UpsertItems));
    exports.Set("getChildren", Function::New(env, GetChildren));
    exports.Set("getItemByPath", Function::New(env, GetItemByPath));
    exports.Set("getRoots", Function::New(env, GetRoots));
    exports.Set("getTop", Function::New(env, GetTop));
    exports.Set("scanShallow", Function::New(env, ScanShallow));
    
    return exports;
}

NODE_API_MODULE(lfb_native, Init)
