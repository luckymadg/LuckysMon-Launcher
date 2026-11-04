
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const yauzl = require('yauzl');

const VERSION_URL =
  'https://raw.githubusercontent.com/luckymadg/LuckysMon-Launcher/main/modpack-version.json';

const RELEASE_BASE_URL =
  'https://github.com/luckymadg/LuckysMon-Launcher/releases/download';

const REGISTRY_FILE = '.luckysmon-managed.json';
const CACHE_DIR = '.luckysmon-cache';

const PERSONAL_FILES = new Set([
  'options.txt',
  'servers.dat'
]);

// Datos personales que nunca debe sobrescribir ni eliminar el launcher.
function isProtectedPersonalData(relative) {
  const normalized = relative.replace(/\\/g, '/').toLowerCase();

  return (
    normalized === 'xaerowaypoints' ||
    normalized.startsWith('xaerowaypoints/') ||
    normalized === 'xaeroworldmap' ||
    normalized.startsWith('xaeroworldmap/') ||
    normalized === 'journeymap' ||
    normalized.startsWith('journeymap/')
  );
}

// La configuración de Xaero se instala inicialmente,
// pero se conserva cuando ya existe en el ordenador del jugador.
function isXaeroConfig(relative) {
  const normalized = relative.replace(/\\/g, '/').toLowerCase();

  return (
    normalized === 'config/xaero' ||
    normalized.startsWith('config/xaero/')
  );
}

function emitProgress(onProgress, data) {
  try {
    onProgress(data);
  } catch (error) {
    console.error('Error notificando el progreso:', error);
  }
}

function sha1File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(filePath);

    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function safeRelativePath(value) {
  const relative = String(value || '').replace(/\\/g, '/');

  if (
    !relative ||
    relative.startsWith('/') ||
    /^[a-z]:/i.test(relative) ||
    relative.includes('\0') ||
    relative.split('/').some(part => part === '..' || part === '')
  ) {
    throw new Error(`Ruta no válida en el índice: ${relative}`);
  }

  return relative;
}

function resolveInside(root, relative) {
  const destination = path.resolve(root, ...relative.split('/'));

  if (
    destination !== root &&
    !destination.startsWith(root + path.sep)
  ) {
    throw new Error(`Ruta fuera de la instalación: ${relative}`);
  }

  return destination;
}

// DESCARGA HTTPS CON REDIRECCIONES

function requestBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      return reject(new Error('Demasiadas redirecciones.'));
    }

    let parsed;

    try {
      parsed = new URL(url);
    } catch {
      return reject(new Error(`URL no válida: ${url}`));
    }

    if (parsed.protocol !== 'https:') {
      return reject(new Error('Solo se permiten descargas HTTPS.'));
    }

    https.get(parsed, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = response.headers.location;
        response.resume();

        if (!location) {
          return reject(new Error('Redirección sin destino.'));
        }

        return resolve(
          requestBuffer(
            new URL(location, parsed).toString(),
            redirects + 1
          )
        );
      }

      if (response.statusCode !== 200) {
        response.resume();

        return reject(
          new Error(`Error HTTP ${response.statusCode}: ${url}`)
        );
      }

      const chunks = [];

      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    }).on('error', reject);
  });
}

