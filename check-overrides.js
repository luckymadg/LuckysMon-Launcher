
const fs = require('fs');
const path = require('path');

const modsPath = path.join(__dirname, 'modpack', 'overrides', 'mods');

console.log('\n===== MODS INCLUIDOS EN OVERRIDES =====\n');

if (!fs.existsSync(modsPath)) {
  console.log('No existe la carpeta overrides/mods.');
  process.exit(0);
}

const files = fs.readdirSync(modsPath, { withFileTypes: true })
  .filter(item => item.isFile() && item.name.toLowerCase().endsWith('.jar'));

console.log('JAR encontrados:', files.length);

files.forEach((file, index) => {
  console.log(`${index + 1}. ${file.name}`);
});

console.log('\n===== FIN =====');
