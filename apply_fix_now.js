const fs = require('fs');
const p = 'electron-fastapi-app/main.js';
let c = fs.readFileSync(p, 'utf8');
const s = c.indexOf("ipcMain.handle('download-plugin'");
const e = c.indexOf("ipcMain.handle('stop-fastapi'", s);
const b = fs.readFileSync('block_download.txt', 'utf8');
if(s === -1 || e === -1) { console.log('bad'); process.exit(1); }
const c2 = c.slice(0,s) + b + '\n\n' + c.slice(e);
fs.writeFileSync(p, c2);
console.log('ok');
