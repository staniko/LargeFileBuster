{
  "targets": [
    {
      "target_name": "lfb_native",
      "sources": [
        "src/addon.cc",
        "src/scanner.cc",
        "src/database.cc"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "include",
        "deps"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "cflags_cc": [ "-std=c++17", "-O3" ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "conditions": [
        ['OS=="win"', {
          "include_dirs": ["deps"],
          "defines": [
            "SQLITE_ENABLE_COLUMN_METADATA",
            "SQLITE_ENABLE_FTS5",
            "SQLITE_ENABLE_RTREE",
            "SQLITE_THREADSAFE=1"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": [ "/std:c++17" ]
            }
          },
          "conditions": [
            ["<!(python -c \"import os.path; print(1 if os.path.exists('deps/sqlite3.c') else 0)\")==1", {
              "sources": ["deps/sqlite3.c"]
            }, {
              "libraries": ["sqlite3.lib"]
            }]
          ]
        }],
        ['OS!="win"', {
          "libraries": ["-lsqlite3", "-lpthread"],
          "cflags_cc": [ "-fexceptions", "-frtti" ]
        }]
      ]
    }
  ]
}
