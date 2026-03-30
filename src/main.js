const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell } = require('electron')
const path = require('path')
const os = require('os')
const fs = require('fs')
const { exec, execSync } = require('child_process')

// ─── 单实例锁 ────────────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

// ─── 配置持久化 ───────────────────────────────────────────────────────────────
function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json')
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(getConfigPath(), 'utf8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(getConfigPath(), JSON.stringify({
      blocking: state.blocking,
      autoStart: state.autoStart,
    }), 'utf8')
  } catch {}
}

// ─── 全局状态 ────────────────────────────────────────────────────────────────
const state = {
  blocking: false,
  autoStart: false,
  detectedPaths: [],
  log: [],
}

let win = null
let tray = null
let blockInterval = null
let fileWatcher = null

// ─── 目标进程名 ──────────────────────────────────────────────────────────────
const BLOCKED_PROCESSES = [
  'delta_force_launcher',
  'DeltaForce',
  'df_launcher',
  'df_game',
]

// ─── 安装包文件名匹配 ─────────────────────────────────────────────────────────
const INSTALLER_PATTERN = /^deltaforceminiloader.*\.exe$/i

// ─── 监控文件夹 ──────────────────────────────────────────────────────────────
const WATCH_DIRS = [
  path.join(os.homedir(), 'Downloads'),
  path.join(os.homedir(), 'Desktop'),
  path.join(os.homedir(), 'OneDrive', 'Desktop'),
  path.join(os.homedir(), 'OneDrive', 'Downloads'),
  'C:\\Users\\Public\\Downloads',
].filter(p => {
  try { return fs.existsSync(p) } catch { return false }
})

// ─── 日志工具 ─────────────────────────────────────────────────────────────────
function emitLog(msg, type = 'info') {
  const entry = {
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    msg,
    type,
  }
  state.log.unshift(entry)
  if (state.log.length > 300) state.log.pop()
  if (win && !win.isDestroyed()) {
    win.webContents.send('log-entry', entry)
  }
}

function pushState() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('state-change', { ...state, log: [] })
  }
}

// ─── PowerShell 执行工具（写临时文件避免转义问题）────────────────────────────
let _psTmpCounter = 0
function writeTmpPS(script) {
  const tmpFile = path.join(os.tmpdir(), `dfblocker_${process.pid}_${_psTmpCounter++}.ps1`)
  fs.writeFileSync(tmpFile, `\uFEFF${script}`, 'utf8') // BOM 确保 UTF-8
  return tmpFile
}

function runPS(script) {
  return new Promise((resolve) => {
    const tmpFile = writeTmpPS(script)
    exec(
      `powershell -NonInteractive -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`,
      { windowsHide: true },
      (err, stdout) => {
        try { fs.unlinkSync(tmpFile) } catch {}
        resolve({ ok: !err, output: stdout.trim() })
      }
    )
  })
}

function runPSSync(script) {
  const tmpFile = writeTmpPS(script)
  try {
    const out = execSync(
      `powershell -NonInteractive -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`,
      { windowsHide: true }
    ).toString().trim()
    return out
  } catch {
    return ''
  } finally {
    try { fs.unlinkSync(tmpFile) } catch {}
  }
}

// ─── 进程杀手循环 ──────────────────────────────────────────────────────────────
// 注意：KILL_SCRIPT 是多行 PS1 内容，通过临时文件执行，无需压缩为单行
const KILL_SCRIPT = `
$killed = [System.Collections.Generic.List[string]]::new()

# 方式1：按安装路径匹配（最可靠，覆盖所有子进程）
$gamePaths = @(
  'D:\\Delta Force',
  'C:\\Program Files\\Delta Force',
  'C:\\Program Files (x86)\\Delta Force',
  'C:\\Games\\Delta Force'
)
Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
  $proc = $_
  try {
    $procPath = $proc.Path
    if ($procPath) {
      foreach ($gamePath in $gamePaths) {
        if ($procPath.StartsWith($gamePath)) {
          Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
          $killed.Add("$($proc.Name):$($proc.Id)")
          break
        }
      }
    }
  } catch {}
}

# 方式2：按进程名匹配（兜底）
$names = @(${BLOCKED_PROCESSES.map(n => `'${n}'`).join(',')})
foreach ($n in $names) {
  Get-Process -Name $n -ErrorAction SilentlyContinue | ForEach-Object {
    $alreadyKilled = $killed | Where-Object { $_ -like "*:$($_.Id)" }
    if (-not $alreadyKilled) {
      Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
      $killed.Add("$($_.Name):$($_.Id)")
    }
  }
}

# 方式3：模糊名匹配
Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like 'deltaforceminiloader*' -or $_.Name -like 'DeltaForce*' -or $_.Name -like 'delta_force*' } |
  ForEach-Object {
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    $killed.Add("$($_.Name):$($_.Id)")
  }

$killed -join ','
`

