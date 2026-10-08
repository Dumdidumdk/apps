// Fælles hjælpere til at søge og hente fotos fra Wikimedia Commons
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DIR = path.dirname(fileURLToPath(import.meta.url));
export const FOTOS = path.join(DIR, '..', 'fotos');
const UA = 'Opskriftsbogen/1.0 (https://dumdidumdk.github.io/apps/opskrifter/)';
const API = 'https://commons.wikimedia.org/w/api.php';

export async function api(params){
  const u = API + '?' + new URLSearchParams({format:'json', ...params});
  for(let i=0;i<4;i++){
    const r = await fetch(u, {headers:{'User-Agent':UA}});
    if(r.ok) return r.json();
    await new Promise(s=>setTimeout(s, 1500*(i+1)));
  }
  throw new Error('Commons API svarer ikke');
}
export async function download(url, file){
  for(let i=0;i<4;i++){
    const r = await fetch(url, {headers:{'User-Agent':UA}});
    if(r.ok){ fs.writeFileSync(file, Buffer.from(await r.arrayBuffer())); return; }
    await new Promise(s=>setTimeout(s, 2000*(i+1)));
  }
  throw new Error('Kunne ikke hente '+url);
}
export function strip(html){ return String(html||'').replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#039;/g,"'").replace(/\s+/g,' ').trim(); }
export function meta(ii){
  const m = ii.extmetadata||{};
  return { a: strip(m.Artist&&m.Artist.value)||'Ukendt', l: strip(m.LicenseShortName&&m.LicenseShortName.value)||'Se kilde' };
}
export function resize(src, dst, max){
  execFileSync('powershell', ['-NoProfile','-ExecutionPolicy','Bypass','-File', path.join(DIR,'resize.ps1'), src, dst, String(max)], {stdio:'inherit'});
}
