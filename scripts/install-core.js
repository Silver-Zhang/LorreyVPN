#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN_DIR = path.join(ROOT, 'resources', 'clash-binaries');
const RELEASE_API = 'https://api.github.com/repos/MetaCubeX/mihomo/releases/latest';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function archName() {
  if (process.arch === 'x64') {
    return 'amd64';
  }
  if (process.arch === 'arm64') {
    return 'arm64';
  }
  if (process.arch === 'arm') {
    return 'armv7';
  }
  return process.arch;
}

function platformName() {
  if (process.platform === 'win32') {
    return 'windows';
  }
  return process.platform;
}

function targetFile() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(BIN_DIR, `mihomo-${platformName()}-${archName()}${ext}`);
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    https.get(
      url,
      {
        headers: {
          'User-Agent': 'LorreyVPN core installer',
          Accept: 'application/vnd.github+json'
        },
        timeout: 30000
      },
      response => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          requestJson(response.headers.location).then(resolve, reject);
          return;
        }
        if (response.statusCode >= 400) {
          reject(new Error(`GitHub API returned HTTP ${response.statusCode}`));
          response.resume();
          return;
        }
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            reject(error);
          }
        });
      }
    ).on('error', reject);
  });
}

function download(url, file) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    https.get(
      url,
      {
        headers: { 'User-Agent': 'LorreyVPN core installer' },
        timeout: 120000
      },
      response => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          out.close();
          fs.rmSync(file, { force: true });
          response.resume();
          download(response.headers.location, file).then(resolve, reject);
          return;
        }
        if (response.statusCode >= 400) {
          out.close();
          fs.rmSync(file, { force: true });
          reject(new Error(`Download failed: HTTP ${response.statusCode}`));
          response.resume();
          return;
        }
        response.pipe(out);
        out.on('finish', () => out.close(resolve));
      }
    ).on('error', error => {
      out.close();
      fs.rmSync(file, { force: true });
      reject(error);
    });
  });
}

function selectAsset(release) {
  const platform = platformName();
  const arch = archName();
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const candidates = assets.filter(asset => {
    const name = String(asset.name || '').toLowerCase();
    return name.includes('mihomo') && name.includes(platform) && name.includes(arch) && /\.(zip|gz|exe)$/i.test(name);
  });
  candidates.sort((a, b) => {
    const an = String(a.name || '').toLowerCase();
    const bn = String(b.name || '').toLowerCase();
    const score = name => (name.endsWith('.zip') ? 0 : name.endsWith('.exe') ? 1 : 2) + (name.includes('compatible') ? 10 : 0);
    return score(an) - score(bn);
  });
  if (!candidates.length) {
    throw new Error(`No mihomo asset found for ${platform}/${arch}.`);
  }
  return candidates[0];
}

function findExe(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = findExe(file);
      if (nested) {
        return nested;
      }
    } else if (/mihomo.*\.exe$/i.test(entry.name) || entry.name.toLowerCase() === 'mihomo.exe') {
      return file;
    }
  }
  return '';
}

function extractZip(zipFile, destination) {
  ensureDir(destination);
  if (process.platform === 'win32') {
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Expand-Archive -Force -LiteralPath '${zipFile.replace(/'/g, "''")}' -DestinationPath '${destination.replace(/'/g, "''")}'`],
      { stdio: 'inherit' }
    );
    if (result.status !== 0) {
      throw new Error('Failed to extract zip with PowerShell Expand-Archive.');
    }
    return;
  }
  const result = spawnSync('unzip', ['-o', zipFile, '-d', destination], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error('Failed to extract zip. Install unzip or use Windows PowerShell.');
  }
}

function extractAsset(downloadFile, assetName, target) {
  const lower = assetName.toLowerCase();
  if (lower.endsWith('.exe')) {
    fs.copyFileSync(downloadFile, target);
    return;
  }
  if (lower.endsWith('.gz')) {
    const raw = fs.readFileSync(downloadFile);
    fs.writeFileSync(target, zlib.gunzipSync(raw));
    return;
  }
  if (lower.endsWith('.zip')) {
    const extractDir = path.join(BIN_DIR, '.extract');
    fs.rmSync(extractDir, { recursive: true, force: true });
    extractZip(downloadFile, extractDir);
    const exe = findExe(extractDir);
    if (!exe) {
      throw new Error('No mihomo executable found in downloaded zip.');
    }
    fs.copyFileSync(exe, target);
    fs.rmSync(extractDir, { recursive: true, force: true });
    return;
  }
  throw new Error(`Unsupported mihomo asset type: ${assetName}`);
}

function verifyCore(file) {
  if (process.platform !== 'win32') {
    fs.chmodSync(file, 0o755);
  }
  const result = spawnSync(file, ['-v'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`mihomo verification failed: ${result.stderr || result.stdout || 'unknown error'}`);
  }
  return (result.stdout || result.stderr || '').trim();
}

async function main() {
  ensureDir(BIN_DIR);
  const target = targetFile();
  if (fs.existsSync(target) && !process.argv.includes('--force')) {
    const version = verifyCore(target);
    console.log(`Existing mihomo core is usable: ${target}`);
    console.log(version);
    return;
  }

  const release = await requestJson(RELEASE_API);
  const asset = selectAsset(release);
  const tmp = path.join(BIN_DIR, `.download-${Date.now()}-${asset.name}`);
  console.log(`Downloading ${asset.name}`);
  console.log(asset.browser_download_url);
  await download(asset.browser_download_url, tmp);
  try {
    extractAsset(tmp, asset.name, target);
    const version = verifyCore(target);
    console.log(`Installed mihomo core: ${target}`);
    console.log(version);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

main().catch(error => {
  console.error(error.message || String(error));
  process.exit(1);
});
