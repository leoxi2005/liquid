{
  "targets": [
    {
      "target_name": "spout_addon",
      "conditions": [
        ["OS=='win'", {
          "sources": [
            "addon.cc",
            "vendor/SPOUTSDK/SpoutDirectX/SpoutDX/SpoutDX.cpp",
            "vendor/SPOUTSDK/SpoutGL/SpoutCopy.cpp",
            "vendor/SPOUTSDK/SpoutGL/SpoutDirectX.cpp",
            "vendor/SPOUTSDK/SpoutGL/SpoutFrameCount.cpp",
            "vendor/SPOUTSDK/SpoutGL/SpoutSenderNames.cpp",
            "vendor/SPOUTSDK/SpoutGL/SpoutSharedMemory.cpp",
            "vendor/SPOUTSDK/SpoutGL/SpoutUtils.cpp"
          ],
          "include_dirs": [
            "<!(node -p \"require('node-addon-api').include_dir\")",
            "vendor/SPOUTSDK/SpoutGL",
            "vendor/SPOUTSDK/SpoutDirectX/SpoutDX"
          ],
          "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "NOMINMAX"],
          "libraries": [
            "d3d11.lib",
            "dxgi.lib",
            "version.lib",
            "shell32.lib",
            "advapi32.lib",
            "user32.lib",
            "gdi32.lib",
            "shlwapi.lib",
            "winmm.lib"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": ["/std:c++17", "/utf-8"]
            }
          }
        }]
      ]
    }
  ]
}
