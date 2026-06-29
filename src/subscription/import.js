'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const yaml = require('js-yaml');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function stripBom(text) {
  return String(text || '').replace(/^\uFEFF/, '');
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch (_error) {
    return value;
  }
}

function decodeBase64Text(value) {
  const compact = String(value || '').trim().replace(/\s+/g, '');
  if (!compact || compact.length % 4 === 1 || /[^A-Za-z0-9+/=_-]/.test(compact)) {
    return null;
  }
  try {
    const normalized = compact.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    return decoded.includes('\uFFFD') ? null : stripBom(decoded);
  } catch (_error) {
    return null;
  }
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_error) {
    return false;
  }
}

function parseSubUrl(value) {
  const text = String(value || '').trim();
  if (!/^sub:\/\//i.test(text)) {
    return null;
  }
  const payload = text.slice('sub://'.length);
  const hashIndex = payload.indexOf('#');
  const body = hashIndex >= 0 ? payload.slice(0, hashIndex) : payload;
  const name = hashIndex >= 0 ? safeDecodeURIComponent(payload.slice(hashIndex + 1)) : '';
  const decoded = decodeBase64Text(safeDecodeURIComponent(body));
  if (!decoded || !isHttpUrl(decoded.trim())) {
    throw new Error('sub:// 内容不是有效的 HTTP/HTTPS 订阅地址。');
  }
  return { url: decoded.trim(), name };
}

function fetchText(url, maxBytes = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(
      url,
      {
        headers: {
          'User-Agent': 'LorreyVPN/0.1 mihomo subscription importer',
          Accept: '*/*'
        },
        timeout: 30000
      },
      response => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          const next = new URL(response.headers.location, url).toString();
          response.resume();
          fetchText(next, maxBytes).then(resolve, reject);
          return;
        }
        if (response.statusCode >= 400) {
          reject(new Error(`订阅下载失败：HTTP ${response.statusCode}`));
          response.resume();
          return;
        }
        const chunks = [];
        let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > maxBytes) {
            request.destroy(new Error('订阅内容超过 20 MB 限制。'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => resolve(stripBom(Buffer.concat(chunks).toString('utf8'))));
      }
    );
    request.on('timeout', () => request.destroy(new Error('订阅下载超时。')));
    request.on('error', reject);
  });
}

function looksLikeClashYaml(text) {
  const value = stripBom(text).trim();
  if (!value || value.startsWith('<')) {
    return false;
  }
  try {
    const doc = yaml.load(value);
    return Boolean(
      doc &&
      typeof doc === 'object' &&
      (Array.isArray(doc.proxies) || Array.isArray(doc['proxy-groups']) || doc['proxy-providers'] || Array.isArray(doc.rules))
    );
  } catch (_error) {
    return false;
  }
}

