
const fs = require('fs');
const path = require('path');

const modpackPath = path.join(__dirname, 'modpack');
const manifestPath = path.join(modpackPath, 'manifest.json');
const overridesPath = path.join(modpackPath, 'overrides');

console.log('\n================================');
console.log('       LUCKY´SMON CHECKER');
console.log('================================\n');

if (!fs.existsSync(manifestPath)) {
  console.error('ERROR: No se encuentra modpack/manifest.json');
  process.exit(1);
}

try {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const files = manifest.files || [];
  const required = files.filter(file => file.required);
  const optional = files.filter(file => !file.required);
  const locked = files.filter(file => file.isLocked);

  console.log('Modpack:', manifest.name);
  console.log('Versión:', manifest.version);
  console.log('Minecraft:', manifest.minecraft.version);

  const loader = manifest.minecraft.modLoaders.find(
    item => item.primary
  );

  console.log('Cargador:', loader ? loader.id : 'No especificado');

  console.log('\n--- MODS ---');
  console.log('Total registrados:', files.length);
  console.log('Obligatorios:', required.length);
  console.log('Opcionales:', optional.length);
  console.log('Bloqueados:', locked.length);

  console.log('\n--- ARCHIVOS ---');
  console.log(
    'Manifest:',
    fs.existsSync(manifestPath) ? 'OK' : 'FALTA'
  );
  console.log(
    'Overrides:',
    fs.existsSync(overridesPath) ? 'OK' : 'FALTA'
  );

  console.log('\n================================');
  console.log('COMPROBACIÓN FINALIZADA');
  console.log('================================\n');

} catch (error) {
  console.error('ERROR al leer el manifiesto:', error.message);
  process.exit(1);
}
