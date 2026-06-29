'use strict';

const http = require('http');

function requestJson(options = {}) {
  const method = options.method || 'GET';
  const body = options.body ? JSON.stringify(options.body) : null;
  const port = options.port || 4790;
  const secret = options.secret || '';
  const pathname = options.path || '/configs';

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method,
        timeout: options.timeout || 5000,
        headers: {
          'Content-Type': 'application/json',
          ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {})
        }
      },
      response => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          raw += chunk;
        });
        response.on('end', () => {
          if (response.statusCode >= 400) {
            reject(new Error(`mihomo controller ${method} ${pathname} returned HTTP ${response.statusCode}`));
            return;
          }
          if (!raw.trim()) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (_error) {
            resolve(raw);
          }
        });
      }
    );

    request.on('timeout', () => request.destroy(new Error(`mihomo controller request timeout: ${method} ${pathname}`)));
    request.on('error', reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

async function waitForController(port, secret, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await requestJson({ port, secret, path: '/configs', timeout: 1200 });
      return true;
    } catch (_error) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  return false;
}

function getConfigs(port, secret) {
  return requestJson({ port, secret, path: '/configs' });
}

function setMode(port, secret, mode) {
  return requestJson({
    port,
    secret,
    path: '/configs',
    method: 'PATCH',
    body: { mode }
  });
}

function getProxies(port, secret) {
  return requestJson({ port, secret, path: '/proxies' });
}

function setProxy(port, secret, selector, name) {
  return requestJson({
    port,
    secret,
    path: `/proxies/${encodeURIComponent(selector)}`,
    method: 'PUT',
    body: { name }
  });
}

function closeConnections(port, secret) {
  return requestJson({ port, secret, path: '/connections', method: 'DELETE' });
}

function testDelay(port, secret, name, url = 'https://www.gstatic.com/generate_204', timeout = 5000) {
  return requestJson({
    port,
    secret,
    path: `/proxies/${encodeURIComponent(name)}/delay?timeout=${timeout}&url=${encodeURIComponent(url)}`,
    timeout: timeout + 2000
  });
}

module.exports = {
  requestJson,
  waitForController,
  getConfigs,
  setMode,
  getProxies,
  setProxy,
  closeConnections,
  testDelay
};