async function runKillCycle() {
  const result = await runPS(KILL_SCRIPT)
  if (result.ok && result.output) {
    result.output.split(',').filter(Boolean).forEach(entry => {
      const [name, pid] = entry.split(':')
      emitLog(`[拦截] 已终止进程: ${name} (PID: ${pid})`, 'danger')
    })
    pushState()
  }
}

// ─── 文件监控 ─────────────────────────────────────────────────────────────────
function startFileWatcher() {
  if (fileWatcher) return
  try {
    const chokidar = require('chokidar')
    fileWatcher = chokidar.watch(WATCH_DIRS, {
      ignoreInitial: false,
      depth: 1,
      awaitWriteFinish: {
        stabilityThreshold: 1500,
        pollInterval: 200,
      },
    })
    fileWatcher.on('add', (filePath) => {
      if (!state.blocking) return
      const base = path.basename(filePath)
      if (INSTALLER_PATTERN.test(base)) {
        fs.unlink(filePath, (err) => {
          if (!err) {
            emitLog(`[删除] 安装包已清除: ${base}`, 'danger')
          } else {
            emitLog(`[失败] 无法删除: ${base} — ${err.message}`, 'warn')
          }
          pushState()
        })
      }
    })
    emitLog(`[监控] 正在监控 ${WATCH_DIRS.length} 个文件夹`, 'info')
  } catch (e) {
    emitLog(`[错误] 文件监控启动失败: ${e.message}`, 'warn')
  }
}

function stopFileWatcher() {
  if (fileWatcher) {
    fileWatcher.close()
    fileWatcher = null
  }
}

// ─── 启动屏蔽引擎 ──────────────────────────────────────────────────────────────
function setBlocking(enabled) {
  state.blocking = enabled
  if (enabled) {
    emitLog('[开启] 屏蔽引擎已启动', 'success')
    runKillCycle()
    blockInterval = setInterval(runKillCycle, 3000)
    startFileWatcher()
  } else {
    emitLog('[关闭] 屏蔽引擎已停止', 'info')
    if (blockInterval) {
      clearInterval(blockInterval)
      blockInterval = null
    }
    stopFileWatcher()
  }
  saveConfig()
  rebuildTray()
  pushState()
}

// ─── 开机自启（schtasks.exe，支持管理员权限无弹窗启动）──────────────────────────
const TASK_NAME = 'DeltaForceBlocker'

function setAutoStart(enabled) {
  const exePath = process.execPath
  if (enabled) {
    // schtasks.exe 比 PowerShell cmdlet 更可靠，/rl HIGHEST 需要管理员权限
    const result = runPSSync(`
$out = & schtasks /create /tn "${TASK_NAME}" /tr '"${exePath}"' /sc ONLOGON /rl HIGHEST /f 2>&1
if ($LASTEXITCODE -eq 0) { "OK" } else { "FAIL:" + ($out -join " ") }
`)
    if (result.startsWith('OK')) {
      emitLog('[自启] 任务计划注册成功，下次登录将自动启动', 'success')
    } else {
      emitLog(`[自启] 注册失败: ${result} — 请确认以管理员身份运行`, 'warn')
    }
  } else {
    runPSSync(`schtasks /delete /tn "${TASK_NAME}" /f 2>&1 | Out-Null`)
    emitLog('[自启] 已移除任务计划启动项', 'info')
  }
  state.autoStart = enabled
  saveConfig()
  pushState()
}

function getAutoStartState() {
  const out = runPSSync(
    `$t = Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue; if ($t) { "true" } else { "false" }`
  )
  return out.trim() === 'true'
}

// ─── 游戏路径扫描 ──────────────────────────────────────────────────────────────
const SCAN_SCRIPT = `
$paths = [System.Collections.Generic.List[string]]::new()
$regKeys = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
)
foreach ($key in $regKeys) {
  Get-ChildItem $key -ErrorAction SilentlyContinue | ForEach-Object {
    $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    $name = $props.DisplayName; $loc = $props.InstallLocation
    if ($name -like '*Delta Force*' -or $loc -like '*Delta Force*') {
      if ($loc) { $paths.Add($loc.TrimEnd('\\')) }
    }
  }
}
$hardcoded = @(
  'D:\\Delta Force',
  'C:\\Program Files\\Delta Force',
  'C:\\Program Files (x86)\\Delta Force',
  'C:\\Games\\Delta Force',
  'E:\\Delta Force',
  'F:\\Delta Force'
)
foreach ($p in $hardcoded) {
  if (Test-Path $p) { $paths.Add($p) }
}
($paths | Sort-Object -Unique) -join '|'
`

