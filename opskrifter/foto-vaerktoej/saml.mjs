// Brug: node saml.mjs  – samler fotos/*.json til fotos/fotos.js, som appen læser
import fs from 'node:fs';
import path from 'node:path';
import { FOTOS } from './faelles.mjs';

const out = {};
for(const f of fs.readdirSync(FOTOS).filter(f=>f.endsWith('.json')).sort()){
  const id = f.slice(0,-5);
  if(!fs.existsSync(path.join(FOTOS, id+'.jpg'))) continue;
  const m = JSON.parse(fs.readFileSync(path.join(FOTOS,f),'utf8'));
  out[id] = {a:m.a, l:m.l, u:m.u};
}
fs.writeFileSync(path.join(FOTOS,'fotos.js'), '/* Fotos fra Wikimedia Commons – lavet af foto-vaerktoej/saml.mjs */\nwindow.FOTOS = '+JSON.stringify(out,null,0).replace(/\},"/g,'},\n"')+';\n');
console.log(Object.keys(out).length+' fotos samlet i fotos/fotos.js');