function downloadToFile(
  url,
  destination,
  onDownload = () => {},
  redirects = 0
) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      return reject(new Error('Demasiadas redirecciones.'));
    }

    let parsed;

    try {
      parsed = new URL(url);
    } catch {
      return reject(new Error(`URL no válida: ${url}`));
    }

    if (parsed.protocol !== 'https:') {
      return reject(new Error('Solo se permiten descargas HTTPS.'));
    }

    const temporary = `${destination}.download`;

    const request = https.get(parsed, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = response.headers.location;
        response.resume();

        if (!location) {
          return reject(new Error('Redirección sin destino.'));
        }

        return resolve(
          downloadToFile(
            new URL(location, parsed).toString(),
            destination,
            onDownload,
            redirects + 1
          )
        );
      }

      if (response.statusCode !== 200) {
        response.resume();

        return reject(
          new Error(`Error HTTP ${response.statusCode}: ${url}`)
        );
      }

      const totalBytes =
        Number(response.headers['content-length']) || 0;

      let downloadedBytes = 0;
      let lastReport = Date.now();
      let lastBytes = 0;

      const output = fs.createWriteStream(temporary);

      response.on('data', chunk => {
        downloadedBytes += chunk.length;

        const now = Date.now();

        if (
          now - lastReport >= 150 ||
          (totalBytes > 0 && downloadedBytes >= totalBytes)
        ) {
          const elapsedSeconds = Math.max(
            (now - lastReport) / 1000,
            0.001
          );

          const speedBps =
            (downloadedBytes - lastBytes) / elapsedSeconds;

          onDownload({
            downloadedBytes,
            totalBytes,
            speedBps,
            percent: totalBytes > 0
              ? Math.min(100, (downloadedBytes / totalBytes) * 100)
              : null
          });

          lastReport = now;
          lastBytes = downloadedBytes;
        }
      });

      response.on('error', error => {
        output.destroy();
        fs.rmSync(temporary, { force: true });
        reject(error);
      });

      output.on('error', error => {
        response.destroy();
        fs.rmSync(temporary, { force: true });
        reject(error);
      });

      output.on('finish', () => {
        output.close(error => {
          if (error) {
            fs.rmSync(temporary, { force: true });
            return reject(error);
          }

          try {
            fs.renameSync(temporary, destination);

            onDownload({
              downloadedBytes,
              totalBytes: totalBytes || downloadedBytes,
              speedBps: 0,
              percent: 100
            });

            resolve({
              downloadedBytes,
              totalBytes: totalBytes || downloadedBytes
            });
          } catch (renameError) {
            fs.rmSync(temporary, { force: true });
            reject(renameError);
          }
        });
      });

      response.pipe(output);
    });

    request.on('error', error => {
      fs.rmSync(temporary, { force: true });
      reject(error);
    });
  });
}

// LEER LA VERSIÓN PUBLICADA EN GITHUB

async function getModpackVersion() {
  const buffer = await requestBuffer(VERSION_URL);

  let data;

  try {
    data = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new Error(
      'El archivo modpack-version.json de GitHub no es un JSON válido.'
    );
  }

  if (
    !data ||
    typeof data.version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(data.version)
  ) {
    throw new Error(
      'La versión publicada del modpack no tiene un formato válido.'
    );
  }

  return data.version;
}

// REGISTRO DE ARCHIVOS INSTALADOS

function readRegistry(filePath) {
  if (!fs.existsSync(filePath)) return {};

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new Error(
      'El registro de Lucky\'sMon está dañado. No se borrará ningún archivo.'
    );
  }
}

function saveRegistry(filePath, registry) {
  const temporary = `${filePath}.tmp`;

  fs.writeFileSync(
    temporary,
    JSON.stringify(registry, null, 2)
  );

  fs.renameSync(temporary, filePath);
}

// EXTRACCIÓN INTELIGENTE DE PAQUETES

