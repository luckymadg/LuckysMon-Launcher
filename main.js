
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const dns = require('dns').promises;
const { autoUpdater } = require('electron-updater');

app.setPath(
  'userData',
  path.join(app.getPath('appData'), 'luckysmon-launcher')
);

const { launchMinecraft } = require('./installer/launcher-service');
const { updateModpack } = require('./installer/modpack-updater');

let mainWindow = null;
let minecraftAccount = null;
let isLaunching = false;
let modpackUpdatePromise = null;
let modpackUpdateFinished = false;
let modpackUpdateError = null;
let autoUpdaterConfigured = false;

// ESTADO DEL SERVIDOR

const SERVER_HOST = 'luckysmon.holy.gg';
const DEFAULT_SERVER_PORT = 26020;
const SERVER_CHECK_INTERVAL = 30000;
const SERVER_TIMEOUT = 8000;
const MINECRAFT_PROTOCOL = 767;

let serverCheckTimer = null;
let serverCheckRunning = false;

// REGISTROS

const logDirectory = app.getPath('userData');
const logFile = path.join(logDirectory, 'updater.log');

let lastModpackLog = {
  phase: null,
  package: null,
  percent: -1
};

// FUNCIONES GENERALES

function writeLog(message, error = null) {
  const timestamp = new Date().toISOString();
  let entry = `[${timestamp}] ${message}`;

  if (error) {
    entry += `\n${error.stack || error.message || error}`;
  }

  entry += '\n';

  try {
    fs.mkdirSync(logDirectory, { recursive: true });
    fs.appendFileSync(logFile, entry, 'utf8');
  } catch (logError) {
    console.error('No se pudo escribir el registro:', logError);
  }

  console.log(entry);
}

function sendStatus(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function showError(title, message, error) {
  writeLog(message, error);

  if (!mainWindow || mainWindow.isDestroyed()) return;

  dialog.showMessageBox(mainWindow, {
    type: 'error',
    title,
    message,
    detail: error?.stack || error?.message || String(error)
  }).catch(dialogError => {
    writeLog('Error mostrando el mensaje de error', dialogError);
  });
}

// ACTUALIZACIÓN DEL MODPACK

function sendModpackProgress(progress) {
  if (!progress || typeof progress !== 'object') return;

  const data = {
    ...progress,
    percent: Number.isFinite(progress.percent)
      ? Math.max(0, Math.min(100, progress.percent))
      : 0,
    overallPercent: Number.isFinite(progress.overallPercent)
      ? Math.max(0, Math.min(100, progress.overallPercent))
      : 0,
    speedBps: Number.isFinite(progress.speedBps)
      ? Math.max(0, progress.speedBps)
      : 0,
    downloadedBytes: Number.isFinite(progress.downloadedBytes)
      ? progress.downloadedBytes
      : 0,
    totalBytes: Number.isFinite(progress.totalBytes)
      ? progress.totalBytes
      : 0
  };

  sendStatus('modpack:update-progress', data);

  const roundedPercent = Math.floor(data.percent);

  const shouldLog =
    progress.phase !== lastModpackLog.phase ||
    progress.package !== lastModpackLog.package ||
    roundedPercent >= lastModpackLog.percent + 10 ||
    progress.phase === 'complete' ||
    progress.phase === 'package-complete';

  if (shouldLog) {
    writeLog(
      `Modpack: ${progress.phase || 'progreso'} | ` +
      `${progress.package || ''} | ` +
      `${Math.round(data.overallPercent)}% global | ` +
      `${roundedPercent}% fase | ` +
      `${progress.message || ''}`
    );

    lastModpackLog = {
      phase: progress.phase,
      package: progress.package,
      percent: roundedPercent
    };
  }
}

// CONSULTA DEL ESTADO DEL SERVIDOR MINECRAFT

function encodeVarInt(value) {
  const bytes = [];

  do {
    let byte = value & 0x7f;
    value >>>= 7;

    if (value !== 0) {
      byte |= 0x80;
    }

    bytes.push(byte);
  } while (value !== 0);

  return Buffer.from(bytes);
}

function decodeVarInt(buffer, offset = 0) {
  let value = 0;

  for (let i = 0; i < 5; i++) {
    const position = offset + i;

    if (position >= buffer.length) {
      return null;
    }

    const byte = buffer[position];

    value |= (byte & 0x7f) << (7 * i);

    if ((byte & 0x80) === 0) {
      return {
        value: value >>> 0,
        bytes: i + 1
      };
    }
  }

  throw new Error('VarInt inválido.');
}

function encodeMinecraftString(value) {
  const text = Buffer.from(value, 'utf8');

  return Buffer.concat([
    encodeVarInt(text.length),
    text
  ]);
}

function makePacket(data) {
  return Buffer.concat([
    encodeVarInt(data.length),
    data
  ]);
}

// RESOLVER EL REGISTRO SRV

async function resolveMinecraftAddress() {
  try {
    writeLog(`Buscando registro SRV de ${SERVER_HOST}...`);

    const records = await dns.resolveSrv(
      `_minecraft._tcp.${SERVER_HOST}`
    );

    if (!records || records.length === 0) {
      throw new Error('El registro SRV no contiene resultados.');
    }

    records.sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }

      return b.weight - a.weight;
    });

    const record = records[0];

    const address = {
      host: record.name.replace(/\.$/, ''),
      port: record.port
    };

    writeLog(
      `Registro SRV encontrado: ${address.host}:${address.port}`
    );

    return address;

  } catch (error) {
    writeLog(
      `No se pudo resolver el registro SRV: ${error.message}`
    );

    writeLog(
      `Se utilizará el dominio principal ${SERVER_HOST}:${DEFAULT_SERVER_PORT}.`
    );

    return {
      host: SERVER_HOST,
      port: DEFAULT_SERVER_PORT
    };
  }
}

