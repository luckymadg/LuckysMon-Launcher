
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../modpack/overrides');
const MANIFEST = path.resolve(__dirname, 'modpack.json');
const HOST = '127.0.0.1';
const PORT = 8080;

const mimeTypes = {
  '.json': 'application/json',
  '.jar': 'application/java-archive',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.png': 'image/png'
};

const server = http.createServer((req, res) => {
  try {
    const pathname = decodeURIComponent(
      new URL(req.url, `http://${HOST}:${PORT}`).pathname
    );

    if (pathname === '/modpack.json') {
      const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

      for (const file of manifest.files) {
        if (file.url) {
          file.url = file.url.replace('127.0.0.1:8080//', '127.0.0.1:8080/');
        }
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });

      return res.end(JSON.stringify(manifest));
    }

    const relative = pathname.replace(/^\/+/, '');
    const filePath = path.resolve(ROOT, relative);

    if (!filePath.startsWith(ROOT + path.sep) || !fs.existsSync(filePath)) {
      res.writeHead(404);
      return res.end('Archivo no encontrado');
    }

    const stat = fs.statSync(filePath);

    if (!stat.isFile()) {
      res.writeHead(404);
      return res.end('No es un archivo');
    }

    res.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Access-Control-Allow-Origin': '*'
    });

    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    console.error(error);
    res.writeHead(500);
    res.end('Error interno');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Servidor local: http://${HOST}:${PORT}`);
  console.log(`Manifiesto: http://${HOST}:${PORT}/modpack.json`);
});
