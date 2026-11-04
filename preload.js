
const { contextBridge, ipcRenderer } = require('electron');

// Función común para escuchar eventos de forma segura.
// Devuelve una función para retirar el listener cuando ya no se necesite.
function subscribe(channel, callback) {
  if (typeof callback !== 'function') {
    throw new TypeError(`El callback de ${channel} debe ser una función.`);
  }

  const listener = (_event, data) => {
    callback(data);
  };

  ipcRenderer.on(channel, listener);

  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('launcherAPI', {

  // ==========================================
  // ACCIONES DEL LAUNCHER
  // ==========================================

  login: () => ipcRenderer.invoke('launcher:login'),

  play: () => ipcRenderer.invoke('launcher:play'),


  // ==========================================
  // ACTUALIZACIONES DEL LAUNCHER ELECTRON
  // ==========================================

  onLauncherUpdateStatus: callback =>
    subscribe('launcher:update-status', callback),

  onLauncherUpdateProgress: callback =>
    subscribe('launcher:update-progress', callback),


  // ==========================================
  // ACTUALIZACIONES AUTOMÁTICAS DEL MODPACK
  // ==========================================

  onModpackUpdateStatus: callback =>
    subscribe('modpack:update-status', callback),

  onModpackUpdateProgress: callback =>
    subscribe('modpack:update-progress', callback),


  // ==========================================
  // ESTADO Y PROGRESO DE MINECRAFT
  // ==========================================

  onGameStatus: callback =>
    subscribe('launcher:game-status', callback),

  onGameProgress: callback =>
    subscribe('launcher:progress', callback),


  // ==========================================
  // ESTADO DEL SERVIDOR LUCKYSMON
  // ==========================================

  onServerStatus: callback => {
    console.log('[Preload] Listener del servidor registrado');

    return subscribe('server:status', data => {
      console.log('[Preload] Estado recibido:', data);
      callback(data);
    });
  }

});