async function runScan() {
  emitLog('[扫描] 正在搜索游戏安装路径...', 'info')
  const result = await runPS(SCAN_SCRIPT)
  const paths = result.output
    ? result.output.split('|').filter(Boolean)
    : []
  state.detectedPaths = paths
  if (paths.length > 0) {
    emitLog(`[扫描] 发现 ${paths.length} 个安装路径: ${paths.join(', ')}`, 'warn')
  } else {
    emitLog('[扫描] 未检测到游戏安装', 'success')
  }
  pushState()
  return state
}

// ─── 系统托盘 ──────────────────────────────────────────────────────────────────
function createTrayIcon() {
  // 创建一个简单的16x16纯色图标 (红色)
  const size = 16
  const buf = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    const x = i % size
    const y = Math.floor(i / size)
    const offset = i * 4
    // 绘制简单的"禁止"标志：红色圆形背景
    const cx = x - size / 2
    const cy = y - size / 2
    const r = size / 2 - 1
    if (cx * cx + cy * cy <= r * r) {
      buf[offset] = state.blocking ? 192 : 100     // R
      buf[offset + 1] = state.blocking ? 30 : 100  // G
      buf[offset + 2] = state.blocking ? 30 : 100  // B
      buf[offset + 3] = 255                         // A
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size })
}

function rebuildTray() {
  if (!tray) return
  tray.setImage(createTrayIcon())
  tray.setToolTip(state.blocking ? 'Delta Force 屏蔽器 — 屏蔽中' : 'Delta Force 屏蔽器 — 已停止')
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: state.blocking ? '● 屏蔽中' : '○ 已停止',
      enabled: false,
      icon: undefined,
    },
    { type: 'separator' },
    { label: '显示窗口', click: () => { win.show(); win.focus() } },
    {
      label: state.blocking ? '关闭屏蔽' : '开启屏蔽',
      click: () => setBlocking(!state.blocking),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true
        app.quit()
      },
    },
  ]))
}

// ─── 主窗口 ────────────────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 580,
    height: 680,
    minWidth: 480,
    minHeight: 560,
    show: false,
    frame: true,
    title: 'Delta Force 屏蔽器',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  win.once('ready-to-show', () => {
    win.show()
  })

  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })
}

// ─── IPC 处理 ──────────────────────────────────────────────────────────────────
ipcMain.handle('get-initial-state', () => ({ ...state }))

ipcMain.handle('set-blocking', (_e, enabled) => {
  setBlocking(enabled)
  return { ...state }
})

ipcMain.handle('set-autostart', (_e, enabled) => {
  setAutoStart(enabled)
  return { ...state }
})

ipcMain.handle('trigger-scan', async () => {
  await runScan()
  return { ...state }
})

// ─── 应用初始化 ────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // 从配置文件恢复上次状态
  const config = loadConfig()

  createWindow()

  tray = new Tray(createTrayIcon())
  tray.on('double-click', () => { win.show(); win.focus() })

  // 从配置恢复自启状态（UI 显示用），再用任务计划验证实际状态
  state.autoStart = config.autoStart || false
  const taskActuallyExists = getAutoStartState()
  if (state.autoStart && !taskActuallyExists) {
    // 配置显示应该自启，但任务不存在（如重装后），自动重建
    emitLog('[自启] 任务计划丢失，正在重新注册...', 'warn')
    setAutoStart(true)
  } else if (!state.autoStart && taskActuallyExists) {
    // 配置显示关闭但任务还在，清理掉
    setAutoStart(false)
  }

  // 恢复屏蔽状态
  if (config.blocking) {
    emitLog('[启动] 检测到上次屏蔽已开启，自动恢复...', 'info')
    setBlocking(true)
  } else {
    rebuildTray()
  }

  // 启动时扫描
  await runScan()

  emitLog('[启动] 应用已就绪', 'info')
})

app.on('second-instance', () => {
  if (win) { win.show(); win.focus() }
})

app.on('window-all-closed', () => {
  // 不退出，保持托盘运行
})

app.on('before-quit', () => {
  app.isQuitting = true
})
