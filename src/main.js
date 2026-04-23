const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, dialog } = require('electron')
const path = require('path')
const os = require('os')
const fs = require('fs')
const { exec, execSync } = require('child_process')
const crypto = require('crypto')

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
      watchdog: state.watchdog,
      passwordHash: state.passwordHash,
      passwordEnabled: state.passwordEnabled,
      schedule: state.schedule,
      scheduleEnabled: state.scheduleEnabled,
    }), 'utf8')
  } catch {}
}

function hashPassword(pwd) {
  return crypto.createHash('sha256').update(pwd + 'dfblocker_salt_2024').digest('hex')
}

// ─── 全局状态 ────────────────────────────────────────────────────────────────
const state = {
  blocking: false,
  autoStart: false,
  watchdog: false,
  detectedPaths: [],
  log: [],
  // 密码保护
  passwordEnabled: false,
  passwordHash: null,
  // 时间计划
  scheduleEnabled: false,
  // schedule: 每天的允许时段数组，格式 [{start:'09:00', end:'12:00'}, ...]
  // 结构: { mon:[], tue:[], wed:[], thu:[], fri:[], sat:[], sun:[] }
  schedule: {
    mon: [], tue: [], wed: [], thu: [], fri: [],
    sat: [], sun: [],
  },
  // 计划是否当前强制开启了屏蔽
  scheduleBlocking: false,
}

let win = null
let tray = null
let blockInterval = null
let fileWatcher = null
let scheduleTimer = null

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

// ─── 时间计划引擎 ─────────────────────────────────────────────────────────────
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

function isInAllowedWindow() {
  const now = new Date()
  const dayKey = DAY_KEYS[now.getDay()]
  const slots = (state.schedule[dayKey] || [])
  if (slots.length === 0) return false  // 没有配置时段 = 全天不允许
  const cur = now.getHours() * 60 + now.getMinutes()
  return slots.some(s => {
    const start = timeToMinutes(s.start)
    const end   = timeToMinutes(s.end)
    return cur >= start && cur < end
  })
}

function scheduleCheck() {
  if (!state.scheduleEnabled) return
  const allowed = isInAllowedWindow()
  if (!allowed && !state.blocking) {
    // 不在允许时段，且屏蔽未开启 → 自动开启
    state.scheduleBlocking = true
    emitLog('[计划] 当前不在允许时段，自动开启屏蔽', 'warn')
    setBlocking(true)
  } else if (allowed && state.scheduleBlocking && state.blocking) {
    // 进入允许时段，且是计划强制开启的 → 自动关闭
    state.scheduleBlocking = false
    emitLog('[计划] 进入允许时段，自动关闭屏蔽', 'success')
    setBlocking(false)
  }
}

function startScheduleTimer() {
  if (scheduleTimer) clearInterval(scheduleTimer)
  scheduleCheck()  // 立即检查一次
  scheduleTimer = setInterval(scheduleCheck, 60 * 1000)  // 每分钟检查
}

function stopScheduleTimer() {
  if (scheduleTimer) {
    clearInterval(scheduleTimer)
    scheduleTimer = null
  }
}

function setScheduleEnabled(enabled) {
  state.scheduleEnabled = enabled
  if (enabled) {
    emitLog('[计划] 时间计划已启用', 'success')
    startScheduleTimer()
  } else {
    stopScheduleTimer()
    // 如果是计划强制开启的屏蔽，则一并关闭
    if (state.scheduleBlocking && state.blocking) {
      state.scheduleBlocking = false
      setBlocking(false)
    }
    emitLog('[计划] 时间计划已停用', 'info')
  }
  saveConfig()
  pushState()
}

// ─── 密码保护 ─────────────────────────────────────────────────────────────────
function setPassword(pwd) {
  if (!pwd || pwd.trim() === '') {
    state.passwordEnabled = false
    state.passwordHash = null
    emitLog('[密码] 密码保护已关闭', 'info')
  } else {
    state.passwordHash = hashPassword(pwd)
    state.passwordEnabled = true
    emitLog('[密码] 密码保护已设置', 'success')
  }
  saveConfig()
  pushState()
}

