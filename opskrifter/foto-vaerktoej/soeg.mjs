// Brug: node soeg.mjs "søgeord" [antal]
// Henter små forhåndsvisninger til fotos/_forslag/1.jpg, 2.jpg ... og viser titel, størrelse og licens.
import fs from 'node:fs';
import path from 'node:path';
import { api, download, meta, FOTOS } from './faelles.mjs';

const q = process.argv[2]; const n = +(process.argv[3]||8);
const ud = process.argv[4] || path.join(FOTOS, '_forslag');
if(!q){ console.log('Brug: node soeg.mjs "søgeord" [antal] [mappe]'); process.exit(1); }
fs.mkdirSync(ud, {recursive:true});
for(const f of fs.readdirSync(ud)) fs.unlinkSync(path.join(ud,f));
const j = await api({action:'query', generator:'search', gsrnamespace:'6', gsrsearch:q+' filetype:bitmap', gsrlimit:String(n*2), prop:'imageinfo', iiprop:'url|extmetadata|size|mime', iiurlwidth:'330', iiextmetadatafilter:'Artist|LicenseShortName'});
const pages = Object.values((j.query||{}).pages||{}).sort((a,b)=>a.index-b.index)
  .filter(p=>p.imageinfo && /jpeg|png|webp/.test(p.imageinfo[0].mime) && p.imageinfo[0].width>=500).slice(0,n);
if(!pages.length){ console.log('Ingen resultater.'); process.exit(0); }
let i=0;
for(const p of pages){
  i++; const ii = p.imageinfo[0], m = meta(ii);
  await download(ii.thumburl, path.join(ud, i+'.jpg'));
  console.log(i+'. '+p.title+'  ('+ii.width+'x'+ii.height+', '+m.l+', '+m.a.slice(0,40)+')');
}
console.log('\nForhåndsvisninger: '+ud);