function splitUriLines(text) {
  const decoded = decodeBase64Text(text) || text;
  return stripBom(decoded)
    .replace(/\r\n/g, '\n')
    .split(/\s+/)
    .map(item => item.trim())
    .filter(item => /^(ss|vmess|trojan|vless):\/\//i.test(item));
}

function uniqueName(base, used) {
  const root = String(base || 'Proxy').trim() || 'Proxy';
  let name = root;
  let index = 2;
  while (used.has(name)) {
    name = `${root} ${index}`;
    index += 1;
  }
  used.add(name);
  return name;
}

function parseSs(uri, used) {
  const raw = uri.replace(/^ss:\/\//i, '');
  const hashIndex = raw.indexOf('#');
  const beforeHash = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
  const name = hashIndex >= 0 ? safeDecodeURIComponent(raw.slice(hashIndex + 1)) : 'SS';
  let payload = beforeHash;
  let plugin = '';
  const queryIndex = payload.indexOf('?');
  if (queryIndex >= 0) {
    plugin = payload.slice(queryIndex + 1);
    payload = payload.slice(0, queryIndex);
  }
  if (!payload.includes('@')) {
    payload = decodeBase64Text(payload) || payload;
  }
  const at = payload.lastIndexOf('@');
  if (at < 0) {
    throw new Error('invalid ss uri');
  }
  const userinfo = payload.slice(0, at);
  const hostPort = payload.slice(at + 1);
  const colon = hostPort.lastIndexOf(':');
  const methodPassword = decodeBase64Text(userinfo) || userinfo;
  const separator = methodPassword.indexOf(':');
  if (colon < 0 || separator < 0) {
    throw new Error('invalid ss uri fields');
  }
  const proxy = {
    name: uniqueName(name, used),
    type: 'ss',
    server: hostPort.slice(0, colon),
    port: Number(hostPort.slice(colon + 1)),
    cipher: methodPassword.slice(0, separator),
    password: methodPassword.slice(separator + 1)
  };
  if (plugin) {
    proxy['plugin-opts'] = { raw: safeDecodeURIComponent(plugin) };
  }
  return proxy;
}

function parseVmess(uri, used) {
  const decoded = decodeBase64Text(uri.replace(/^vmess:\/\//i, ''));
  if (!decoded) {
    throw new Error('invalid vmess base64');
  }
  const item = JSON.parse(decoded);
  return {
    name: uniqueName(item.ps || item.name || 'VMess', used),
    type: 'vmess',
    server: item.add,
    port: Number(item.port),
    uuid: item.id,
    alterId: Number(item.aid || 0),
    cipher: item.scy || 'auto',
    tls: String(item.tls || '').toLowerCase() === 'tls',
    network: item.net || 'tcp',
    servername: item.sni || item.host || undefined,
    'ws-opts': item.net === 'ws' ? { path: item.path || '/', headers: item.host ? { Host: item.host } : undefined } : undefined
  };
}

function parseUrlProxy(uri, used) {
  const parsed = new URL(uri);
  const type = parsed.protocol.replace(':', '').toLowerCase();
  const name = uniqueName(parsed.hash ? safeDecodeURIComponent(parsed.hash.slice(1)) : type.toUpperCase(), used);
  const proxy = {
    name,
    type,
    server: parsed.hostname,
    port: Number(parsed.port),
    password: safeDecodeURIComponent(parsed.username || ''),
    uuid: safeDecodeURIComponent(parsed.username || ''),
    tls: parsed.searchParams.get('security') === 'tls' || parsed.searchParams.get('tls') === '1',
    servername: parsed.searchParams.get('sni') || parsed.searchParams.get('peer') || undefined
  };
  if (type === 'trojan') {
    delete proxy.uuid;
  }
  if (type === 'vless') {
    delete proxy.password;
    proxy.flow = parsed.searchParams.get('flow') || undefined;
    proxy.network = parsed.searchParams.get('type') || 'tcp';
  }
  return proxy;
}

function removeUndefined(value) {
  if (Array.isArray(value)) {
    return value.map(removeUndefined).filter(item => item !== undefined);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const cleaned = removeUndefined(item);
      if (cleaned !== undefined) {
        out[key] = cleaned;
      }
    }
    return out;
  }
  return value === undefined || value === '' || Number.isNaN(value) ? undefined : value;
}

function convertUrisToClashYaml(uris) {
  const used = new Set();
  const proxies = [];
  const skipped = [];
  for (const uri of uris) {
    try {
      const scheme = uri.match(/^([a-z0-9+.-]+):\/\//i)[1].toLowerCase();
      if (scheme === 'ss') {
        proxies.push(removeUndefined(parseSs(uri, used)));
      } else if (scheme === 'vmess') {
        proxies.push(removeUndefined(parseVmess(uri, used)));
      } else if (scheme === 'trojan' || scheme === 'vless') {
        proxies.push(removeUndefined(parseUrlProxy(uri, used)));
      } else {
        skipped.push(uri);
      }
    } catch (error) {
      skipped.push(`${uri} # ${error.message}`);
    }
  }
  if (!proxies.length) {
    throw new Error('订阅不是有效的 Clash/Mihomo YAML，且没有可转换的 ss/vmess/trojan/vless 节点。');
  }
  const names = proxies.map(proxy => proxy.name);
  const document = {
    proxies,
    'proxy-groups': [
      {
        name: 'Proxy',
        type: 'select',
        proxies: [...names, 'DIRECT']
      }
    ],
    rules: ['GEOIP,CN,DIRECT', 'MATCH,Proxy']
  };
  return {
    text: yaml.dump(document, { noRefs: true, sortKeys: false, lineWidth: -1 }),
    proxyCount: proxies.length,
    skippedCount: skipped.length
  };
}

async function readSource(source) {
  const sub = parseSubUrl(source);
  if (sub) {
    return { text: await fetchText(sub.url), sourceType: 'sub-url', displayName: sub.name || sub.url };
  }
  if (isHttpUrl(source)) {
    return { text: await fetchText(source), sourceType: 'subscription-url', displayName: source };
  }
  const file = path.resolve(source);
  if (!fs.existsSync(file)) {
    throw new Error(`订阅来源不存在：${source}`);
  }
  return { text: fs.readFileSync(file, 'utf8'), sourceType: 'file', displayName: file };
}

async function importSubscription(source, targetFile) {
  if (!source) {
    throw new Error('请输入订阅 URL、sub:// 链接或本地 YAML 文件。');
  }
  const payload = await readSource(source);
  let configText = payload.text;
  let proxyCount = 0;
  let converted = false;
  let skippedCount = 0;

  if (!looksLikeClashYaml(configText)) {
    const uris = splitUriLines(configText);
    const convertedResult = convertUrisToClashYaml(uris);
    configText = convertedResult.text;
    proxyCount = convertedResult.proxyCount;
    skippedCount = convertedResult.skippedCount;
    converted = true;
  } else {
    const doc = yaml.load(configText) || {};
    proxyCount = Array.isArray(doc.proxies) ? doc.proxies.length : 0;
  }

  ensureDir(path.dirname(targetFile));
  fs.writeFileSync(targetFile, configText.endsWith('\n') ? configText : `${configText}\n`);
  return {
    ok: true,
    sourceType: payload.sourceType,
    displayName: payload.displayName,
    targetFile,
    proxyCount,
    converted,
    skippedCount,
    importedAt: new Date().toISOString()
  };
}

module.exports = {
  importSubscription,
  looksLikeClashYaml,
  splitUriLines,
  convertUrisToClashYaml
};
