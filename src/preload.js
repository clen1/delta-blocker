const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // 获取初始状态
  getInitialState: () => ipcRenderer.invoke('get-initial-state'),

  // 切换屏蔽开关
  setBlocking: (enabled) => ipcRenderer.invoke('set-blocking', enabled),

  // 切换开机自启
  setAutoStart: (enabled) => ipcRenderer.invoke('set-autostart', enabled),

  // 切换进程保护
  setWatchdog: (enabled) => ipcRenderer.invoke('set-watchdog', enabled),

  // 手动扫描游戏安装路径
  triggerScan: () => ipcRenderer.invoke('trigger-scan'),

  // 密码保护
  setPassword: (pwd) => ipcRenderer.invoke('set-password', pwd),
  verifyPassword: (pwd) => ipcRenderer.invoke('verify-password', pwd),

  // 时间计划
  setSchedule: (data) => ipcRenderer.invoke('set-schedule', data),
  getSchedule: () => ipcRenderer.invoke('get-schedule'),

  // 接收日志推送 (main → renderer)
  onLogEntry: (callback) => {
    ipcRenderer.on('log-entry', (_event, entry) => callback(entry))
  },

  // 接收状态变更推送 (main → renderer)
  onStateChange: (callback) => {
    ipcRenderer.on('state-change', (_event, state) => callback(state))
  },
})
