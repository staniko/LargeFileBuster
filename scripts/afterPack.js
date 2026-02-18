// afterPack hook: remove unnecessary Chromium binaries to reduce dist size
const fs = require('fs')
const path = require('path')

/** Files safe to delete for a file-explorer app (no media playback) */
const REMOVE = [
  // 'ffmpeg.dll',                  // audio/video codecs (~3 MB)
  // 'LICENSES.chromium.html',      // ~12 MB, not required at runtime
  // NOTE: d3dcompiler_47.dll is REQUIRED by ANGLE for GPU rendering — do NOT remove
  // NOTE: vk_swiftshader.dll is REQUIRED as GPU fallback on some machines — do NOT remove
]

exports.default = async function afterPack(context) {
  const appDir = context.appOutDir
  let saved = 0

  for (const file of REMOVE) {
    const fp = path.join(appDir, file)
    if (fs.existsSync(fp)) {
      const sz = fs.statSync(fp).size
      fs.unlinkSync(fp)
      saved += sz
      console.log(`  afterPack: removed ${file} (${(sz / 1024 / 1024).toFixed(1)} MB)`)
    }
  }

  console.log(`  afterPack: total saved ${(saved / 1024 / 1024).toFixed(1)} MB`)
}
