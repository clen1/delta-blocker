/* eslint-disable no-undef */
const blockingToggle  = document.getElementById('blockingToggle')
const autoStartToggle = document.getElementById('autoStartToggle')
const watchdogToggle  = document.getElementById('watchdogToggle')
const statusIndicator = document.getElementById('statusIndicator')
const statusLabel     = document.getElementById('statusLabel')
const statusDesc      = document.getElementById('statusDesc')
const pathsList       = document.getElementById('pathsList')
const scanBtn         = document.getElementById('scanBtn')
const logList         = document.getElementById('logList')
const clearLogBtn     = document.getElementById('clearLogBtn')

// 密码相关
const passwordToggle  = document.getElementById('passwordToggle')
const passwordSection = document.getElementById('passwordSection')
const pwdStatus       = document.getElementById('pwdStatus')
const pwdInput        = document.getElementById('pwdInput')
const pwdConfirm      = document.getElementById('pwdConfirm')
const pwdSaveBtn      = document.getElementById('pwdSaveBtn')

// 时间计划相关
const scheduleToggle  = document.getElementById('scheduleToggle')
const scheduleGrid    = document.getElementById('scheduleGrid')
const scheduleSaveBtn = document.getElementById('scheduleSaveBtn')

// ─── 时间计划本地数据 ──────────────────────────────────────────────────────────
const DAYS = [
  { key: 'mon', label: '周一' },
  { key: 'tue', label: '周二' },
  { key: 'wed', label: '周三' },
  { key: 'thu', label: '周四' },
  { key: 'fri', label: '周五' },
  { key: 'sat', label: '周六' },
  { key: 'sun', label: '周日' },
]

// localSchedule: { mon: [{start:'09:00',end:'22:00'}], ... }
let localSchedule = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] }

// 实时跟踪密码状态（由 applyState 同步更新）
let livePasswordEnabled = false

// ─── 状态渲染 ──────────────────────────────────────────────────────────────────
function applyState(state) {
  // 主开关
  blockingToggle.checked = state.blocking
  statusIndicator.className = `status-indicator ${state.blocking ? 'active' : 'inactive'}`
  statusIndicator.textContent = state.blocking ? '🚫' : '🛡️'
  statusLabel.textContent = state.blocking ? '屏蔽进行中' : '屏蔽未开启'

  let desc = state.blocking
    ? '正在监控进程和安装包，每 3 秒扫描一次'
    : '点击右侧开关启动屏蔽引擎'
  if (state.scheduleBlocking) desc = '⏰ 时间计划触发 — 当前不在允许时段'
  statusDesc.textContent = desc

  // 自启
  autoStartToggle.checked = state.autoStart

  // 进程保护
  watchdogToggle.checked = state.watchdog

  // 密码保护
  livePasswordEnabled = state.passwordEnabled || false
  passwordToggle.checked = livePasswordEnabled
  updatePasswordSectionVisibility(livePasswordEnabled)
  if (state.passwordEnabled) {
    pwdStatus.textContent = '🔒 密码保护已启用'
    pwdStatus.className = 'pwd-status pwd-on'
  } else {
    pwdStatus.textContent = '🔓 未设置密码保护'
    pwdStatus.className = 'pwd-status pwd-off'
  }

  // 时间计划开关
  scheduleToggle.checked = state.scheduleEnabled || false

  // 检测路径
  renderPaths(state.detectedPaths || [])
}

function updatePasswordSectionVisibility(enabled) {
  passwordSection.style.display = enabled ? 'block' : 'none'
}

function renderPaths(paths) {
  if (!paths || paths.length === 0) {
    pathsList.innerHTML = '<li class="no-detection">未检测到游戏安装</li>'
    return
  }
  pathsList.innerHTML = paths
    .map(p => `<li class="path-item">${escapeHtml(p)}</li>`)
    .join('')
}

// ─── 日志渲染 ──────────────────────────────────────────────────────────────────
const MAX_LOG_ENTRIES = 150

function appendLogEntry(entry) {
  // 移除"等待启动..."占位
  const placeholder = logList.querySelector('.log-entry .log-msg')
  if (placeholder && placeholder.textContent === '等待启动...') {
    logList.innerHTML = ''
  }

  const li = document.createElement('li')
  li.className = `log-entry ${entry.type || 'info'}`
  li.innerHTML = `
    <span class="log-time">${escapeHtml(entry.time)}</span>
    <span class="log-msg">${escapeHtml(entry.msg)}</span>
  `
  logList.prepend(li)

  // 限制最大条目数
  while (logList.children.length > MAX_LOG_ENTRIES) {
    logList.removeChild(logList.lastChild)
  }
}

function renderInitialLog(logs) {
  if (!logs || logs.length === 0) return
  logList.innerHTML = ''
  // logs 是倒序的，直接渲染
  logs.forEach(entry => {
    const li = document.createElement('li')
    li.className = `log-entry ${entry.type || 'info'}`
    li.innerHTML = `
      <span class="log-time">${escapeHtml(entry.time)}</span>
      <span class="log-msg">${escapeHtml(entry.msg)}</span>
    `
    logList.appendChild(li)
  })
}

