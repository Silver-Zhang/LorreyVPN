# LorreyVPN Windows 使用说明

## 安装

```powershell
npm install
npm run install:core
```

## 开发启动

```powershell
npm start
```

## 基本使用流程

1. 在界面中导入 Clash/Mihomo YAML 配置、订阅 URL、`sub://` 链接或本地 YAML 文件。
2. 点击“启动核心”。
3. 在节点列表中选择节点。
4. 选择“智能代理”“全局代理”或“直连模式”。
5. 点击“开启系统代理”。
6. 不使用时点击“关闭系统代理”或直接退出程序。

## 默认端口

| 用途 | 地址 |
|---|---|
| HTTP | `127.0.0.1:4780` |
| SOCKS | `127.0.0.1:4781` |
| Controller | `127.0.0.1:4790` |

## 打包

```powershell
npm run check
npm run verify
npm run pack:win
```

产物位于 `dist/`。

## 当前限制

LorreyVPN 第一阶段只做 Windows proxy-only 桌面客户端。当前不包含 TUN、虚拟网卡、驱动安装、系统路由接管、DNS 接管或后台服务。

如果程序异常退出后出现网络异常，请重新打开 LorreyVPN 并点击“关闭系统代理”，或在 Windows 设置中关闭手动代理。
