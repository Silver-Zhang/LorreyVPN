'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');

const DEFAULT_PORTS = {
  http: 4780,
  socks: 4781,
  controller: 4790
};

const DEFAULT_BYPASS_HOSTS = [
  'localhost',
  '127.0.0.0/8',
  '::1',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '*.local'
];

const ALWAYS_PROXY_RULES = [
  'DOMAIN-SUFFIX,openai.com,Proxy',
  'DOMAIN-SUFFIX,chatgpt.com,Proxy',
  'DOMAIN-SUFFIX,google.com,Proxy',
  'DOMAIN-SUFFIX,googleapis.com,Proxy',
  'DOMAIN-SUFFIX,gstatic.com,Proxy',
  'DOMAIN-SUFFIX,github.com,Proxy',
  'DOMAIN-SUFFIX,githubusercontent.com,Proxy'
];

const ALWAYS_DIRECT_RULES = ['GEOIP,CN,DIRECT'];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readText(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (_error) {
    return fallback;
  }
}

function writeText(file, content) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`);
}

function readYaml(file) {
  const text = readText(file);
  if (!text.trim()) {
    return {};
  }
  return yaml.load(text) || {};
}

function normalizeMode(value) {
  const text = String(value || 'rule').trim().toLowerCase();
  if (['rule', 'smart', 'intelligent', 'auto'].includes(text)) {
    return 'rule';
  }
  if (text === 'global') {
    return 'global';
  }
  if (text === 'direct') {
    return 'direct';
  }
  return 'rule';
}

function normalizeBypassHosts(values) {
  const source = Array.isArray(values) ? values : String(values || '').split(/\r?\n/);
  const out = [];
  const seen = new Set();
  for (const item of source) {
    const value = String(item || '').trim();
    if (!value || value.startsWith('#') || seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}

function bypassHostToRule(host) {
  if (host === 'localhost') {
    return 'DOMAIN,localhost,DIRECT';
  }
  if (host === '::1') {
    return 'IP-CIDR6,::1/128,DIRECT,no-resolve';
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(host)) {
    return `IP-CIDR,${host},DIRECT,no-resolve`;
  }
  if (/^[0-9a-f:]+\/\d{1,3}$/i.test(host)) {
    return `IP-CIDR6,${host},DIRECT,no-resolve`;
  }
  if (host.startsWith('*.')) {
    return `DOMAIN-SUFFIX,${host.slice(2)},DIRECT`;
  }
  if (host.startsWith('.')) {
    return `DOMAIN-SUFFIX,${host.slice(1)},DIRECT`;
  }
  if (/^[a-z0-9.-]+$/i.test(host)) {
    return `DOMAIN,${host},DIRECT`;
  }
  return '';
}

function getDirectRules(extraBypassHosts = []) {
  return normalizeBypassHosts([...DEFAULT_BYPASS_HOSTS, ...extraBypassHosts])
    .map(bypassHostToRule)
    .filter(Boolean)
    .concat(ALWAYS_DIRECT_RULES);
}

function getProxyNames(document) {
  const proxies = Array.isArray(document.proxies) ? document.proxies : [];
  return proxies.map(proxy => String(proxy && proxy.name || '').trim()).filter(Boolean);
}

function normalizeGroups(document) {
  if (!Array.isArray(document['proxy-groups']) && Array.isArray(document['Proxy Group'])) {
    document['proxy-groups'] = document['Proxy Group'];
    delete document['Proxy Group'];
  }
  if (!Array.isArray(document['proxy-groups'])) {
    document['proxy-groups'] = [];
  }

  const proxyNames = getProxyNames(document);
  const desiredNames = proxyNames.length ? proxyNames : ['DIRECT'];
  if (!desiredNames.includes('DIRECT')) {
    desiredNames.push('DIRECT');
  }

  let group = document['proxy-groups'].find(item => item && item.name === 'Proxy');
  if (!group) {
    group = { name: 'Proxy', type: 'select', proxies: desiredNames };
    document['proxy-groups'].unshift(group);
  } else {
    group.type = group.type || 'select';
    const current = Array.isArray(group.proxies) ? group.proxies.map(String) : [];
    group.proxies = [...new Set([...current, ...desiredNames])];
  }
}

function getProxyTarget(document) {
  const groups = Array.isArray(document['proxy-groups']) ? document['proxy-groups'] : [];
  const selectable = groups.filter(group => {
    const type = String(group && group.type || '').toLowerCase();
    return group && group.name && ['select', 'url-test', 'fallback', 'load-balance'].includes(type);
  });
  return (selectable.find(group => group.name === 'Proxy') || selectable[0] || {}).name || 'Proxy';
}

function ensureRules(document, extraBypassHosts = []) {
  const target = getProxyTarget(document);
  const existing = Array.isArray(document.rules) ? document.rules.map(rule => String(rule)) : [];
  const existingSet = new Set(existing);
  const proxyRules = ALWAYS_PROXY_RULES.map(rule => rule.replace(/,Proxy$/, `,${target}`));
  const directRules = getDirectRules(extraBypassHosts);
  const required = [...proxyRules, ...directRules].filter(rule => !existingSet.has(rule));
  const rules = [...required, ...existing];
  if (!rules.some(rule => /^(MATCH|FINAL),/i.test(rule))) {
    rules.push(`MATCH,${target}`);
  }
  document.rules = rules;
}

function createRuntimeSecret() {
  return crypto.randomBytes(24).toString('hex');
}

function patchRuntimeDocument(sourceDocument, options = {}) {
  const document = sourceDocument && typeof sourceDocument === 'object' ? { ...sourceDocument } : {};
  const ports = { ...DEFAULT_PORTS, ...(options.ports || {}) };

  delete document['mixed-port'];
  delete document['redir-port'];
  delete document['tproxy-port'];
  delete document.tun;

  document.port = ports.http;
  document['socks-port'] = ports.socks;
  document['allow-lan'] = false;
  document['bind-address'] = '127.0.0.1';
  document['external-controller'] = `127.0.0.1:${ports.controller}`;
  document.secret = options.secret || '';
  document.mode = normalizeMode(options.mode || document.mode);

  if (!Array.isArray(document.proxies)) {
    document.proxies = [];
  }
  normalizeGroups(document);
  ensureRules(document, options.bypassHosts || []);

  return document;
}

function writeRuntimeConfig(activeConfigFile, runtimeConfigFile, options = {}) {
  if (!fs.existsSync(activeConfigFile)) {
    throw new Error(`配置文件不存在：${activeConfigFile}`);
  }
  const sourceDocument = readYaml(activeConfigFile);
  const runtimeDocument = patchRuntimeDocument(sourceDocument, options);
  const text = yaml.dump(runtimeDocument, {
    noRefs: true,
    sortKeys: false,
    lineWidth: -1,
    quotingType: '"'
  });
  writeText(runtimeConfigFile, text);
  return runtimeDocument;
}

module.exports = {
  DEFAULT_PORTS,
  DEFAULT_BYPASS_HOSTS,
  createRuntimeSecret,
  normalizeMode,
  patchRuntimeDocument,
  writeRuntimeConfig,
  readYaml,
  writeText
};