function extractPackage(
  zipPath,
  expectedFiles,
  root,
  previousRegistry,
  nextRegistry,
  onExtract = () => {}
) {
  return new Promise((resolve, reject) => {
    yauzl.open(
      zipPath,
      { lazyEntries: true, autoClose: true },
      (error, zip) => {
        if (error) return reject(error);

        const expected = new Map(
          expectedFiles.map(file => [file.path, file])
        );

        const seen = new Set();

        let extracted = 0;
        let preserved = 0;
        let unchanged = 0;
        let processedBytes = 0;
        let processedFiles = 0;
        let settled = false;

        const totalBytes = expectedFiles.reduce(
          (sum, file) => sum + file.size,
          0
        );

        const finishError = err => {
          if (settled) return;

          settled = true;
          reject(err);
        };

        const report = (
          phase,
          currentFile,
          currentFileBytes = 0
        ) => {
          onExtract({
            phase,
            processedBytes: Math.min(
              totalBytes,
              processedBytes + currentFileBytes
            ),
            totalBytes,
            processedFiles,
            totalFiles: expectedFiles.length,
            currentFile,
            percent: totalBytes > 0
              ? Math.min(
                  100,
                  (
                    (processedBytes + currentFileBytes) /
                    totalBytes
                  ) * 100
                )
              : expectedFiles.length > 0
                ? (processedFiles / expectedFiles.length) * 100
                : 100
          });
        };

        zip.on('error', finishError);

        zip.on('entry', entry => {
          if (settled) return;

          if (entry.fileName.endsWith('/')) {
            zip.readEntry();
            return;
          }

          let relative;

          try {
            relative = safeRelativePath(entry.fileName);
          } catch (err) {
            return finishError(err);
          }

          const file = expected.get(relative);

          if (!file || seen.has(relative)) {
            return finishError(
              new Error(
                `Archivo inesperado o duplicado en ZIP: ${relative}`
              )
            );
          }

          seen.add(relative);

          const destination = resolveInside(root, relative);
          const previous = previousRegistry[relative];

          const checkExistingFile = async () => {
            try {
              report('verify', relative);

              // Proteger los datos personales de Xaero y JourneyMap.
              if (isProtectedPersonalData(relative)) {
                preserved++;
                processedBytes += file.size;
                processedFiles++;

                report('verify', relative);
                zip.readEntry();
                return;
              }

              // Conservar la configuración de Xaero si ya existe.
              if (
                isXaeroConfig(relative) &&
                fs.existsSync(destination)
              ) {
                preserved++;
                processedBytes += file.size;
                processedFiles++;

                report('verify', relative);
                zip.readEntry();
                return;
              }

              // Comprobar si el archivo ya está actualizado.
              if (fs.existsSync(destination)) {
                const currentSha1 = await sha1File(destination);

                if (currentSha1 === file.sha1) {
                  nextRegistry[relative] = file.sha1;

                  unchanged++;
                  processedBytes += file.size;
                  processedFiles++;

                  report('verify', relative);
                  zip.readEntry();
                  return;
                }

                // No sobrescribir archivos modificados por el jugador
                // o cuya propiedad no pueda demostrar el launcher.
                if (!previous || currentSha1 !== previous) {
                  preserved++;

                  processedBytes += file.size;
                  processedFiles++;

                  report('verify', relative);
                  zip.readEntry();
                  return;
                }
              }

              // Solo extraer si el archivo no existe o si podemos
              // demostrar que era propiedad de una versión anterior.
              extractEntry();
            } catch (err) {
              finishError(err);
            }
          };

          const extractEntry = () => {
            zip.openReadStream(entry, (streamError, stream) => {
              if (streamError) return finishError(streamError);

              const temporary =
                `${destination}.luckysmon-temp`;

              try {
                fs.mkdirSync(
                  path.dirname(destination),
                  { recursive: true }
                );
              } catch (err) {
                stream.destroy();
                return finishError(err);
              }

              const output = fs.createWriteStream(temporary);
              let fileBytes = 0;

              report('extract', relative);

              stream.on('data', chunk => {
                fileBytes += chunk.length;
                report('extract', relative, fileBytes);
              });

              stream.on('error', err => {
                output.destroy();
                fs.rmSync(temporary, { force: true });
                finishError(err);
              });

              output.on('error', err => {
                stream.destroy();
                fs.rmSync(temporary, { force: true });
                finishError(err);
              });

              output.on('finish', async () => {
                output.close();

                try {
                  if (fileBytes !== file.size) {
                    fs.rmSync(temporary, { force: true });

                    return finishError(
                      new Error(
                        `Tamaño incorrecto en ${relative}: ` +
                        `${fileBytes} bytes recibidos, ` +
                        `${file.size} esperados.`
                      )
                    );
                  }

                  const actualSha1 = await sha1File(temporary);

                  if (actualSha1 !== file.sha1) {
                    fs.rmSync(temporary, { force: true });

                    return finishError(
                      new Error(`SHA-1 incorrecto: ${relative}`)
                    );
                  }

                  fs.renameSync(temporary, destination);

                  nextRegistry[relative] = file.sha1;

                  extracted++;
                  processedBytes += file.size;
                  processedFiles++;

                  report('extract', relative);
                  zip.readEntry();
                } catch (err) {
                  fs.rmSync(temporary, { force: true });
                  finishError(err);
                }
              });

              stream.pipe(output);
            });
          };

          checkExistingFile();
        });

        zip.on('end', () => {
          if (settled) return;

          if (seen.size !== expected.size) {
            return finishError(
              new Error(
                `Faltan archivos en ${path.basename(zipPath)}: ` +
                `${expected.size - seen.size}`
              )
            );
          }

          settled = true;

          onExtract({
            phase: 'verify',
            processedBytes: totalBytes,
            totalBytes,
            processedFiles: expectedFiles.length,
            totalFiles: expectedFiles.length,
            percent: 100
          });

          resolve({
            extracted,
            preserved,
            unchanged
          });
        });

        zip.readEntry();
      }
    );
  });
}

// ACTUALIZACIÓN DEL MODPACK

