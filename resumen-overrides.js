
const fs = require('fs');
const path = require('path');

const folders = ['resourcepacks', 'datapacks', 'mods'];

for (const folder of folders) {
  const root = path.join(__dirname, 'modpack', 'overrides', folder);

  console.log(`\n===== ${folder.toUpperCase()} =====`);

  if (!fs.existsSync(root)) {
    console.log('Carpeta no encontrada');
    continue;
  }

  function scan(dir, prefix = '') {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = path.join(prefix, item.name);

      if (item.isDirectory()) {
        scan(path.join(dir, item.name), relative);
      } else {
        console.log(relative);
      }
    }
  }

  scan(root);
}
