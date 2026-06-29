'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { MihomoService, findCoreBinary } = require('./src/core/mihomo');
const { DEFAULT_PORTS, createRuntimeSecret, normalizeMode } = require('./src/core/config');
const controller = require('./src/core/controller');
const windowsProxy = require('./src/platform/windows-proxy');
const { importSubscription } = require('./src/subscription/import');

const APP_NAME = 'LorreyVPN';

let mainWindow = null;
let tray = null;
let service = null;
let runtime = null;
let cleanupStarted = false;
let cleanupFinished = false;

let settings = {
  systemProxy: false,
  mode: 'rule',
  currentProxy: '',
  bypassHosts: [],
  coreSecret: '',
  previousProxyState: null
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      return fallback;
    }
    const raw = fs.readFileSync(file, 'utf8');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch (_error) {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function copyIfMissing(source, target) {
  if (!fs.existsSync(target) && fs.existsSync(source)) {
    ensureDir(path.dirname(target));
    fs.copyFileSync(source, target);
  }
}

function resolveRuntimePaths() {
  const userData = app.getPath('userData');
  const localResources = path.join(__dirname, 'resources');
  const packagedResourceRoot = process.resourcesPath || '';
  return {
    userData,
    localResources,
    packagedResourceRoot,
    resourceDirs: [packagedResourceRoot, localResources].filter(Boolean),
    activeConfigFile: path.join(userData, 'profiles', 'active.yaml'),
    runtimeDir: path.join(userData, 'runtime'),
    runtimeConfigFile: path.join(userData, 'runtime', 'config.yaml'),
    logsDir: path.join(userData, 'logs'),
    settingsFile: path.join(userData, 'settings.json'),
    defaultConfigFile: path.join(localResources, 'clash-configs', 'config.yaml')
  };
}

function initializeRuntime() {
  runtime = resolveRuntimePaths();
  ensureDir(path.dirname(runtime.activeConfigFile));
  ensureDir(runtime.runtimeDir);
  ensureDir(runtime.logsDir);
  copyIfMissing(runtime.defaultConfigFile, runtime.activeConfigFile);
  settings = {
    ...settings,
    ...readJson(runtime.settingsFile, {})
  };
  settings.mode = normalizeMode(settings.mode);
  if (!settings.coreSecret) {
    settings.coreSecret = createRuntimeSecret();
    saveSettings();
  }
  service = new MihomoService({
    paths: runtime,
    ports: DEFAULT_PORTS,
    secret: settings.coreSecret
  });
}

function saveSettings() {
  writeJson(runtime.settingsFile, settings);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 980,
    minHeight: 680,
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  const trayIcon = path.join(__dirname, 'renderer', 'tray.png');
  if (!fs.existsSync(trayIcon)) {
    return;
  }
  tray = new Tray(trayIcon);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 LorreyVPN', click: () => mainWindow ? mainWindow.show() : createMainWindow() },
    { type: 'separator' },
    { label: '启动核心', click: () => handleAction('core:start') },
    { label: '停止核心', click: () => handleAction('core:stop') },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]));
}

function pickSelectorName(proxiesResponse, mode) {
  const proxies = proxiesResponse && proxiesResponse.proxies ? proxiesResponse.proxies : {};
  if (normalizeMode(mode) === 'global' && proxies.GLOBAL) {
    return 'GLOBAL';
  }
  if (proxies.Proxy && Array.isArray(proxies.Proxy.all)) {
    return 'Proxy';
  }
  const found = Object.entries(proxies).find(([, value]) => value && Array.isArray(value.all));
  return found ? found[0] : 'Proxy';
}

async function getCoreSnapshot() {
  const snapshot = {
    running: false,
    configs: null,
    proxies: null,
    selector: 'Proxy',
    node: settings.currentProxy || ''
  };
  try {
    snapshot.configs = await controller.getConfigs(DEFAULT_PORTS.controller, settings.coreSecret);
    snapshot.proxies = await controller.getProxies(DEFAULT_PORTS.controller, settings.coreSecret);
    snapshot.running = true;
    snapshot.selector = pickSelectorName(snapshot.proxies, snapshot.configs && snapshot.configs.mode);
    const group = snapshot.proxies.proxies && snapshot.proxies.proxies[snapshot.selector];
    snapshot.node = group && group.now ? group.now : snapshot.node;
  } catch (_error) {
    snapshot.running = Boolean(service && service.running);
  }
  return snapshot;
}

function readCoreLog() {
  try {
    const file = path.join(runtime.logsDir, 'mihomo.log');
    if (!fs.existsSync(file)) {
      return '';
    }
    const text = fs.readFileSync(file, 'utf8');
    return text.slice(-20000);
  } catch (_error) {
    return '';
  }
}

async function buildDashboard() {
  const core = await getCoreSnapshot();
  const proxyStatus = await windowsProxy.getSystemProxyStatus().catch(error => ({ supported: false, error: error.message }));
  const corePath = findCoreBinary(runtime.resourceDirs);
  return {
    appName: APP_NAME,
    platform: process.platform,
    userData: runtime.userData,
    activeConfigFile: runtime.activeConfigFile,
    logsDir: runtime.logsDir,
    ports: DEFAULT_PORTS,
    corePath,
    core,
    settings: {
      systemProxy: Boolean(settings.systemProxy),
      mode: normalizeMode(settings.mode),
      currentProxy: settings.currentProxy || '',
      bypassHosts: Array.isArray(settings.bypassHosts) ? settings.bypassHosts : []
    },
    proxyStatus,
    logTail: readCoreLog()
  };
}

