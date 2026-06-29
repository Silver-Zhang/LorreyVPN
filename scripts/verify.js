#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const checks = [];

function add(name, ok, detail) {
  checks.push({ name, ok, detail: detail || '' });
}

function exists(relativePath) {
  return fs.existsSync(path.join(ROOT, relativePath));
}

function runNodeCheck(relativePath) {
  const file = path.join(ROOT, relativePath);
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  add(`syntax ${relativePath}`, result.status === 0, result.stderr || result.stdout);
}

[
  'package.json',
  'main.js',
  'preload.js',
  'renderer/index.html',
  'renderer/app.js',
  'renderer/styles.css',
  'src/core/config.js',
  'src/core/controller.js',
  'src/core/mihomo.js',
  'src/platform/windows-proxy.js',
  'src/subscription/import.js',
  'resources/clash-configs/config.yaml'
].forEach(file => add(`exists ${file}`, exists(file)));

[
  'main.js',
  'preload.js',
  'renderer/app.js',
  'src/core/config.js',
  'src/core/controller.js',
  'src/core/mihomo.js',
  'src/platform/windows-proxy.js',
  'src/subscription/import.js',
  'scripts/install-core.js'
].forEach(runNodeCheck);

const binaryDir = path.join(ROOT, 'resources', 'clash-binaries');
const coreCandidates = fs.existsSync(binaryDir)
  ? fs.readdirSync(binaryDir).filter(name => /^mihomo.*(\.exe)?$/i.test(name))
  : [];
add('mihomo core optional', true, coreCandidates.length ? coreCandidates.join(', ') : 'not installed; run npm run install:core');

let failed = false;
for (const item of checks) {
  const prefix = item.ok ? '[OK]' : '[FAIL]';
  console.log(`${prefix} ${item.name}${item.detail ? ` - ${String(item.detail).trim()}` : ''}`);
  if (!item.ok) {
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
