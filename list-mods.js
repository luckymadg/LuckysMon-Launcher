
const fs = require('fs');
const path = require('path');

const manifestPath = path.join(__dirname, 'modpack', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

console.log('LISTADO DE MODS DE LUCKY´SMON\n');

manifest.files.forEach((file, index) => {
  console.log(
    `${index + 1}. Proyecto: ${file.projectID} | Archivo: ${file.fileID} | Obligatorio: ${file.required} | Bloqueado: ${file.isLocked}`
  );
});