function verifyPassword(pwd) {
  if (!state.passwordEnabled || !state.passwordHash) return true
  return hashPassword(pwd) === state.passwordHash
}

// ─── 防任务管理器守护进程 ────────────────────────────────────────────────────────
// 停止信号文件（主进程正常退出时写入，通知守护进程不要重启）
const WATCHDOG_STOP_FILE = path.join(os.tmpdir(), 'dfblocker_stop.sig')

function startWatchdog() {
  if (!app.isPackaged) {
    emitLog('[保护] 开发模式下跳过守护进程', 'info')
    return
  }
  // 清除残留停止信号
  try { fs.unlinkSync(WATCHDOG_STOP_FILE) } catch {}

  const exePath  = process.execPath.replace(/'/g, "''")
  const stopFile = WATCHDOG_STOP_FILE.replace(/'/g, "''")
  const pid      = process.pid

  // 内联 PS 脚本，以 UTF-16LE Base64 编码传入 -EncodedCommand
  // 无临时文件依赖，不会被杀软拦截或意外删除
  const ps = [
    `$sf='${stopFile}'`,
    `$ex='${exePath}'`,
    `$p=${pid}`,
    `while($true){`,
    `  Start-Sleep -Seconds 1`,
    `  if(Test-Path $sf){Remove-Item $sf -Force -EA 0;break}`,
    `  try{Get-Process -Id $p -EA Stop|Out-Null}`,
    `  catch{`,
    `    Start-Sleep -Milliseconds 200`,
    `    if(!(Test-Path $sf)){Start-Process -FilePath $ex}`,
    `    break`,
    `  }`,
    `}`,
  ].join('\n')

  const encoded = Buffer.from(ps, 'utf16le').toString('base64')
  runPSSync(`Start-Process powershell -WindowStyle Hidden -ArgumentList @('-NonInteractive','-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}')`)
  emitLog('[保护] 守护进程已启动，被任务管理器强制结束后将在 ~1 秒内自动恢复', 'success')
}

function stopWatchdog() {
  try { fs.writeFileSync(WATCHDOG_STOP_FILE, 'stop', 'utf8') } catch {}
}

function setWatchdog(enabled) {
  state.watchdog = enabled
  if (enabled) {
    startWatchdog()
  } else {
    stopWatchdog()
    emitLog('[保护] 守护进程已停止', 'info')
  }
  saveConfig()
  pushState()
}

// ─── 开机自启（XML 直接注册，原生 Unicode，无 cmdlet 兼容性问题）─────────────────
const TASK_NAME = 'DeltaForceBlocker'

function setAutoStart(enabled) {
  if (enabled) {
    const exePath = process.execPath
    // 开发模式下需附加 app 目录作为参数；XML 中用 &quot; 转义双引号
    const argsElem = app.isPackaged
      ? ''
      : `      <Arguments>&quot;${app.getAppPath()}&quot;</Arguments>`
    const result = runPSSync(`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$user = "$env:USERDOMAIN\\$env:USERNAME"
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo />
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$user</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${exePath}</Command>
${argsElem}
    </Exec>
  </Actions>
</Task>
"@
try {
  Register-ScheduledTask -TaskName '${TASK_NAME}' -Xml $xml -Force -ErrorAction Stop | Out-Null
  "OK"
} catch {
  "FAIL:" + $_.Exception.Message
}
`)
    if (result.startsWith('OK')) {
      emitLog('[自启] 任务计划注册成功，下次登录将自动启动', 'success')
    } else {
      emitLog(`[自启] 注册失败: ${result} — 请确认以管理员身份运行`, 'warn')
    }
  } else {
    runPSSync(`Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`)
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

  const template = [
    {
      label: state.blocking ? '● 屏蔽中' : '○ 已停止',
      enabled: false,
    },
    { type: 'separator' },
    { label: '显示窗口', click: () => { win.show(); win.focus() } },
    {
      label: state.blocking ? '关闭屏蔽' : '开启屏蔽',
      click: async () => {
        if (state.blocking && state.passwordEnabled) {
          // 需要密码验证才能关闭屏蔽
          win.show(); win.focus()
          const { response, checkboxChecked } = await dialog.showMessageBox(win, {
            type: 'warning',
            buttons: ['取消'],
            defaultId: 0,
            title: '需要密码',
            message: '关闭屏蔽需要密码验证',
            detail: '请打开主界面，通过密码验证后关闭屏蔽。',
          })
          return
        }
        setBlocking(!state.blocking)
      },
    },
  ]

  // 只在未屏蔽且未启用密码保护时才显示退出选项
  if (!state.blocking && !state.passwordEnabled) {
    template.push({ type: 'separator' })
    template.push({
      label: '退出',
      click: () => {
        app.isQuitting = true
        app.quit()
      },
    })
  }

  tray.setContextMenu(Menu.buildFromTemplate(template))
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

ipcMain.handle('set-autostart', async (_e, enabled) => {
  if (enabled) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['确认开启', '取消'],
      defaultId: 0,
      cancelId: 1,
      title: '开机自启',
      message: '开启开机自启需要管理员权限',
      detail: '将在 Windows 任务计划程序中注册开机自启任务，以管理员权限在登录时自动运行本程序。\n\n是否继续？',
    })
    if (response !== 0) return { ...state }
  }
  setAutoStart(enabled)
  return { ...state }
})

ipcMain.handle('set-watchdog', (_e, enabled) => {
  setWatchdog(enabled)
  return { ...state }
})

ipcMain.handle('trigger-scan', async () => {
  await runScan()
  return { ...state }
})

// ─── 密码 IPC ─────────────────────────────────────────────────────────────────
ipcMain.handle('set-password', (_e, pwd) => {
  setPassword(pwd)
  return { ok: true, passwordEnabled: state.passwordEnabled }
})

ipcMain.handle('verify-password', (_e, pwd) => {
  return { ok: verifyPassword(pwd) }
})

// ─── 时间计划 IPC ──────────────────────────────────────────────────────────────
ipcMain.handle('set-schedule', (_e, { schedule, enabled }) => {
  if (schedule !== undefined) state.schedule = schedule
  if (enabled !== undefined) {
    setScheduleEnabled(enabled)
  } else {
    saveConfig()
    pushState()
  }
  return { ...state }
})

ipcMain.handle('get-schedule', () => {
  return { schedule: state.schedule, scheduleEnabled: state.scheduleEnabled }
})

// ─── 应用初始化 ────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // 从配置文件恢复上次状态
  const config = loadConfig()

  createWindow()

  tray = new Tray(createTrayIcon())
  tray.on('double-click', () => { win.show(); win.focus() })

  // 恢复进程保护状态
  state.watchdog = config.watchdog || false
  if (state.watchdog) startWatchdog()

  // 恢复密码设置
  state.passwordEnabled = config.passwordEnabled || false
  state.passwordHash    = config.passwordHash    || null

  // 恢复时间计划
  if (config.schedule) state.schedule = config.schedule
  state.scheduleEnabled = config.scheduleEnabled || false

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

  // 恢复时间计划引擎（在屏蔽状态恢复后启动，避免重复触发）
  if (state.scheduleEnabled) {
    emitLog('[计划] 恢复时间计划...', 'info')
    startScheduleTimer()
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

app.on('before-quit', (e) => {
  // 屏蔽中或密码保护开启时，禁止退出
  if (state.blocking || state.passwordEnabled) {
    e.preventDefault()
    app.isQuitting = false
    if (win) { win.show(); win.focus() }
    return
  }
  app.isQuitting = true
  stopWatchdog()
})
