# LorreyVPN

LorreyVPN 是一个面向 Windows 桌面环境的轻量级代理客户端，基于 Electron 与 mihomo 构建。

本仓库定位为 **Windows-only**。第一阶段仅实现 **proxy-only** 模式：LorreyVPN 启动本地 mihomo 核心，提供 HTTP/SOCKS 代理，并通过 Windows WinINET 系统代理让常规桌面应用接入代理。

## 当前目标

- Windows 桌面图形界面
- mihomo Windows 核心启动与停止
- Clash/Mihomo YAML 订阅导入
- 节点列表读取、节点切换与延迟测试
- 智能代理、全局代理、直连模式切换
- Windows 系统代理开启、关闭与状态检测
- 退出时自动清理 LorreyVPN 设置的系统代理
- NSIS 与 portable 打包

## 暂不支持

- Windows TUN 全局接管
- Linux 桌面代理
- Linux 服务器多人 CLI
- GNOME gsettings
- Linux shell hook
- VS Code Remote Linux 代理注入

## 本地开发

```powershell
npm install
npm run install:core
npm run check
npm start
```

## Windows 打包

```powershell
npm run pack:win
```

产物位于 `dist/`。

## 代理端口

默认端口如下：

| 用途 | 地址 |
|---|---|
| HTTP 代理 | `127.0.0.1:4780` |
| SOCKS 代理 | `127.0.0.1:4781` |
| mihomo Controller | `127.0.0.1:4790` |

## 安全边界

LorreyVPN 第一阶段只修改当前 Windows 用户的 WinINET 代理设置，即：

```text
HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings
```

不会修改系统路由、系统 DNS、网卡配置、驱动、服务或防火墙规则。

如果程序异常退出后网络异常，可以进入 Windows 系统设置手动关闭代理，或重新启动 LorreyVPN 后点击“关闭系统代理”。
