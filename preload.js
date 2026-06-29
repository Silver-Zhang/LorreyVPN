'use strict';

const { contextBridge, ipcRenderer, clipboard } = require('electron');

contextBridge.exposeInMainWorld('lorreyvpn', {
  invoke(action, payload = {}) {
    return ipcRenderer.invoke('LORREYVPN', action, payload);
  },
  copyText(value) {
    clipboard.writeText(String(value || ''));
  }
});
