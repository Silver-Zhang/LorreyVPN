# LorreyVPN 架构说明

## 1. 项目定位

LorreyVPN 是一个 Windows-only 桌面代理客户端。第一阶段采用 proxy-only 架构，不创建虚拟网卡，不修改路由表，不安装驱动。

核心目标是让 Windows 桌面用户通过图形界面完成以下流程：

```text
导入订阅
→ 生成运行时 mihomo 配置
→ 启动 mihomo Windows 核心
→ 选择节点/切换模式
→ 开启 Windows WinINET 系统代理
→ 桌面应用通过 127.0.0.1:4780/4781 访问代理
```

## 2. 模块划分

```text
main.js
  Electron 主进程、窗口、IPC、mihomo 生命周期、退出清理

preload.js
  安全暴露 window.lorreyvpn.invoke()

renderer/
  Windows 桌面 UI

src/core/config.js
  Clash/Mihomo 配置 patch，写入 runtime config.yaml

src/core/mihomo.js
  mihomo 核心发现、启动、停止和日志

src/core/controller.js
  mihomo external-controller API 封装

src/platform/windows-proxy.js
  Windows WinINET 系统代理读写与 WM_SETTINGCHANGE 通知

src/subscription/import.js
  订阅下载、本地 YAML 导入、基础 URI 列表转换

scripts/install-core.js
  下载并安装 mihomo Windows 核心
```

## 3. 默认端口

| 模块 | 端口 |
|---|---:|
| HTTP 代理 | 4780 |
| SOCKS 代理 | 4781 |
| mihomo external-controller | 4790 |

运行时配置由 `src/core/config.js` 写入：

```yaml
port: 4780
socks-port: 4781
allow-lan: false
bind-address: 127.0.0.1
external-controller: 127.0.0.1:4790
```

## 4. Windows 系统代理

LorreyVPN 通过当前用户注册表开启 WinINET 代理：

```text
HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings
```

写入字段：

```text
ProxyEnable
ProxyServer
ProxyOverride
```

设置后通过 `WM_SETTINGCHANGE / Internet Settings` 通知系统代理变化。

## 5. 退出清理策略

程序退出前会检查当前系统代理是否指向 LorreyVPN 默认端口。如果是，则关闭系统代理并停止 mihomo 核心。

该策略用于避免 `127.0.0.1:4780` 残留导致用户断网。

## 6. 非目标范围

第一阶段不包含：

- Windows TUN
- Wintun 驱动
- 系统路由接管
- DNS 劫持
- Windows Service 守护
- Linux 桌面和服务器功能

这些能力如果后续引入，应作为第二阶段或独立分支设计，不能混入当前 proxy-only 主线。
