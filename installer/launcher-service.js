
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
      }
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

  const emit = (phase, message, extra = {}) => {
    onProgress({
      phase,
      message,
      ...extra
    });
  };

  emit('preparing', 'Preparando Minecraft...');

  const launcher = new Launcher(config);

  const eventMessages = {
    launch_compute_download: {
      phase: 'preparing',
      message: 'Comprobando los archivos de Minecraft...'
    },
    launch_download: {
      phase: 'downloading',
      message: 'Descargando archivos de Minecraft...'
    },
    launch_install_loader: {
      phase: 'installing',
      message: 'Instalando Fabric...'
    },
    launch_check_java: {
      phase: 'checking-java',
      message: 'Comprobando Java...'
    },
    launch_launch: {
      phase: 'running',
      message: 'Minecraft iniciado correctamente.'
    },
    launch_close: {
      phase: 'closed',
      message: 'Minecraft cerrado.'
    },
    launch_crash: {
      phase: 'error',
      message: 'Minecraft se ha cerrado inesperadamente.'
    },
    download_error: {
      phase: 'error',
      message: 'Error descargando archivos de Minecraft.'
    }
  };

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
    'launch_data',
    'launch_debug'
  ];

  for (const event of events) {
    launcher.on(event, data => {
      console.log(`[Lucky'sMon] ${event}:`, data ?? '');

      if (event === 'launch_data' || event === 'launch_debug') {
        return;
      }

      if (event === 'download_progress') {
        const percent = Number(
          data?.percent ??
          data?.progress ??
          data?.percentage
        );

        emit(
          'downloading',
          Number.isFinite(percent)
            ? `Descargando archivos: ${Math.round(percent)} %`
            : 'Descargando archivos de Minecraft...',
          Number.isFinite(percent) ? { percent } : {}
        );

        return;
      }

      const status = eventMessages[event];

      if (status) {
        emit(status.phase, status.message, {
          event,
          details: data ?? null
        });
      }
    });
  }

  try {
    await launcher.launch();

    // EML puede resolver launch() cuando el juego ya se ha cerrado.
    // No marcamos aquí el juego como iniciado.
    return { success: true };

  } catch (error) {
    console.error('[Lucky\'sMon] Error al iniciar Minecraft:', error);

    emit(
      'error',
      error.message || 'No se pudo iniciar Minecraft.'
    );

    throw error;
  }
}

module.exports = { launchMinecraft };
