/**
 * 预构建脚本：手动预置 winCodeSign 缓存
 * 解决 electron-builder 在 Windows 非开发者模式下因符号链接权限报错的问题
 */
const { spawnSync, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const https = require('https')

const SEVEN_ZA = path.join(__dirname, '..', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe')
const CACHE_DIR = path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache', 'winCodeSign', 'winCodeSign-2.6.0')
const DOWNLOAD_URL = 'https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z'
const TEMP_ARCHIVE = path.join(os.tmpdir(), 'winCodeSign-2.6.0.7z')

function log(msg) { console.log(`[prebuild] ${msg}`) }
function err(msg) { console.error(`[prebuild] ✗ ${msg}`) }

// 已有缓存则跳过（实际目录名为 windows-10）
if (fs.existsSync(path.join(CACHE_DIR, 'windows-10'))) {
  log('✓ winCodeSign 缓存已存在，跳过下载')
  process.exit(0)
}

log('未找到 winCodeSign 缓存，开始预置...')

// Step 1: 下载（用 PowerShell 的 Invoke-WebRequest）
if (!fs.existsSync(TEMP_ARCHIVE)) {
  log(`下载 winCodeSign-2.6.0.7z ...`)
  try {
    execSync(
      `powershell -NonInteractive -NoProfile -Command "Invoke-WebRequest -Uri '${DOWNLOAD_URL}' -OutFile '${TEMP_ARCHIVE}' -UseBasicParsing"`,
      { stdio: 'inherit', windowsHide: false }
    )
  } catch (e) {
    err(`下载失败: ${e.message}`)
    process.exit(1)
  }
} else {
  log('✓ 已有临时压缩包，跳过下载')
}

// Step 2: 创建目标目录
fs.mkdirSync(CACHE_DIR, { recursive: true })

// Step 3: 解压时排除 darwin 目录（含 macOS 符号链接），只保留 windows 工具
log(`解压（排除 darwin/）到 ${CACHE_DIR} ...`)
const result = spawnSync(
  SEVEN_ZA,
  ['x', TEMP_ARCHIVE, `-o${CACHE_DIR}`, '-y', '-bd', '-xr!darwin'],
  { encoding: 'utf8', windowsHide: true }
)

const windowsToolsExist = fs.existsSync(path.join(CACHE_DIR, 'windows-10'))

if ((result.status === 0 || result.status === 2) && windowsToolsExist) {
  log('✓ Windows 签名工具解压成功（已跳过 macOS 文件）')
} else {
  err(`解压失败 (exit ${result.status})，windows-10 目录不存在`)
  err(result.stderr || result.stdout || '')
  err('请以管理员身份运行，或开启 Windows 开发者模式（设置 → 系统 → 开发者选项）后重试')
  process.exit(1)
}

// Step 4: 清理临时文件
try { fs.unlinkSync(TEMP_ARCHIVE) } catch {}

log('✓ winCodeSign 缓存预置完成，可以开始打包')
