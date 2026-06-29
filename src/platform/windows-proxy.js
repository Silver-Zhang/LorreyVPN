'use strict';

const { execFile } = require('child_process');

const INTERNET_SETTINGS = String.raw`HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings`;

function psSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runPowerShell(lines) {
  const script = Array.isArray(lines) ? lines.join('; ') : String(lines);
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || stdout || error.message).trim()));
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}

async function notifyProxyChanged() {
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class LorreyVpnNativeMethods {
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
}
"@
$result = [UIntPtr]::Zero
[LorreyVpnNativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, "Internet Settings", 0x0002, 5000, [ref]$result) | Out-Null
`;
  await runPowerShell(script);
}

function buildProxyServer(ports) {
  const http = ports.http || 4780;
  const socks = ports.socks || 4781;
  return `http=127.0.0.1:${http};https=127.0.0.1:${http};socks=127.0.0.1:${socks}`;
}

function buildProxyOverride(extraHosts = []) {
  const defaults = [
    '<local>',
    'localhost',
    '127.*',
    '10.*',
    '172.16.*',
    '192.168.*',
    '169.254.*',
    '*.local'
  ];
  const clean = extraHosts.map(item => String(item || '').trim()).filter(Boolean);
  return [...new Set([...defaults, ...clean])].join(';');
}

async function applySystemProxyState(state = {}) {
  if (process.platform !== 'win32') {
    throw new Error('Windows 系统代理接口只能在 Windows 上使用。');
  }

  const enabled = Boolean(state.enabled);
  const lines = [
    `$p=${psSingleQuote(INTERNET_SETTINGS)}`,
    `Set-ItemProperty -Path $p -Name ProxyEnable -Value ${enabled ? 1 : 0}`
  ];

  if (Object.prototype.hasOwnProperty.call(state, 'proxyServer')) {
    lines.push(`Set-ItemProperty -Path $p -Name ProxyServer -Value ${psSingleQuote(state.proxyServer || '')}`);
  }
  if (Object.prototype.hasOwnProperty.call(state, 'proxyOverride')) {
    lines.push(`Set-ItemProperty -Path $p -Name ProxyOverride -Value ${psSingleQuote(state.proxyOverride || '')}`);
  }

  await runPowerShell(lines);
  await notifyProxyChanged();
  return getSystemProxyStatus();
}

async function setSystemProxy(enabled, options = {}) {
  if (process.platform !== 'win32') {
    throw new Error('Windows 系统代理接口只能在 Windows 上使用。');
  }

  const ports = options.ports || { http: 4780, socks: 4781 };
  const proxyServer = buildProxyServer(ports);
  const proxyOverride = buildProxyOverride(options.bypassHosts || []);

  if (!enabled) {
    return applySystemProxyState({
      enabled: false,
      proxyServer,
      proxyOverride
    });
  }

  return applySystemProxyState({
    enabled: true,
    proxyServer,
    proxyOverride
  });
}

async function restoreSystemProxy(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return setSystemProxy(false);
  }
  return applySystemProxyState({
    enabled: Boolean(snapshot.enabled),
    proxyServer: String(snapshot.proxyServer || ''),
    proxyOverride: String(snapshot.proxyOverride || '')
  });
}

async function getSystemProxyStatus() {
  if (process.platform !== 'win32') {
    return { supported: false, enabled: false };
  }
  const script = [
    `$p=${psSingleQuote(INTERNET_SETTINGS)}`,
    '$v=Get-ItemProperty -Path $p',
    '$obj=[ordered]@{ProxyEnable=$v.ProxyEnable;ProxyServer=$v.ProxyServer;ProxyOverride=$v.ProxyOverride}',
    '$obj | ConvertTo-Json -Compress'
  ].join('; ');
  const raw = await runPowerShell(script);
  let value = {};
  try {
    value = JSON.parse(raw);
  } catch (_error) {
    value = {};
  }
  const proxyServer = String(value.ProxyServer || '');
  return {
    supported: true,
    enabled: Number(value.ProxyEnable) === 1,
    proxyServer,
    proxyOverride: String(value.ProxyOverride || ''),
    ownedByLorreyVPN: proxyServer.includes('127.0.0.1:4780') || proxyServer.includes('127.0.0.1:4781')
  };
}

module.exports = {
  setSystemProxy,
  restoreSystemProxy,
  applySystemProxyState,
  getSystemProxyStatus,
  buildProxyServer,
  buildProxyOverride
};
