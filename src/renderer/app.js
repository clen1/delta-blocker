/* eslint-disable no-undef */
const blockingToggle = document.getElementById('blockingToggle')
const autoStartToggle = document.getElementById('autoStartToggle')
const statusIndicator = document.getElementById('statusIndicator')
const statusLabel = document.getElementById('statusLabel')
const statusDesc = document.getElementById('statusDesc')
const pathsList = document.getElementById('pathsList')
const scanBtn = document.getElementById('scanBtn')
const logList = document.getElementById('logList')
const clearLogBtn = document.getElementById('clearLogBtn')

// ─── 状态渲染 ──────────────────────────────────────────────────────────────────
function applyState(state) {
  // 主开关
  blockingToggle.checked = state.blocking
  statusIndicator.className = `status-indicator ${state.blocking ? 'active' : 'inactive'}`
  statusIndicator.textContent = state.blocking ? '🚫' : '🛡️'
  statusLabel.textContent = state.blocking ? '屏蔽进行中' : '屏蔽未开启'
  statusDesc.textContent = state.blocking
    ? '正在监控进程和安装包，每 3 秒扫描一次'
    : '点击右侧开关启动屏蔽引擎'

  // 自启
  autoStartToggle.checked = state.autoStart

  // 检测路径
  renderPaths(state.detectedPaths || [])
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

  // 订阅推送事件
  window.electronAPI.onStateChange(applyState)
  window.electronAPI.onLogEntry(appendLogEntry)

  // ── 主开关 ──
  blockingToggle.addEventListener('change', async () => {
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
