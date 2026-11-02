
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');

const { launchMinecraft } = require('./installer/launcher-service');

let mainWindow = null;
let minecraftAccount = null;
let isLaunching = false;

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

  mainWindow.loadFile('index.html');

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.executeJavaScript(`
      (() => {
        const buttons = [...document.querySelectorAll('button')];
        const playButton = buttons.find(button =>
          button.textContent.trim().toUpperCase() === 'JUGAR'
        );

        if (playButton && !playButton.dataset.connected) {
          playButton.dataset.connected = 'true';

          playButton.addEventListener('click', async () => {
            playButton.disabled = true;
            const originalText = playButton.textContent;
            playButton.textContent = 'PREPARANDO...';

            try {
              await window.launcherAPI.play();
            } finally {
              playButton.disabled = false;
              playButton.textContent = originalText;
            }
          });
        }
      })();
    `);
  });
}

async function authenticateMicrosoft() {
  const { MicrosoftAuth } = await import('eml-lib');
  const auth = new MicrosoftAuth(mainWindow);

  minecraftAccount = await auth.auth();

  return minecraftAccount;
}

ipcMain.handle('launcher:login', async () => {
  try {
    await authenticateMicrosoft();

    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: "Lucky'sMon",
      message: 'Inicio de sesión completado.',
      detail: 'Tu cuenta Microsoft se ha autenticado correctamente.'
    });

    return { success: true };
  } catch (error) {
    console.error('Error de autenticación:', error);

    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Error de inicio de sesión',
      message: 'No se ha podido iniciar sesión.',
      detail: error.message
    });

    return { success: false };
  }
});

ipcMain.handle('launcher:play', async () => {
  if (isLaunching) {
    return { success: false, message: 'El juego ya se está preparando.' };
  }

  isLaunching = true;

  try {
    if (!minecraftAccount) {
      console.log('[Lucky’sMon] Iniciando sesión Microsoft...');
      await authenticateMicrosoft();
    }

    console.log('[Lucky’sMon] Iniciando instalación y actualización...');

    await launchMinecraft(minecraftAccount, progress => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('launcher:progress', progress);
      }
    });

    return { success: true };

  } catch (error) {
    console.error('[Lucky’sMon] Error al iniciar:', error);

    if (mainWindow && !mainWindow.isDestroyed()) {
      await dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: "Lucky'sMon",
        message: 'No se ha podido iniciar Minecraft.',
        detail: error.message
      });
    }

    return { success: false, message: error.message };

  } finally {
    isLaunching = false;
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
