# LorreyVPN

[中文说明](README.zh-CN.md)

LorreyVPN is a Windows-only desktop proxy client powered by Electron and mihomo.

The first milestone is proxy-only: LorreyVPN starts a local mihomo core, exposes HTTP/SOCKS proxy ports, and controls the current Windows user's WinINET system proxy settings.

## Development

```powershell
npm install
npm run install:core
npm run check
npm run verify
npm start
```

## Build for Windows

```powershell
npm run pack:win
```

## Scope

Included in the first milestone:

- Windows Electron desktop UI
- mihomo core lifecycle management
- Clash/Mihomo YAML import
- basic URI-list conversion for common node formats
- proxy mode switching
- node switching and delay tests
- WinINET system proxy enable/disable

Not included yet:

- TUN mode
- virtual network adapters
- routing-table takeover
- DNS takeover
- background Windows service
- Linux desktop/server workflows
