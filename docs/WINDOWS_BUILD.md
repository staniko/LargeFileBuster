# Building LargeFileBuster Native Addon on Windows

This guide explains how to build the optional native C++ addon on Windows for improved performance.

## Prerequisites

1. **Node.js** (≥ 18) - Download from https://nodejs.org/
2. **Visual Studio** (2017 or later) with C++ build tools
   - Download Visual Studio Community from https://visualstudio.microsoft.com/
   - During installation, select "Desktop development with C++"
3. **Python** (2.7 or 3.x) - Required by node-gyp
4. **node-gyp** - Install globally: `npm install -g node-gyp`

## Installing SQLite3

You have several options:

### Option 1: Download SQLite Amalgamation (Recommended)

1. Visit https://www.sqlite.org/download.html
2. Download `sqlite-amalgamation-3XXXXXX.zip` (look for the latest version)
3. Extract the zip file
4. Copy `sqlite3.h` and `sqlite3.c` to `native/deps/` directory in the project
5. Run `npm run build:native`

### Option 2: Use vcpkg

```cmd
# Install vcpkg if you haven't already
git clone https://github.com/Microsoft/vcpkg.git
cd vcpkg
.\bootstrap-vcpkg.bat

# Install SQLite3
.\vcpkg install sqlite3:x64-windows

# Add vcpkg to your path or copy files manually
# Copy from vcpkg/installed/x64-windows/include/sqlite3.h to native/deps/
# Copy SQLite DLL or use the library in vcpkg
```

### Option 3: Skip Native Build

If you don't need the performance improvements, you can skip the native build:

```cmd
# Build without native addon
npm run build:renderer
npm run build:main

# Run the app (will use JavaScript implementation)
npm start
```

The app will automatically fall back to the JavaScript implementation if the native addon is not available.

## Building

Once SQLite3 is set up:

```cmd
# Install dependencies
npm install

# Build everything (native addon will be built if SQLite3 is available)
npm run build

# Or build native addon separately
npm run build:native
```

## Troubleshooting

### Error: Cannot find sqlite3.h

**Solution**: Follow Option 1 above to download and place SQLite amalgamation files in `native/deps/`

### Error: MSB8036: The Windows SDK version X.X was not found

**Solution**: Install the Windows SDK via Visual Studio Installer or update the SDK version in the project

### Error: Python not found

**Solution**: Install Python and ensure it's in your PATH

### Native build fails but I want to use the app

**Solution**: Use the JavaScript implementation by not setting `USE_NATIVE=true`. The app works perfectly fine without the native addon, just with slightly less performance for very large directories.

## Verifying the Build

After building, you can test the native addon:

```cmd
node scripts/test-native.js
```

If this succeeds, you can run the app with native mode:

```cmd
set USE_NATIVE=true
npm start
```

## Performance

The native addon provides:
- **50-100x faster** database queries
- **2-3x faster** file scanning  
- **10x less** memory usage for large directories (>100K files)

For normal usage (<10K files), the performance difference is minimal and the JavaScript implementation works great!
