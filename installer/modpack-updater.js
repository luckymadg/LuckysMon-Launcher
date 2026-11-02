
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const REGISTRY_FILE = '.luckysmon-managed.json';

const PERSONAL_FILES = new Set([
  'options.txt',
  'servers.dat'
]);

function sha1File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(filePath);

    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function safeRelativePath(file) {
  const relative = path.posix.join(
    file.path || '',
    file.name || ''
  ).replace(/\\/g, '/');

  if (
    !relative ||
    relative.startsWith('/') ||
    relative.split('/').some(part => part === '..') ||
    relative.includes('\0')
  ) {
    throw new Error(`Ruta no válida en el manifiesto: ${relative}`);
  }

  return relative;
}

function downloadFile(url, destination, expectedSha1, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      return reject(new Error('Demasiadas redirecciones al descargar.'));
    }

    let parsed;

    try {
      parsed = new URL(url);
    } catch {
      return reject(new Error(`URL no válida: ${url}`));
    }

    if (parsed.protocol !== 'https:') {
      return reject(
        new Error(`La descarga debe utilizar HTTPS: ${url}`)
      );
    }

    const temporary = `${destination}.luckysmon-download`;

    const request = https.get(parsed, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = response.headers.location;
        response.resume();

        if (!location) {
          return reject(new Error('Redirección sin destino.'));
        }

        const redirectedUrl = new URL(location, parsed).toString();

        return resolve(
          downloadFile(redirectedUrl, destination, expectedSha1, redirects + 1)
        );
      }

      if (response.statusCode !== 200) {
        response.resume();
        return reject(
          new Error(`Error HTTP ${response.statusCode}: ${url}`)
        );
      }

      fs.mkdirSync(path.dirname(destination), { recursive: true });

      const output = fs.createWriteStream(temporary);

      response.pipe(output);

      output.on('finish', async () => {
        output.close();

        try {
          const actualSha1 = await sha1File(temporary);

          if (actualSha1 !== expectedSha1) {
            fs.rmSync(temporary, { force: true });
            return reject(
              new Error(`El SHA-1 no coincide: ${path.basename(destination)}`)
            );
          }

          fs.renameSync(temporary, destination);
          resolve();
        } catch (error) {
          fs.rmSync(temporary, { force: true });
          reject(error);
        }
      });

      output.on('error', error => {
        fs.rmSync(temporary, { force: true });
        reject(error);
      });
    });

    request.on('error', error => {
      fs.rmSync(temporary, { force: true });
      reject(error);
    });
  });
}

function readRegistry(registryPath) {
  if (!fs.existsSync(registryPath)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch {
    throw new Error(
      'El registro de archivos de Lucky\'sMon está dañado. No se borrará ningún archivo.'
    );
  }
}

function saveRegistry(registryPath, registry) {
  const temporary = `${registryPath}.tmp`;

  fs.writeFileSync(
    temporary,
    JSON.stringify(registry, null, 2),
    'utf8'
  );

  fs.renameSync(temporary, registryPath);
}

async function updateModpack(manifest, installDirectory, onProgress = () => {}) {
  if (!manifest || !Array.isArray(manifest.files)) {
    throw new Error('El manifiesto del modpack no es válido.');
  }

  const root = path.resolve(installDirectory);

  fs.mkdirSync(root, { recursive: true });

  const registryPath = path.join(root, REGISTRY_FILE);
  const previousRegistry = readRegistry(registryPath);
  const nextRegistry = {};

  const officialFiles = manifest.files.filter(file =>
    file.type !== 'FOLDER' &&
    !PERSONAL_FILES.has(file.name)
  );

  let downloaded = 0;
  let unchanged = 0;
  let preserved = 0;

  for (let index = 0; index < officialFiles.length; index++) {
    const file = officialFiles[index];
    const relative = safeRelativePath(file);
    const destination = path.resolve(root, relative);

    if (
      destination !== root &&
      !destination.startsWith(root + path.sep)
    ) {
      throw new Error(`Ruta fuera de la instalación: ${relative}`);
    }

    if (!file.sha1 || !file.url) {
      throw new Error(`Faltan SHA-1 o URL en ${relative}`);
    }

    const expectedSha1 = String(file.sha1).toLowerCase();
    const previous = previousRegistry[relative];

    if (fs.existsSync(destination)) {
      const currentSha1 = await sha1File(destination);

      if (currentSha1 === expectedSha1) {
        nextRegistry[relative] = expectedSha1;
        unchanged++;
        continue;
      }

      // Si el archivo no estaba registrado, no lo sobrescribimos.
      // Así protegemos archivos personales que ya existían.
      if (!previous) {
        preserved++;
        continue;
      }
    }

    await downloadFile(file.url, destination, expectedSha1);

    nextRegistry[relative] = expectedSha1;
    downloaded++;

    saveRegistry(registryPath, nextRegistry);

    onProgress({
      current: index + 1,
      total: officialFiles.length,
      file: relative,
      downloaded,
      unchanged,
      preserved
    });
  }

  // Retirar archivos oficiales que ya no aparecen en el manifiesto.
  for (const [relative, oldSha1] of Object.entries(previousRegistry)) {
    if (nextRegistry[relative]) {
      continue;
    }

    const destination = path.resolve(root, relative);

    if (
      destination !== root &&
      !destination.startsWith(root + path.sep)
    ) {
      continue;
    }

    if (!fs.existsSync(destination)) {
      continue;
    }

    const currentSha1 = await sha1File(destination);

    // Solo borramos si sigue siendo exactamente el archivo
    // oficial que Lucky'sMon instaló anteriormente.
    if (currentSha1 === oldSha1) {
      fs.unlinkSync(destination);
    }
  }

  saveRegistry(registryPath, nextRegistry);

  return {
    downloaded,
    unchanged,
    preserved,
    total: officialFiles.length
  };
}

module.exports = { updateModpack };
