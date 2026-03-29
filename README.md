# delta-blocker

> 一个帮你戒掉三角洲行动的 Windows 桌面工具

当你意识到自己在游戏上花了太多时间，delta-blocker 可以帮你强制屏蔽游戏的安装和启动。

## 功能

- **拦截游戏进程** — 每 3 秒扫描一次，发现游戏进程立即强制终止
- **自动删除安装包** — 监控下载文件夹，检测到安装包自动删除
- **游戏路径检测** — 扫描注册表和常见安装路径，自动识别已安装的游戏
- **系统托盘运行** — 最小化到托盘，后台静默工作
- **开机自动启动** — 系统启动时自动开启屏蔽（需安装版）
- **Windows 11 风格界面** — 支持深色模式

## 截图

![主界面](https://raw.githubusercontent.com/clen1/delta-blocker/main/assets/screenshot.png)

## 安装

### 方式一：下载安装包（推荐）

前往 [Releases](https://github.com/clen1/delta-blocker/releases) 下载最新版 `Delta Force 屏蔽器 Setup x.x.x.exe`，双击安装即可。

> 安装时会弹出 UAC 管理员权限提示，需要允许，否则无法拦截进程。

### 方式二：从源码运行

**环境要求：** Node.js 18+

```bash
git clone https://github.com/clen1/delta-blocker.git
cd delta-blocker
npm install
npm start
```

## 打包

```bash
npm run build
```

生成的安装包在 `dist/` 目录下。

> **注意：** 首次打包会自动运行 `scripts/prebuild.js` 预置 winCodeSign 缓存，解决 Windows 非开发者模式下的符号链接权限问题。

## 使用说明

1. 启动程序后会出现在系统托盘
2. 点击托盘图标打开主窗口
3. 打开「屏蔽」开关启动拦截引擎
4. 可选：开启「开机自动启动屏蔽」
5. 点击「立即扫描」检测游戏是否已安装

屏蔽开启后：
- 游戏进程一旦启动，3 秒内会被强制终止
- 下载文件夹中出现 `deltaforceminiloader*.exe` 会被立即删除

## 游戏检测逻辑

程序通过以下两种方式检测游戏安装：

1. **注册表扫描** — 查找 DisplayName 或 InstallLocation 包含 `Delta Force` 的卸载项
2. **路径探测** — 检查以下目录是否存在：
   - `D:\Delta Force`
   - `C:\Program Files\Delta Force`
   - `C:\Program Files (x86)\Delta Force`
   - `C:\Games\Delta Force`
   - `E:\Delta Force` / `F:\Delta Force`

## 技术栈

- [Electron](https://www.electronjs.org/) — 桌面应用框架
- [chokidar](https://github.com/paulmillr/chokidar) — 文件系统监控
- [electron-builder](https://www.electron.build/) — 打包工具
- PowerShell — 进程管理与注册表操作

## 免责声明

本工具仅用于个人自我管理，帮助控制游戏时间。请勿用于任何非法用途。

## License

MIT