// CONSULTAR EL SERVIDOR

function queryMinecraftServer(host, port) {
  return new Promise(resolve => {
    const socket = new net.Socket();

    let received = Buffer.alloc(0);
    let finished = false;

    const startedAt = Date.now();

    function finish(result) {
      if (finished) return;

      finished = true;
      socket.destroy();

      resolve(result);
    }

    socket.setTimeout(SERVER_TIMEOUT);

    socket.on('timeout', () => {
      finish({
        online: false,
        error: 'Tiempo de espera agotado.'
      });
    });

    socket.on('error', error => {
      finish({
        online: false,
        error: error.message
      });
    });

    socket.on('connect', () => {
      try {
        writeLog(
          `Conexión TCP establecida con ${host}:${port}.`
        );

        // El destino TCP es el host del SRV.
        // El handshake utiliza el dominio público del servidor.

        const handshake = Buffer.concat([
          encodeVarInt(0),
          encodeVarInt(MINECRAFT_PROTOCOL),
          encodeMinecraftString(SERVER_HOST),
          Buffer.from([
            (port >> 8) & 0xff,
            port & 0xff
          ]),
          encodeVarInt(1)
        ]);

        // Paquete Handshake.
        socket.write(makePacket(handshake));

        // Paquete Status Request.
        socket.write(makePacket(encodeVarInt(0)));

        writeLog('Handshake y solicitud de estado enviados.');

      } catch (error) {
        finish({
          online: false,
          error: error.message
        });
      }
    });

    socket.on('data', chunk => {
      if (finished) return;

      received = Buffer.concat([received, chunk]);

      try {
        const packetLength = decodeVarInt(received);

        if (!packetLength) return;

        const headerLength = packetLength.bytes;
        const totalLength = headerLength + packetLength.value;

        if (received.length < totalLength) return;

        const packet = received.subarray(
          headerLength,
          totalLength
        );

        const packetId = decodeVarInt(packet);

        if (!packetId || packetId.value !== 0) {
          finish({
            online: false,
            error: 'Respuesta de estado no válida.'
          });

          return;
        }

        const stringLength = decodeVarInt(
          packet,
          packetId.bytes
        );

        if (!stringLength) return;

        const jsonStart =
          packetId.bytes + stringLength.bytes;

        const jsonEnd =
          jsonStart + stringLength.value;

        if (jsonEnd > packet.length) {
          finish({
            online: false,
            error: 'Respuesta incompleta del servidor.'
          });

          return;
        }

        const jsonText = packet.toString(
          'utf8',
          jsonStart,
          jsonEnd
        );

        const status = JSON.parse(jsonText);

        const description = status.description;

        let descriptionText = 'Servidor LuckysMon';

        if (typeof description === 'string') {
          descriptionText = description;
        } else if (description && typeof description === 'object') {
          if (typeof description.text === 'string') {
            descriptionText = description.text;
          } else if (Array.isArray(description.extra)) {
            descriptionText = description.extra
              .map(item => item.text || '')
              .join('');
          }
        }

        const result = {
          online: true,
          latency: Date.now() - startedAt,
          version: status.version?.name || 'Desconocida',
          playersOnline: status.players?.online ?? 0,
          playersMax: status.players?.max ?? 0,
          description: descriptionText
        };

        writeLog(
          `Respuesta recibida: ${result.version} | ` +
          `${result.playersOnline}/${result.playersMax} jugadores.`
        );

        finish(result);

      } catch (error) {
        finish({
          online: false,
          error: `Error leyendo la respuesta: ${error.message}`
        });
      }
    });

    writeLog(`Conectando con ${host}:${port}...`);

    socket.connect({
      host,
      port
    });
  });
}

