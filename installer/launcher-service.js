
const { Launcher } = require('eml-lib');

async function launchMinecraft(account, onProgress = () => {}) {
  if (!account) {
    throw new Error('No hay ninguna cuenta Microsoft autenticada.');
  }

  const config = {
    root: 'LuckysMon',
    account,

    minecraft: {
      version: '1.21.1',
      loader: {
        loader: 'fabric',
        version: '0.20.1'
      },
      modpackUrl: 'http://127.0.0.1:8080/modpack.json'
    },

    storage: 'isolated',

    java: {
      install: 'auto'
    },

    memory: {
      min: 2048,
      max: 6144
    },

    cleaning: {
      enabled: false
    }
  };

  const launcher = new Launcher(config);

  const events = [
    'launch_compute_download',
    'launch_download',
    'launch_install_loader',
    'launch_check_java',
    'launch_launch',
    'launch_close',
    'launch_crash',
    'download_progress',
    'download_error',
    'launch_data'
  ];

  for (const event of events) {
    launcher.on(event, data => {
      if (event === 'launch_launch') {
        console.log('[LuckyMon] Versión:', data.version);
        console.log('[LuckyMon] Cargador:', data.loader);
      } else {
        console.log(`[LuckyMon] ${event}:`, data ?? '');
      }

      onProgress({ event, data: data ?? null });
    });
  }

  await launcher.launch();
}

module.exports = { launchMinecraft };
