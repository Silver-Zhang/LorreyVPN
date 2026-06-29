'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { DEFAULT_PORTS, createRuntimeSecret, writeRuntimeConfig } = require('./config');
const controller = require('./controller');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function executableExists(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch (_error) {
    return false;
  }
}

function findInPath(command) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(finder, [command], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.trim()) {
    return '';
  }
  return result.stdout.split(/\r?\n/)[0].trim();
}

function platformCoreNames() {
  const archMap = { x64: 'amd64', arm64: 'arm64', arm: 'armv7' };
  const arch = archMap[process.arch] || process.arch;
  if (process.platform === 'win32') {
    return [
      `mihomo-windows-${arch}.exe`,
      `mihomo-win-${arch}.exe`,
      'mihomo.exe',
      'clash-meta.exe',
      'clash.exe'
    ];
  }
  return [
    `mihomo-${process.platform}-${arch}`,
    `clash-meta-${process.platform}-${arch}`,
    `clash-${process.platform}-${arch}`,
    'mihomo',
    'clash-meta',
    'clash'
  ];
}

function findCoreBinary(resourceDirs = []) {
  if (process.env.LORREYVPN_CORE && fs.existsSync(process.env.LORREYVPN_CORE)) {
    return process.env.LORREYVPN_CORE;
  }
  if (process.env.CLASH_CORE && fs.existsSync(process.env.CLASH_CORE)) {
    return process.env.CLASH_CORE;
  }

  const names = platformCoreNames();
  for (const dir of resourceDirs.filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir, 'clash-binaries', name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  for (const command of ['mihomo', 'clash-meta', 'clash']) {
    const found = findInPath(command);
    if (found) {
      return found;
    }
  }
  return '';
}

class MihomoService {
  constructor(options = {}) {
    this.paths = options.paths;
    this.ports = options.ports || DEFAULT_PORTS;
    this.secret = options.secret || createRuntimeSecret();
    this.child = null;
    this.corePath = '';
  }

  get running() {
    return Boolean(this.child && !this.child.killed);
  }

  appendLog(chunk) {
    if (!this.paths || !this.paths.logsDir) {
      return;
    }
    ensureDir(this.paths.logsDir);
    fs.appendFile(path.join(this.paths.logsDir, 'mihomo.log'), String(chunk), () => {});
  }

  async start(options = {}) {
    if (this.running) {
      return true;
    }

    this.corePath = findCoreBinary(this.paths.resourceDirs || []);
    if (!this.corePath) {
      this.appendLog(`[${new Date().toISOString()}] mihomo core not found.\n`);
      return false;
    }

    writeRuntimeConfig(this.paths.activeConfigFile, this.paths.runtimeConfigFile, {
      ports: this.ports,
      secret: this.secret,
      mode: options.mode,
      bypassHosts: options.bypassHosts || []
    });

    ensureDir(this.paths.runtimeDir);
    this.child = spawn(this.corePath, ['-d', this.paths.runtimeDir], {
      cwd: this.paths.runtimeDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.child.stdout.on('data', chunk => this.appendLog(chunk));
    this.child.stderr.on('data', chunk => this.appendLog(chunk));
    this.child.on('exit', (code, signal) => {
      this.appendLog(`[${new Date().toISOString()}] mihomo exited code=${code} signal=${signal}\n`);
      this.child = null;
    });

    const ready = await controller.waitForController(this.ports.controller, this.secret, options.timeoutMs || 15000);
    if (!ready) {
      await this.stop(4000);
      return false;
    }
    return true;
  }

  async stop(timeoutMs = 4000) {
    const child = this.child;
    if (!child || child.killed) {
      this.child = null;
      return;
    }
    await new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch (_error) {
          // ignored
        }
        finish();
      }, timeoutMs);
      child.once('exit', finish);
      try {
        child.kill('SIGTERM');
      } catch (_error) {
        finish();
      }
    });
    if (this.child === child) {
      this.child = null;
    }
  }

  request(pathname, options = {}) {
    return controller.requestJson({
      port: this.ports.controller,
      secret: this.secret,
      path: pathname,
      ...options
    });
  }
}

module.exports = {
  MihomoService,
  findCoreBinary,
  findInPath,
  platformCoreNames
};