// COMPROBAR EL ESTADO DEL SERVIDOR

async function checkMinecraftServer() {
  if (serverCheckRunning) return;

  serverCheckRunning = true;

  try {
    writeLog('Iniciando comprobación del servidor.');

    const address = await resolveMinecraftAddress();

    const result = await queryMinecraftServer(
      address.host,
      address.port
    );

    sendStatus('server:status', result);

    if (result.online) {
      writeLog(
        `Servidor ONLINE: ${result.playersOnline}/${result.playersMax} jugadores. ` +
        `Latencia: ${result.latency} ms.`
      );
    } else {
      writeLog(
        `Servidor OFFLINE: ${result.error || 'Sin respuesta.'}`
      );
    }

  } catch (error) {
    sendStatus('server:status', {
      online: false,
      error: error.message
    });

    writeLog('Error consultando el servidor.', error);

  } finally {
    serverCheckRunning = false;
  }
}

// INICIAR COMPROBACIONES AUTOMÁTICAS

function startServerMonitoring() {
  if (serverCheckTimer) {
    clearInterval(serverCheckTimer);
    serverCheckTimer = null;
  }

  writeLog('Monitor del servidor iniciado.');

  sendStatus('server:status', {
    online: false,
    checking: true,
    error: null
  });

  checkMinecraftServer();

  serverCheckTimer = setInterval(
    checkMinecraftServer,
    SERVER_CHECK_INTERVAL
  );
}