// ─── 时间计划渲染 ──────────────────────────────────────────────────────────────
function renderScheduleGrid() {
  scheduleGrid.innerHTML = ''
  DAYS.forEach(({ key, label }) => {
    const slots = localSchedule[key] || []
    const row = document.createElement('div')
    row.className = 'sched-row'
    row.dataset.day = key

    const dayLabel = document.createElement('div')
    dayLabel.className = 'sched-day-label'
    dayLabel.textContent = label
    row.appendChild(dayLabel)

    const slotsWrap = document.createElement('div')
    slotsWrap.className = 'sched-slots'
    slotsWrap.id = `slots-${key}`

    slots.forEach((slot, idx) => {
      slotsWrap.appendChild(buildSlotEl(key, slot, idx))
    })

    const addBtn = document.createElement('button')
    addBtn.className = 'sched-add-btn'
    addBtn.textContent = '+ 添加时段'
    addBtn.addEventListener('click', () => addSlot(key))
    slotsWrap.appendChild(addBtn)

    row.appendChild(slotsWrap)
    scheduleGrid.appendChild(row)
  })
}

function buildSlotEl(dayKey, slot, idx) {
  const wrap = document.createElement('div')
  wrap.className = 'sched-slot'
  wrap.dataset.idx = idx

  const startInput = document.createElement('input')
  startInput.type = 'time'
  startInput.className = 'time-input'
  startInput.value = slot.start
  startInput.addEventListener('change', () => {
    localSchedule[dayKey][idx].start = startInput.value
  })

  const sep = document.createElement('span')
  sep.className = 'time-sep'
  sep.textContent = '–'

  const endInput = document.createElement('input')
  endInput.type = 'time'
  endInput.className = 'time-input'
  endInput.value = slot.end
  endInput.addEventListener('change', () => {
    localSchedule[dayKey][idx].end = endInput.value
  })

  const delBtn = document.createElement('button')
  delBtn.className = 'sched-del-btn'
  delBtn.textContent = '✕'
  delBtn.title = '删除时段'
  delBtn.addEventListener('click', () => {
    localSchedule[dayKey].splice(idx, 1)
    renderScheduleGrid()
  })

  wrap.appendChild(startInput)
  wrap.appendChild(sep)
  wrap.appendChild(endInput)
  wrap.appendChild(delBtn)
  return wrap
}

function addSlot(dayKey) {
  localSchedule[dayKey].push({ start: '09:00', end: '22:00' })
  renderScheduleGrid()
}

// ─── 密码弹窗（关闭屏蔽时验证）─────────────────────────────────────────────────
function showPasswordDialog() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'pwd-overlay'
    overlay.innerHTML = `
      <div class="pwd-dialog">
        <div class="pwd-dialog-title">🔒 需要验证密码</div>
        <div class="pwd-dialog-desc">关闭屏蔽保护需要输入密码</div>
        <input type="password" class="pwd-input pwd-dialog-input" id="dialogPwdInput" placeholder="请输入密码" maxlength="32" autofocus />
        <div class="pwd-dialog-err" id="dialogPwdErr"></div>
        <div class="pwd-dialog-btns">
          <button class="action-btn action-btn-ghost" id="dialogCancelBtn">取消</button>
          <button class="action-btn" id="dialogConfirmBtn">确认</button>
        </div>
      </div>
    `
    document.body.appendChild(overlay)

    const input   = overlay.querySelector('#dialogPwdInput')
    const errEl   = overlay.querySelector('#dialogPwdErr')
    const confirm = overlay.querySelector('#dialogConfirmBtn')
    const cancel  = overlay.querySelector('#dialogCancelBtn')

    setTimeout(() => input.focus(), 50)

    async function doVerify() {
      const pwd = input.value
      if (!pwd) { errEl.textContent = '请输入密码'; return }
      confirm.disabled = true
      confirm.textContent = '验证中...'
      const result = await window.electronAPI.verifyPassword(pwd)
      if (result.ok) {
        overlay.remove()
        resolve(true)
      } else {
        errEl.textContent = '密码错误，请重试'
        input.value = ''
        input.focus()
        confirm.disabled = false
        confirm.textContent = '确认'
      }
    }

    confirm.addEventListener('click', doVerify)
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doVerify() })
    cancel.addEventListener('click', () => {
      overlay.remove()
      resolve(false)
    })
  })
}

