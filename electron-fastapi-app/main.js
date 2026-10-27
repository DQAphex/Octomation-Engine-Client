const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const AdmZip = require('adm-zip');

let mainWindow;
let fastApiProcess = null;
let currentPort = null;
let fastApiPid = null;

function isServerAlive(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function findRunningServer() {
  if (await isServerAlive(8000)) {
    console.log('[Electron] Servidor FastAPI ya está en ejecución en puerto 8000');
    return 8000;
  }
  return null;
}

async function startFastAPI() {
  const isDev = !app.isPackaged;
  let port = 8000;

  if (!isDev) {
    const { default: getPort } = await import('get-port');
    port = await getPort({ port: [8000, 8001, 8002, 8003] });
  }

  currentPort = port;
  let command;
  let args = [port.toString()];

  if (isDev) {
    const venvPython = path.join(__dirname, 'backend', '.venv', 'Scripts', 'python.exe');
    if (fs.existsSync(venvPython)) {
      command = venvPython;
      console.log('[Electron] Usando Python del venv');
    } else {
      const venvPythonAlt = path.join(__dirname, 'backend', 'venv', 'Scripts', 'python.exe');
      if (fs.existsSync(venvPythonAlt)) {
        command = venvPythonAlt;
        console.log('[Electron] Usando Python del venv');
      } else {
        command = 'python';
        console.log('[Electron] Usando Python global');
      }
    }
    args = [path.join(__dirname, 'backend', 'main.py')];
  } else {
    const exePath = path.join(process.resourcesPath, 'backend', 'api.exe');
    command = exePath;
    args = [port.toString()];
  }

  console.log(`[Electron] Iniciando FastAPI: ${command} ${args.join(' ')}`);

  fastApiProcess = spawn(command, args, {
    env: {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  fastApiPid = fastApiProcess.pid;
  
  console.log(`[FastAPI] PID asignado: ${fastApiPid}`);

  fastApiProcess.stdout.on('data', (data) => {
    const output = data.toString();
    console.log(`[FastAPI] ${output}`);
    if (output.includes('FASTAPI_READY')) {
      console.log(`[FastAPI] Servidor listo en puerto ${port} | PID: ${fastApiPid}`);
      currentPort = port;
      if (!mainWindow) {
        createWindow(port);
      } else {
        sendPortToRenderer(port);
      }
    }
  });

  fastApiProcess.stderr.on('data', (data) => {
    console.error(`[FastAPI ERR] ${data.toString()}`);
  });

  fastApiProcess.on('close', (code) => {
    console.log(`[FastAPI] Proceso cerrado con código: ${code} | PID anterior: ${fastApiPid}`);
    fastApiProcess = null;
    fastApiPid = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('fastapi-status', { running: false });
    }
  });
}

function stopFastAPI() {
  if (fastApiProcess && !fastApiProcess.killed && fastApiPid) {
    console.log(`[Electron] Apagando servidor FastAPI... PID: ${fastApiPid}`);
    try {
      fastApiProcess.kill();
      console.log(`[Electron] Señal kill enviada al PID: ${fastApiPid}`);
    } catch (e) {
      console.error(e);
    }
    const pidToLog = fastApiPid;
    fastApiProcess = null;
    fastApiPid = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('fastapi-status', { running: false });
      mainWindow.webContents.send('fastapi-pid', null);
    }
    return { success: true, message: `Servidor FastAPI apagado (PID: ${pidToLog})` };
  }
  console.log('[Electron] No hay servidor FastAPI en ejecución');
  return { success: false, message: 'No hay servidor en ejecución' };
}

async function restartFastAPI() {
  const oldPid = fastApiPid;
  console.log(`[Electron] Reiniciando servidor FastAPI... PID actual: ${oldPid || 'ninguno'}`);
  stopFastAPI();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await startFastAPI();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('fastapi-status', { running: true });
  }
  return { success: true, message: `Servidor FastAPI reiniciado | PID anterior: ${oldPid || 'N/A'} | PID nuevo: ${fastApiPid || 'N/A'}` };
}

function sendPortToRenderer(port) {
  currentPort = port;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('fastapi-port', port);
    mainWindow.webContents.send('fastapi-status', { running: true });
    mainWindow.webContents.send('fastapi-pid', fastApiPid);
  }
}

