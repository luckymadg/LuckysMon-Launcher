
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');

const ROOT = __dirname;
const OVERRIDES = path.join(ROOT, 'modpack', 'overrides');
const OUTPUT = path.join(ROOT, 'dist', 'modpack');
const VERSION_FILE = path.join(ROOT, 'modpack-version.json');

const MAX_PACKAGE_SIZE = 45 * 1024 * 1024;

const EXCLUDED_FILES = new Set([
  'options.txt',
  'servers.dat'
]);

function getModpackVersion() {
  if (!fs.existsSync(VERSION_FILE)) {
    throw new Error('No existe modpack-version.json');
  }

  const data = JSON.parse(
    fs.readFileSync(VERSION_FILE, 'utf8')
  );

  if (
    typeof data.version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(data.version)
  ) {
    throw new Error(
      'Versión inválida. Usa formato X.Y.Z, por ejemplo 1.7.31'
    );
  }

  return data.version;
}

const VERSION = getModpackVersion();

function getFiles(directory, relative = '') {
  const result = [];

  for (const entry of fs.readdirSync(directory, {
    withFileTypes: true
  })) {
    const fullPath = path.join(directory, entry.name);
    const relativePath = path.join(relative, entry.name);

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      result.push(...getFiles(fullPath, relativePath));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (EXCLUDED_FILES.has(entry.name.toLowerCase())) {
      continue;
    }

    result.push({
      fullPath,
      relativePath: relativePath.split(path.sep).join('/'),
      size: fs.statSync(fullPath).size
    });
  }

  return result;
}

function sha1File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(filePath);

    stream.on('data', data => hash.update(data));
    stream.on('error', reject);

    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });
  });
}

function sha1Buffer(buffer) {
  return crypto.createHash('sha1')
    .update(buffer)
    .digest('hex');
}

async function createZip(files, packageName) {
  const zipPath = path.join(OUTPUT, packageName);

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);

    const archive = archiver('zip', {
      zlib: {
        level: 1
      }
    });

    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);

    archive.pipe(output);

    for (const file of files) {
      archive.file(file.fullPath, {
        name: file.relativePath
      });
    }

    archive.finalize().catch(reject);
  });

  const buffer = fs.readFileSync(zipPath);

  return {
    name: packageName,
    size: buffer.length,
    sha1: sha1Buffer(buffer),
    files: files.length
  };
}

async function main() {
  if (!fs.existsSync(OVERRIDES)) {
    throw new Error(
      `No existe la carpeta: ${OVERRIDES}`
    );
  }

  fs.rmSync(OUTPUT, {
    recursive: true,
    force: true
  });

  fs.mkdirSync(OUTPUT, {
    recursive: true
  });

  console.log('Buscando archivos del modpack...');

  const files = getFiles(OVERRIDES);

  console.log(`Archivos encontrados: ${files.length}`);

  if (files.length === 0) {
    throw new Error('No se encontraron archivos');
  }

  const filesWithHashes = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];

    file.sha1 = await sha1File(file.fullPath);

    filesWithHashes.push(file);

    if (
      (i + 1) % 100 === 0 ||
      i + 1 === files.length
    ) {
      console.log(
        `SHA1: ${i + 1}/${files.length}`
      );
    }
  }

  const packages = [];

  let currentPackage = [];
  let currentSize = 0;

  for (const file of filesWithHashes) {
    if (
      currentPackage.length > 0 &&
      currentSize + file.size > MAX_PACKAGE_SIZE
    ) {
      packages.push(currentPackage);

      currentPackage = [];
      currentSize = 0;
    }

    currentPackage.push(file);
    currentSize += file.size;
  }

  if (currentPackage.length > 0) {
    packages.push(currentPackage);
  }

  const packageMetadata = [];
  const fileMetadata = [];

  for (let i = 0; i < packages.length; i++) {
    const packageNumber = String(i + 1).padStart(3, '0');

    const packageName = `package-${packageNumber}.zip`;

    console.log(
      `Creando ${packageName} (${packages[i].length} archivos)...`
    );

    const metadata = await createZip(
      packages[i],
      packageName
    );

    packageMetadata.push(metadata);

    for (const file of packages[i]) {
      fileMetadata.push({
        path: file.relativePath,
        size: file.size,
        sha1: file.sha1,
        package: packageName
      });
    }
  }

  const index = {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    files: fileMetadata,
    packages: packageMetadata
  };

  fs.writeFileSync(
    path.join(OUTPUT, 'index.json'),
    JSON.stringify(index, null, 2),
    'utf8'
  );

  const modCount = files.filter(file =>
    file.relativePath.startsWith('mods/') &&
    file.relativePath.toLowerCase().endsWith('.jar')
  ).length;

  console.log('\n========== RESULTADO ==========');
  console.log(`Mods incluidos: ${modCount}`);
  console.log(`Archivos incluidos: ${files.length}`);
  console.log(`Paquetes ZIP: ${packageMetadata.length}`);
  console.log(`Versión: ${VERSION}`);
  console.log(`Salida: ${OUTPUT}`);
  console.log('================================');
}

main().catch(error => {
  console.error('ERROR:', error);
  process.exit(1);
});