async function updateModpack(
  installDirectory,
  onProgress = () => {}
) {
  const root = path.resolve(installDirectory);

  fs.mkdirSync(root, { recursive: true });

  const cache = path.join(root, CACHE_DIR);
  fs.mkdirSync(cache, { recursive: true });

  const registryPath = path.join(root, REGISTRY_FILE);
  const previousRegistry = readRegistry(registryPath);
  const nextRegistry = {};

  emitProgress(onProgress, {
    phase: 'index',
    percent: 0,
    overallPercent: 0,
    message: 'Consultando la versión del modpack...'
  });

  // 1. Consultar la versión publicada en GitHub.
  const version = await getModpackVersion();

  // 2. Construir automáticamente la dirección de la Release.
  const releaseBase =
    `${RELEASE_BASE_URL}/modpack_v${version}`;

  emitProgress(onProgress, {
    phase: 'index',
    percent: 10,
    overallPercent: 10,
    version,
    message: `Versión ${version} detectada. Consultando el índice...`
  });

  // 3. Descargar el índice de esa versión.
  const indexBuffer = await requestBuffer(
    `${releaseBase}/index.json`
  );

  let index;

  try {
    index = JSON.parse(indexBuffer.toString('utf8'));
  } catch {
    throw new Error(
      'El índice descargado no es un JSON válido.'
    );
  }

  if (
    typeof index.version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(index.version) ||
    !Array.isArray(index.files) ||
    !Array.isArray(index.packages)
  ) {
    throw new Error(
      'El índice del modpack tiene un formato o versión incorrectos.'
    );
  }

  // Evitar descargar un índice de otra versión.
  if (index.version !== version) {
    throw new Error(
      `La versión del índice (${index.version}) no coincide ` +
      `con la versión publicada (${version}).`
    );
  }

  const filesByPackage = new Map();
  const knownPaths = new Set();

  for (const item of index.files) {
    const relative = safeRelativePath(item.path);
    const sha1 = String(item.sha1 || '').toLowerCase();

    if (!/^[a-f0-9]{40}$/.test(sha1)) {
      throw new Error(`SHA-1 no válido: ${relative}`);
    }

    if (
      !Number.isSafeInteger(item.size) ||
      item.size < 0 ||
      !item.package
    ) {
      throw new Error(`Metadatos no válidos: ${relative}`);
    }

    if (knownPaths.has(relative)) {
      throw new Error(`Ruta duplicada en el índice: ${relative}`);
    }

    knownPaths.add(relative);

    if (
      PERSONAL_FILES.has(
        path.posix.basename(relative).toLowerCase()
      )
    ) {
      continue;
    }

    if (!filesByPackage.has(item.package)) {
      filesByPackage.set(item.package, []);
    }

    filesByPackage.get(item.package).push({
      path: relative,
      sha1,
      size: item.size
    });
  }

  const totalPackages = index.packages.length;

  let downloaded = 0;
  let unchanged = 0;
  let preserved = 0;

  for (let i = 0; i < totalPackages; i++) {
    const pkg = index.packages[i];
    const packageName = path.basename(pkg.name || '');

    if (
      packageName !== pkg.name ||
      !/^package-\d{3}\.zip$/.test(packageName) ||
      !/^[a-f0-9]{40}$/i.test(pkg.sha1 || '')
    ) {
      throw new Error('Metadatos de paquete no válidos.');
    }

    const expectedFiles = filesByPackage.get(packageName);

    if (!expectedFiles || expectedFiles.length !== pkg.files) {
      throw new Error(
        `El índice no coincide con ${packageName}.`
      );
    }

    const packagePath = path.join(cache, packageName);

    let validCache = false;

    if (fs.existsSync(packagePath)) {
      validCache =
        (await sha1File(packagePath)) === pkg.sha1.toLowerCase();
    }

    if (!validCache) {
      fs.rmSync(packagePath, { force: true });

      emitProgress(onProgress, {
        phase: 'download',
        current: i + 1,
        total: totalPackages,
        package: packageName,
        percent: 0,
        overallPercent: (i / totalPackages) * 100,
        downloadedBytes: 0,
        totalBytes: Number(pkg.size) || 0,
        speedBps: 0,
        message: `Descargando ${packageName}...`
      });

      await downloadToFile(
        `${releaseBase}/${packageName}`,
        packagePath,
        progress => {
          const packagePercent = progress.percent ?? 0;

          const overallPercent =
            (
              (
                i +
                (packagePercent / 100) * 0.5
              ) / totalPackages
            ) * 100;

          emitProgress(onProgress, {
            phase: 'download',
            current: i + 1,
            total: totalPackages,
            package: packageName,
            percent: packagePercent,
            overallPercent,
            downloadedBytes: progress.downloadedBytes,
            totalBytes: progress.totalBytes,
            speedBps: progress.speedBps,
            message: `Descargando ${packageName}...`
          });
        }
      );

      const actualPackageSha1 = await sha1File(packagePath);

      if (actualPackageSha1 !== pkg.sha1.toLowerCase()) {
        fs.rmSync(packagePath, { force: true });

        throw new Error(
          `El SHA-1 del paquete no coincide: ${packageName}`
        );
      }
    } else {
      emitProgress(onProgress, {
        phase: 'download',
        current: i + 1,
        total: totalPackages,
        package: packageName,
        percent: 100,
        overallPercent: ((i + 0.5) / totalPackages) * 100,
        downloadedBytes: 0,
        totalBytes: 0,
        speedBps: 0,
        cached: true,
        message: `${packageName} ya está en caché.`
      });
    }

    emitProgress(onProgress, {
      phase: 'verify',
      current: i + 1,
      total: totalPackages,
      package: packageName,
      percent: 0,
      overallPercent: ((i + 0.5) / totalPackages) * 100,
      processedBytes: 0,
      totalBytes: expectedFiles.reduce(
        (sum, file) => sum + file.size,
        0
      ),
      processedFiles: 0,
      totalFiles: expectedFiles.length,
      message: `Comprobando archivos de ${packageName}...`
    });

    const result = await extractPackage(
      packagePath,
      expectedFiles,
      root,
      previousRegistry,
      nextRegistry,
      progress => {
        const overallPercent =
          (
            (
              i +
              0.5 +
              (progress.percent / 100) * 0.5
            ) / totalPackages
          ) * 100;

        const phase = progress.phase || 'verify';

        emitProgress(onProgress, {
          phase,
          current: i + 1,
          total: totalPackages,
          package: packageName,
          percent: progress.percent,
          overallPercent,
          processedBytes: progress.processedBytes,
          totalBytes: progress.totalBytes,
          processedFiles: progress.processedFiles,
          totalFiles: progress.totalFiles,
          currentFile: progress.currentFile,
          message: phase === 'extract'
            ? `Instalando ${packageName}...`
            : `Comprobando archivos de ${packageName}...`
        });
      }
    );

    downloaded += result.extracted;
    unchanged += result.unchanged;
    preserved += result.preserved;

    // El registro NO se guarda aquí.
    // Se guardará una sola vez al terminar toda la actualización.

    emitProgress(onProgress, {
      phase: 'package-complete',
      current: i + 1,
      total: totalPackages,
      package: packageName,
      percent: 100,
      overallPercent: ((i + 1) / totalPackages) * 100,
      message: `${packageName} comprobado correctamente.`
    });
  }

  // ELIMINAR ÚNICAMENTE ARCHIVOS ANTIGUOS QUE EL LAUNCHER
  // INSTALÓ Y QUE EL JUGADOR NO HAYA MODIFICADO.

  for (const [relative, oldSha1] of Object.entries(previousRegistry)) {
    if (nextRegistry[relative]) continue;

    // Nunca eliminar datos personales de mapas ni configuración de Xaero.
    if (
      isProtectedPersonalData(relative) ||
      isXaeroConfig(relative)
    ) {
      continue;
    }

    let destination;

    try {
      destination = resolveInside(
        root,
        safeRelativePath(relative)
      );
    } catch {
      continue;
    }

    if (!fs.existsSync(destination)) continue;

    const currentSha1 = await sha1File(destination);

    if (currentSha1 === oldSha1) {
      fs.unlinkSync(destination);
    }
  }

  // Guardar el registro solo cuando toda la actualización
  // y la limpieza de archivos antiguos hayan terminado.
  saveRegistry(registryPath, nextRegistry);

  emitProgress(onProgress, {
    phase: 'complete',
    percent: 100,
    overallPercent: 100,
    downloaded,
    unchanged,
    preserved,
    total: index.files.length,
    version,
    message: `Lucky'sMon ${version} está actualizado.`
  });

  return {
    downloaded,
    unchanged,
    preserved,
    total: index.files.length,
    version
  };
}

module.exports = { updateModpack };
