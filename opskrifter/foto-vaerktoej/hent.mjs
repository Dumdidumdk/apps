// Brug: node hent.mjs <opskrift-id> "File:Titel.jpg"
// Henter billedet, gør det højst 720 px og gemmer fotos/<id>.jpg + fotos/<id>.json (fotograf og licens)
import fs from 'node:fs';
import path from 'node:path';
import { api, download, meta, resize, FOTOS } from './faelles.mjs';

const [id, title] = process.argv.slice(2);
if(!id || !title){ console.log('Brug: node hent.mjs <opskrift-id> "File:Titel.jpg"'); process.exit(1); }
const j = await api({action:'query', titles:title, prop:'imageinfo', iiprop:'url|extmetadata', iiurlwidth:'960', iiextmetadatafilter:'Artist|LicenseShortName'});
const p = Object.values(j.query.pages)[0];
if(!p.imageinfo){ console.log('Filen findes ikke: '+title); process.exit(1); }
const ii = p.imageinfo[0], m = meta(ii);
const tmp = path.join(FOTOS, '_tmp-'+id+'.jpg');
await download(ii.thumburl || ii.url, tmp);
resize(tmp, path.join(FOTOS, id+'.jpg'), 720);
fs.unlinkSync(tmp);
fs.writeFileSync(path.join(FOTOS, id+'.json'), JSON.stringify({t:p.title, a:m.a, l:m.l, u:ii.descriptionurl}, null, 1));
console.log('Gemt fotos/'+id+'.jpg ('+Math.round(fs.statSync(path.join(FOTOS,id+'.jpg')).size/1024)+' KB) · '+m.a+' · '+m.l);