// VENTANA PRINCIPAL

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 850,
    minHeight: 600,
    title: "Lucky'sMon",
    autoHideMenuBar: true,
    backgroundColor: '#151519',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.webContents.once('did-finish-load', () => {
    writeLog('Interfaz del launcher cargada.');

    configureAutoUpdater();
    startServerMonitoring();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// AUTENTICACIÓN MICROSOFT

async function authenticateMicrosoft() {
  const { MicrosoftAuth } = await import('eml-lib');
  const auth = new MicrosoftAuth(mainWindow);

  minecraftAccount = await auth.auth();

  return minecraftAccount;
}

// ACTUALIZADOR DEL MODPACK

async function updateModpackAtStartup() {
  try {
    lastModpackLog = {
      phase: null,
      package: null,
      percent: -1
    };

    modpackUpdateFinished = false;
    modpackUpdateError = null;

    writeLog('Comprobando actualizaciones del modpack.');

    sendStatus('modpack:update-status', {
      phase: 'checking',
      message: 'Comprobando actualizaciones del modpack...'
    });

    const installDirectory = path.join(
      app.getPath('appData'),
      '.LuckysMon'
    );

    writeLog(`Directorio de instalación: ${installDirectory}`);

    const result = await updateModpack(
      installDirectory,
      progress => {
        sendModpackProgress(progress);
      }
    );

    modpackUpdateFinished = true;
    modpackUpdateError = null;

    writeLog(`Modpack actualizado. Versión: ${result.version}`);

    sendStatus('modpack:update-status', {
      phase: 'complete',
      message: 'Modpack actualizado correctamente.',
      result
    });

    return { success: true, result };

  } catch (error) {
    modpackUpdateFinished = true;
    modpackUpdateError = error;

    showError(
      'Error de actualización del modpack',
      'No se ha podido actualizar el modpack.',
      error
    );

    sendStatus('modpack:update-status', {
      phase: 'error',
      message: 'Error al actualizar el modpack.',
      error: error.message
    });

    return { success: false, error };
  }
}

// ACTUALIZADOR DEL LAUNCHER

function configureAutoUpdater() {
  if (autoUpdaterConfigured) return;

  autoUpdaterConfigured = true;

  if (!app.isPackaged) {
    writeLog(
      'Actualizador del launcher omitido: ejecución en modo desarrollo.'
    );

    sendStatus('launcher:update-status', {
      phase: 'skipped',
      message: 'La comprobación de actualizaciones estará disponible en la versión instalada.'
    });

    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    writeLog('Buscando actualizaciones del launcher.');

    sendStatus('launcher:update-status', {
      phase: 'checking',
      message: 'Buscando actualizaciones del launcher...'
    });
  });

  autoUpdater.on('update-available', info => {
    writeLog(`Actualización del launcher encontrada: ${info.version}`);

    sendStatus('launcher:update-status', {
      phase: 'downloading',
      version: info.version,
      message: `Descargando launcher ${info.version}...`
    });
  });

  autoUpdater.on('update-not-available', info => {
    writeLog('El launcher está actualizado.');

    sendStatus('launcher:update-status', {
      phase: 'complete',
      version: info.version,
      message: 'El launcher está actualizado.'
    });
  });

  autoUpdater.on('download-progress', progress => {
    const data = {
      phase: 'downloading',
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
      message: `Descargando actualización: ${Math.round(progress.percent)} %`
    };

    sendStatus('launcher:update-progress', data);
  });

  autoUpdater.on('update-downloaded', async info => {
    writeLog(`Actualización descargada: ${info.version}`);

    sendStatus('launcher:update-status', {
      phase: 'downloaded',
      version: info.version,
      message: `Launcher ${info.version} descargado.`
    });

    if (!mainWindow || mainWindow.isDestroyed()) return;

    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: "Actualización de Lucky'sMon",
      message: 'La actualización está lista para instalarse.',
      detail: `Se ha descargado la versión ${info.version}. ¿Quieres reiniciar el launcher para instalarla?`,
      buttons: ['Reiniciar ahora', 'Más tarde'],
      defaultId: 0,
      cancelId: 1
    });

    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on('error', error => {
    showError(
      "Error de actualización de Lucky'sMon",
      'Ha ocurrido un error al actualizar el launcher.',
      error
    );

    sendStatus('launcher:update-status', {
      phase: 'error',
      message: 'Error al actualizar el launcher.',
      error: error.message
    });
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(error => {
      showError(
        'Error comprobando actualizaciones',
        'No se han podido comprobar las actualizaciones del launcher.',
        error
      );
    });
  }, 5000);
}

// INICIO DE SESIÓN

ipcMain.handle('launcher:login', async () => {
  try {
    await authenticateMicrosoft();

    return { success: true };

  } catch (error) {
    showError(
      'Error de inicio de sesión',
      'No se ha podido iniciar sesión.',
      error
    );

    return { success: false };
  }
});

// INICIAR MINECRAFT

ipcMain.handle('launcher:play', async () => {
  if (isLaunching) {
    return {
      success: false,
      message: 'El juego ya se está preparando.'
    };
  }

  isLaunching = true;

  try {
    if (modpackUpdatePromise) {
      await modpackUpdatePromise;
    }

    if (!modpackUpdateFinished || modpackUpdateError) {
      throw new Error(
        'El modpack no está actualizado. No se puede iniciar Minecraft.'
      );
    }

    if (!minecraftAccount) {
      writeLog('Iniciando sesión Microsoft.');
      await authenticateMicrosoft();
    }

    writeLog('Iniciando instalación y actualización de Minecraft.');

    sendStatus('launcher:game-status', {
      phase: 'preparing',
      message: 'Preparando Minecraft...'
    });

    await launchMinecraft(minecraftAccount, progress => {
      sendStatus('launcher:game-status', progress);
      sendStatus('launcher:progress', progress);
    });

    return { success: true };

  } catch (error) {
    showError(
      "Error al iniciar Lucky'sMon",
      'No se ha podido iniciar Minecraft.',
      error
    );

    sendStatus('launcher:game-status', {
      phase: 'error',
      message: 'No se ha podido iniciar Minecraft.',
      error: error.message
    });

    return {
      success: false,
      message: error.message
    };

  } finally {
    isLaunching = false;
  }
});

// ARRANQUE DEL LAUNCHER

app.whenReady().then(() => {
  createWindow();

  writeLog("Lucky'sMon iniciado.");

  modpackUpdatePromise = updateModpackAtStartup();
});

// CIERRE DEL LAUNCHER

app.on('window-all-closed', () => {
  if (serverCheckTimer) {
    clearInterval(serverCheckTimer);
    serverCheckTimer = null;
  }

  if (process.platform !== 'darwin') {
    app.quit();
  }
});