// ─── 工具函数 ──────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ─── 初始化 ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // 获取初始状态
  const initialState = await window.electronAPI.getInitialState()
  applyState(initialState)
  if (initialState.log && initialState.log.length > 0) {
    renderInitialLog(initialState.log)
  }

  // 加载时间计划
  const schedData = await window.electronAPI.getSchedule()
  localSchedule = schedData.schedule || localSchedule
  renderScheduleGrid()

  // 密码区默认隐藏
  updatePasswordSectionVisibility(initialState.passwordEnabled)
  livePasswordEnabled = initialState.passwordEnabled || false

  // 订阅推送事件
  window.electronAPI.onStateChange(applyState)
  window.electronAPI.onLogEntry(appendLogEntry)

  // ── 主开关（带密码验证）──
  blockingToggle.addEventListener('change', async () => {
    const turning_off = !blockingToggle.checked
    if (turning_off && livePasswordEnabled) {
      // 恢复开关，等验证通过再操作
      blockingToggle.checked = true
      const ok = await showPasswordDialog()
      if (!ok) return
      blockingToggle.checked = false
    }
    blockingToggle.disabled = true
    const newState = await window.electronAPI.setBlocking(blockingToggle.checked)
    applyState(newState)
    blockingToggle.disabled = false
  })

  // ── 自启开关 ──
  autoStartToggle.addEventListener('change', async () => {
    autoStartToggle.disabled = true
    const newState = await window.electronAPI.setAutoStart(autoStartToggle.checked)
    applyState(newState)
    autoStartToggle.disabled = false
  })

  // ── 进程保护开关 ──
  watchdogToggle.addEventListener('change', async () => {
    if (!watchdogToggle.checked && livePasswordEnabled) {
      watchdogToggle.checked = true
      const ok = await showPasswordDialog()
      if (!ok) return
      watchdogToggle.checked = false
    }
    watchdogToggle.disabled = true
    const newState = await window.electronAPI.setWatchdog(watchdogToggle.checked)
    applyState(newState)
    watchdogToggle.disabled = false
  })

  // ── 密码开关 ──
  passwordToggle.addEventListener('change', async () => {
    if (!passwordToggle.checked && livePasswordEnabled) {
      // 关闭密码保护本身也需要先验证旧密码
      passwordToggle.checked = true
      const ok = await showPasswordDialog()
      if (!ok) return
      passwordToggle.checked = false
    }
    updatePasswordSectionVisibility(passwordToggle.checked)
    if (!passwordToggle.checked) {
      await window.electronAPI.setPassword('')
    }
  })

  // ── 保存密码 ──
  pwdSaveBtn.addEventListener('click', async () => {
    const pwd  = pwdInput.value
    const conf = pwdConfirm.value
    if (!pwd && !passwordToggle.checked) {
      await window.electronAPI.setPassword('')
      pwdStatus.textContent = '🔓 密码已清除'
      pwdStatus.className = 'pwd-status pwd-off'
      return
    }
    if (!pwd) {
      pwdStatus.textContent = '⚠️ 请输入密码'
      pwdStatus.className = 'pwd-status pwd-err'
      return
    }
    if (pwd !== conf) {
      pwdStatus.textContent = '⚠️ 两次密码不一致'
      pwdStatus.className = 'pwd-status pwd-err'
      return
    }
    if (pwd.length < 4) {
      pwdStatus.textContent = '⚠️ 密码至少需要 4 位'
      pwdStatus.className = 'pwd-status pwd-err'
      return
    }
    pwdSaveBtn.disabled = true
    const result = await window.electronAPI.setPassword(pwd)
    pwdSaveBtn.disabled = false
    pwdInput.value = ''
    pwdConfirm.value = ''
    if (result.ok) {
      pwdStatus.textContent = '✅ 密码已保存，保护已启用'
      pwdStatus.className = 'pwd-status pwd-on'
      livePasswordEnabled = true
    }
  })

  // ── 时间计划开关 ──
  scheduleToggle.addEventListener('change', async () => {
    if (!scheduleToggle.checked && livePasswordEnabled) {
      scheduleToggle.checked = true
      const ok = await showPasswordDialog()
      if (!ok) return
      scheduleToggle.checked = false
    }
    scheduleToggle.disabled = true
    await window.electronAPI.setSchedule({ enabled: scheduleToggle.checked })
    scheduleToggle.disabled = false
  })

  // ── 保存时间计划 ──
  scheduleSaveBtn.addEventListener('click', async () => {
    scheduleSaveBtn.disabled = true
    scheduleSaveBtn.textContent = '保存中...'
    await window.electronAPI.setSchedule({ schedule: localSchedule })
    scheduleSaveBtn.disabled = false
    scheduleSaveBtn.textContent = '✅ 已保存'
    setTimeout(() => { scheduleSaveBtn.textContent = '保存时间计划' }, 2000)
  })

  // ── 扫描按钮 ──
  scanBtn.addEventListener('click', async () => {
    scanBtn.disabled = true
    scanBtn.textContent = '🔍 扫描中...'
    const newState = await window.electronAPI.triggerScan()
    applyState(newState)
    scanBtn.disabled = false
    scanBtn.textContent = '🔍 立即扫描'
  })

  // ── 清除日志 ──
  clearLogBtn.addEventListener('click', () => {
    logList.innerHTML = ''
  })
})