function createWindow(port) {
  if (mainWindow) return;

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    title: "Electron + FastAPI"
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.webContents.on('did-finish-load', () => {
    sendPortToRenderer(port);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function downloadZip(url, dest, pluginName) {
  return new Promise((resolve, reject) => {
    const destinationDir = path.dirname(dest);
    const safePluginName = String(pluginName)
      .trim()
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');

    fs.mkdirSync(destinationDir, { recursive: true });

    // El ZIP se guarda con el nombre del plugin, no el del release.
    const zipPath = path.join(destinationDir, `${safePluginName}.zip`);

    const download = (downloadUrl) => {
      const protocol = downloadUrl.startsWith('https:')
        ? https
        : http;

      const request = protocol.get(downloadUrl, {
        headers: {
          'User-Agent': 'Electron-Plugin-Downloader'
        }
      }, (response) => {
        // Seguir redirecciones de GitHub.
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          const location = response.headers.location;
          response.resume();

          if (!location) {
            return reject(new Error('Redirección sin URL de destino'));
          }

          return download(new URL(location, downloadUrl).href);
        }

        if (response.statusCode !== 200) {
          response.resume();
          return reject(
            new Error(`Error al descargar: ${response.statusCode}`)
          );
        }

        const file = fs.createWriteStream(zipPath);

        file.on('error', (error) => {
          request.destroy();
          fs.unlink(zipPath, () => {});
          reject(error);
        });

        response.on('error', (error) => {
          file.destroy();
          fs.unlink(zipPath, () => {});
          reject(error);
        });

        response.pipe(file);

        file.on('finish', () => {
          file.close((error) => {
            if (error) {
              fs.unlink(zipPath, () => {});
              return reject(error);
            }

            resolve(zipPath);
          });
        });
      });

      request.on('error', (error) => {
        fs.unlink(zipPath, () => {});
        reject(error);
      });
    };

    download(url);
  });
}

ipcMain.handle('get-available-plugins', async () => {
  try {
    const data = await new Promise((resolve, reject) => {
      http.get('http://localhost:4005/plugins', (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error.message };
  }
});



ipcMain.handle('download-plugin', async (_, pluginId) => {
  try {
    const info = await new Promise((resolve, reject) => {
      http.get(`http://localhost:4005/plugins/${pluginId}/download/latest`, (res) => {
        let body = '';

        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              return reject(new Error(`Error obteniendo el release: ${res.statusCode}`));
            }

            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });

    const zipballUrl = info.zipball_url;
    if (!zipballUrl) throw new Error('No se encontró zipball_url');

    const pluginName = info.pluginName || info.plugin_name;
    if (!pluginName) throw new Error('No se encontró pluginName');

    const pluginNameClean = pluginName
      .toString()
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/-/g, '_')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');

    const pluginsDir = path.join(__dirname, 'backend', 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });

    // Descargar el ZIP usando el nombre del plugin.
    const tempDir = app.getPath('temp');
    const zipPath = await downloadZip(
      zipballUrl,
      tempDir,
      pluginNameClean
    );

    const targetPath = path.join(pluginsDir, pluginNameClean);
    const extractTempDir = fs.mkdtempSync(
      path.join(tempDir, 'plugin-extract-')
    );

    try {
      const zip = new AdmZip(zipPath);
      const entries = zip.getEntries();

      // Identificar la carpeta raíz del ZIP.
      const rootEntries = entries
        .filter(entry => !entry.isDirectory)
        .map(entry => entry.entryName.replace(/\\/g, '/'))
        .filter(name => name && !name.startsWith('/'));

      if (rootEntries.length === 0) {
        throw new Error('El ZIP no contiene archivos.');
      }

      const rootDirs = [
        ...new Set(rootEntries.map(name => name.split('/')[0]))
      ];

      // Extraer primero en una carpeta temporal aislada.
      zip.extractAllTo(extractTempDir, true);

      let sourcePath;

      if (rootDirs.length === 1) {
        sourcePath = path.join(extractTempDir, rootDirs[0]);
      } else {
        // Si los archivos están directamente en la raíz,
        // la propia carpeta temporal será el origen.
        sourcePath = extractTempDir;
      }

      if (!fs.existsSync(sourcePath)) {
        throw new Error(`No se encontró la carpeta extraída: ${sourcePath}`);
      }

      // Evitar reemplazar el plugin actual hasta tener el nuevo extraído.
      const stagingPath = path.join(
        pluginsDir,
        `.installing-${pluginNameClean}-${Date.now()}`
      );

      try {
        fs.cpSync(sourcePath, stagingPath, { recursive: true });

        // Reemplazar la instalación anterior, si existe.
        if (fs.existsSync(targetPath)) {
          fs.rmSync(targetPath, { recursive: true, force: true });
        }

        fs.renameSync(stagingPath, targetPath);
      } catch (error) {
        fs.rmSync(stagingPath, { recursive: true, force: true });
        throw error;
      }

      console.log(`[PLUGIN INSTALL] Plugin instalado en: ${targetPath}`);

    } finally {
      try {
        fs.unlinkSync(zipPath);
      } catch (e) {
        console.log('No se pudo eliminar ZIP temporal:', e.message);
      }

      try {
        fs.rmSync(extractTempDir, { recursive: true, force: true });
      } catch (e) {
        console.log('No se pudo limpiar la extracción temporal:', e.message);
      }
    }

    // Instalar requirements.txt si existe.
    const reqFile = path.join(targetPath, 'requirements.txt');

    if (fs.existsSync(reqFile)) {
      console.log(`[PLUGIN INSTALL] Instalando dependencias desde ${reqFile}`);

      const backendDir = path.join(__dirname, 'backend');
      const isWin = process.platform === 'win32';

      const venvPython = isWin
        ? path.join(backendDir, 'venv', 'Scripts', 'python.exe')
        : path.join(backendDir, 'venv', 'bin', 'python');

      const command = fs.existsSync(venvPython) ? venvPython : 'python';

      const result = require('child_process').spawnSync(
        command,
        ['-m', 'pip', 'install', '-r', reqFile],
        { cwd: backendDir, stdio: 'inherit' }
      );

      if (result.error) throw result.error;

      if (result.status !== 0) {
        throw new Error(
          `Falló la instalación de requirements.txt (código ${result.status})`
        );
      }
    }

    return {
      success: true,
      message: `Plugin ${pluginNameClean} descargado y extraído.`,
      pluginName: pluginNameClean,
      path: targetPath
    };

  } catch (error) {
    console.error('[PLUGIN INSTALL] Error:', error);
    return { success: false, error: error.message };
  }
});



ipcMain.handle('stop-fastapi', stopFastAPI);
ipcMain.handle('restart-fastapi', restartFastAPI);
ipcMain.handle('get-fastapi-port', () => currentPort || 8000);

app.whenReady().then(async () => {
  createWindow(8000);

  try {
    const existingPort = await findRunningServer();

    if (existingPort) {
      currentPort = existingPort;
      sendPortToRenderer(existingPort);
      return;
    }

    await startFastAPI();
    setTimeout(() => {
      if (!currentPort) currentPort = 8000;
      if (mainWindow && !mainWindow.isDestroyed()) {
        sendPortToRenderer(currentPort);
      }
    }, 2500);
  } catch (error) {
    console.error('[Electron] Error iniciando la aplicación:', error);
    currentPort = 8000;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('fastapi-status', {
        running: false,
        error: error.message
      });
      sendPortToRenderer(8000);
    }
  }
}).catch((error) => {
  console.error('[Electron] Error crítico:', error);
});

app.on('window-all-closed', () => {
  console.log('[Electron] Ventanas cerradas, manteniendo servidor FastAPI en ejecución...');
});

app.on('before-quit', () => {
  console.log('[Electron] Saliendo, manteniendo servidor FastAPI en ejecución...');
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    startFastAPI();
  }
});