async function startCore() {
  const started = await service.start({
    mode: settings.mode,
    bypassHosts: settings.bypassHosts || []
  });
  if (!started) {
    throw new Error('mihomo Windows 核心启动失败。请先运行 npm run install:core，或检查 resources/clash-binaries。');
  }
  return buildDashboard();
}

async function stopCore() {
  await service.stop();
  return buildDashboard();
}

function compactProxySnapshot(status) {
  if (!status || !status.supported) {
    return null;
  }
  return {
    enabled: Boolean(status.enabled),
    proxyServer: String(status.proxyServer || ''),
    proxyOverride: String(status.proxyOverride || '')
  };
}

async function restorePreviousProxyState() {
  if (settings.previousProxyState) {
    await windowsProxy.restoreSystemProxy(settings.previousProxyState);
    settings.previousProxyState = null;
    return;
  }
  await windowsProxy.setSystemProxy(false, {
    ports: DEFAULT_PORTS,
    bypassHosts: settings.bypassHosts || []
  });
}

async function setSystemProxy(enabled) {
  if (process.platform !== 'win32') {
    throw new Error('LorreyVPN 当前仅支持 Windows 系统代理。');
  }

  if (enabled) {
    const before = await windowsProxy.getSystemProxyStatus();
    if (!before.ownedByLorreyVPN && !settings.previousProxyState) {
      settings.previousProxyState = compactProxySnapshot(before);
      saveSettings();
    }
    await startCore();
    await windowsProxy.setSystemProxy(true, {
      ports: DEFAULT_PORTS,
      bypassHosts: settings.bypassHosts || []
    });
    settings.systemProxy = true;
    saveSettings();
    return buildDashboard();
  }

  await restorePreviousProxyState();
  settings.systemProxy = false;
  saveSettings();
  return buildDashboard();
}

async function setMode(value) {
  const mode = normalizeMode(value);
  settings.mode = mode;
  saveSettings();
  try {
    await controller.setMode(DEFAULT_PORTS.controller, settings.coreSecret, mode);
  } catch (_error) {
    // Core may be stopped; saved mode will be written into runtime config next time.
  }
  return buildDashboard();
}

async function switchProxy(name) {
  const core = await getCoreSnapshot();
  if (!core.running) {
    throw new Error('请先启动核心。');
  }
  const selector = core.selector || 'Proxy';
  await controller.setProxy(DEFAULT_PORTS.controller, settings.coreSecret, selector, name);
  await controller.closeConnections(DEFAULT_PORTS.controller, settings.coreSecret).catch(() => null);
  settings.currentProxy = name;
  saveSettings();
  return buildDashboard();
}

async function testProxyDelay(name) {
  if (!name) {
    throw new Error('请选择节点。');
  }
  const result = await controller.testDelay(DEFAULT_PORTS.controller, settings.coreSecret, name);
  return { name, delay: Number.isFinite(result.delay) ? result.delay : null };
}

async function importConfig(source) {
  const result = await importSubscription(source, runtime.activeConfigFile);
  if (service.running) {
    await service.stop();
    await service.start({ mode: settings.mode, bypassHosts: settings.bypassHosts || [] });
  }
  return { result, dashboard: await buildDashboard() };
}

async function saveBypassHosts(hosts) {
  const values = Array.isArray(hosts) ? hosts : String(hosts || '').split(/\r?\n/);
  settings.bypassHosts = values.map(item => String(item || '').trim()).filter(Boolean);
  saveSettings();
  if (settings.systemProxy) {
    await windowsProxy.setSystemProxy(true, { ports: DEFAULT_PORTS, bypassHosts: settings.bypassHosts });
  }
  if (service.running) {
    await service.stop();
    await service.start({ mode: settings.mode, bypassHosts: settings.bypassHosts });
  }
  return buildDashboard();
}

async function cleanupBeforeQuit() {
  if (cleanupStarted) {
    return;
  }
  cleanupStarted = true;
  try {
    const status = await windowsProxy.getSystemProxyStatus().catch(() => null);
    if (status && status.ownedByLorreyVPN) {
      await restorePreviousProxyState();
      settings.systemProxy = false;
      saveSettings();
    }
    if (service) {
      await service.stop();
    }
  } finally {
    cleanupFinished = true;
  }
}

async function handleAction(action, payload = {}) {
  switch (action) {
    case 'dashboard':
      return buildDashboard();
    case 'core:start':
      return startCore();
    case 'core:stop':
      return stopCore();
    case 'system-proxy:set':
      return setSystemProxy(Boolean(payload.enabled));
    case 'mode:set':
      return setMode(payload.mode);
    case 'proxy:switch':
      return switchProxy(payload.name);
    case 'proxy:delay':
      return testProxyDelay(payload.name);
    case 'subscription:import':
      return importConfig(payload.source);
    case 'bypass:save':
      return saveBypassHosts(payload.hosts || payload.text || '');
    case 'paths:open-config':
      await shell.openPath(path.dirname(runtime.activeConfigFile));
      return true;
    case 'paths:open-logs':
      await shell.openPath(runtime.logsDir);
      return true;
    case 'logs:get':
      return readCoreLog();
    default:
      throw new Error(`未知操作：${action}`);
  }
}

ipcMain.handle('LORREYVPN', async (_event, action, payload = {}) => {
  try {
    return { ok: true, data: await handleAction(action, payload) };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

app.setName(APP_NAME);

app.whenReady().then(() => {
  initializeRuntime();
  createMainWindow();
  createTray();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

app.on('before-quit', event => {
  if (!cleanupFinished) {
    event.preventDefault();
    cleanupBeforeQuit()
      .catch(error => dialog.showErrorBox(APP_NAME, error.message || String(error)))
      .finally(() => app.quit());
  }
});
