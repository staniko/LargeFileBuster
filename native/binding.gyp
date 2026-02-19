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
        "include"
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
          "libraries": ["-lsqlite3"],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": [ "/std:c++17" ]
            }
          }
        }],
        ['OS!="win"', {
          "libraries": ["-lsqlite3", "-lpthread"],
          "cflags_cc": [ "-fexceptions", "-frtti" ]
        }]
      ]
    }
  ]
}
