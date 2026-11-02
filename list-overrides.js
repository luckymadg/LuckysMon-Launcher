
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'modpack', 'overrides');

function scan(folder, prefix = '') {
  for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
    const full = path.join(folder, item.name);
    const relative = path.join(prefix, item.name);

    if (item.isDirectory()) {
      console.log('[CARPETA] ' + relative);
      scan(full, relative);
    } else {
      console.log('[ARCHIVO] ' + relative);
    }
  }
}

console.log('===== CONTENIDO COMPLETO DE OVERRIDES =====\n');

if (fs.existsSync(root)) {
  scan(root);
} else {
  console.log('No se encuentra overrides.');
}
