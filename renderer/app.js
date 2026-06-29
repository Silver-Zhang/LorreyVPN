(function () {
  'use strict';

  const api = window.lorreyvpn;
  const state = {
    dashboard: null,
    delays: new Map(),
    busy: false
  };

  function $(selector) {
    return document.querySelector(selector);
  }

  function $$(selector) {
    return Array.from(document.querySelectorAll(selector));
  }

  function setText(selector, value) {
    const node = $(selector);
    if (node) {
      node.textContent = value == null || value === '' ? '-' : String(value);
    }
  }

  function toast(message) {
    const node = $('#toast');
    node.textContent = message;
    node.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.add('hidden'), 2600);
  }

  async function invoke(action, payload) {
    const response = await api.invoke(action, payload || {});
    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : '操作失败。');
    }
    return response.data;
  }

  function modeLabel(mode) {
    const value = String(mode || '').toLowerCase();
    if (value === 'global') {
      return '全局代理';
    }
    if (value === 'direct') {
      return '直连模式';
    }
    return '智能代理';
  }

  function getProxyList(dashboard) {
    const core = dashboard && dashboard.core ? dashboard.core : {};
    const response = core.proxies || {};
    const proxies = response.proxies || {};
    const selector = core.selector || 'Proxy';
    const group = proxies[selector] || proxies.Proxy || proxies.GLOBAL || {};
    const all = Array.isArray(group.all) ? group.all : [];
    return {
      selector,
      current: group.now || core.node || dashboard.settings.currentProxy || '',
      nodes: all.filter(name => !['DIRECT', 'REJECT', 'PASS'].includes(name))
    };
  }

  function renderNodes(dashboard) {
    const box = $('#nodes');
    const { current, nodes } = getProxyList(dashboard);
    box.innerHTML = '';
    if (!nodes.length) {
      box.innerHTML = '<p class="hint">没有可显示的节点。请先导入订阅并启动核心。</p>';
      return;
    }

    for (const name of nodes) {
      const delay = state.delays.get(name);
      const card = document.createElement('div');
      card.className = `node-card${name === current ? ' active' : ''}`;
      card.innerHTML = `
        <div class="node-name"></div>
        <div class="node-meta">${delay == null ? '延迟未测试' : `${delay} ms`}</div>
        <div class="row-actions">
          <button class="secondary node-delay">测速</button>
          <button class="node-use">切换</button>
        </div>
      `;
      card.querySelector('.node-name').textContent = name;
      card.querySelector('.node-delay').addEventListener('click', () => delayNode(name));
      card.querySelector('.node-use').addEventListener('click', () => switchNode(name));
      box.appendChild(card);
    }
  }

  function render(dashboard) {
    state.dashboard = dashboard;
    const core = dashboard.core || {};
    const settings = dashboard.settings || {};
    const proxyStatus = dashboard.proxyStatus || {};

    $('#platformWarning').classList.toggle('hidden', dashboard.platform === 'win32');
    setText('#coreState', core.running ? '运行中' : '未运行');
    setText('#systemProxyState', proxyStatus.enabled ? '已开启' : '未开启');
    setText('#modeState', modeLabel(settings.mode));
    setText('#nodeState', core.node || settings.currentProxy || '未选择');
    setText('#configPath', dashboard.activeConfigFile);
    setText('#logsPath', dashboard.logsDir);
    setText('#corePath', dashboard.corePath || '未找到，请运行 npm run install:core');
    $('#logTail').textContent = dashboard.logTail || '';

    const bypassInput = $('#bypassHosts');
    if (document.activeElement !== bypassInput) {
      bypassInput.value = Array.isArray(settings.bypassHosts) ? settings.bypassHosts.join('\n') : '';
    }

    $$('.mode-button').forEach(button => {
      button.classList.toggle('active', button.dataset.mode === settings.mode);
    });

    renderNodes(dashboard);
  }

  async function refresh() {
    const dashboard = await invoke('dashboard');
    render(dashboard);
  }

  async function runBusy(task, message) {
    if (state.busy) {
      return;
    }
    state.busy = true;
    $$('button').forEach(button => { button.disabled = true; });
    try {
      await task();
      if (message) {
        toast(message);
      }
    } catch (error) {
      toast(error.message || String(error));
    } finally {
      state.busy = false;
      $$('button').forEach(button => { button.disabled = false; });
    }
  }

  function bindEvents() {
    $('#refreshDashboard').addEventListener('click', () => runBusy(refresh, '状态已刷新'));
    $('#startCore').addEventListener('click', () => runBusy(async () => render(await invoke('core:start')), '核心已启动'));
    $('#stopCore').addEventListener('click', () => runBusy(async () => render(await invoke('core:stop')), '核心已停止'));
    $('#enableProxy').addEventListener('click', () => runBusy(async () => render(await invoke('system-proxy:set', { enabled: true })), '系统代理已开启'));
    $('#disableProxy').addEventListener('click', () => runBusy(async () => render(await invoke('system-proxy:set', { enabled: false })), '系统代理已关闭'));
    $('#saveBypass').addEventListener('click', () => runBusy(async () => render(await invoke('bypass:save', { text: $('#bypassHosts').value })), '绕过地址已保存'));
    $('#openConfig').addEventListener('click', () => invoke('paths:open-config').catch(error => toast(error.message)));
    $('#openLogs').addEventListener('click', () => invoke('paths:open-logs').catch(error => toast(error.message)));
    $('#copyLog').addEventListener('click', () => {
      api.copyText($('#logTail').textContent || '');
      toast('日志已复制');
    });

    $$('.mode-button').forEach(button => {
      button.addEventListener('click', () => runBusy(async () => render(await invoke('mode:set', { mode: button.dataset.mode })), '模式已切换'));
    });

    $('#importForm').addEventListener('submit', event => {
      event.preventDefault();
      const source = $('#subscriptionSource').value.trim();
      runBusy(async () => {
        const payload = await invoke('subscription:import', { source });
        render(payload.dashboard);
        const result = payload.result || {};
        $('#importResult').textContent = `导入完成：${result.proxyCount || 0} 个节点${result.converted ? '，已从 URI 列表转换' : ''}`;
      }, '订阅已导入');
    });

    $('#delayAll').addEventListener('click', () => runBusy(delayAll, '延迟测试完成'));
  }

  async function switchNode(name) {
    await runBusy(async () => render(await invoke('proxy:switch', { name })), `已切换：${name}`);
  }

  async function delayNode(name) {
    await runBusy(async () => {
      const result = await invoke('proxy:delay', { name });
      state.delays.set(name, result.delay);
      render(state.dashboard);
    }, '延迟测试完成');
  }

  async function delayAll() {
    const { nodes } = getProxyList(state.dashboard);
    for (const name of nodes) {
      try {
        const result = await invoke('proxy:delay', { name });
        state.delays.set(name, result.delay);
        render(state.dashboard);
      } catch (_error) {
        state.delays.set(name, null);
      }
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    refresh().catch(error => toast(error.message || String(error)));
    setInterval(() => refresh().catch(() => null), 5000);
  });
})();
