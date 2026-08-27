const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Registro de Ventas',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.setMenuBarVisibility(true);
  win.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('export:csv', async (event, { filename, content }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Guardar archivo CSV',
    defaultPath: filename,
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  });

  if (canceled || !filePath) return { success: false, canceled: true };

  fs.writeFileSync(filePath, content, 'utf-8');
  return { success: true, filePath };
});

ipcMain.handle('export:backup', async (event, { filename, content }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Guardar copia de seguridad',
    defaultPath: filename,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });

  if (canceled || !filePath) return { success: false, canceled: true };

  fs.writeFileSync(filePath, content, 'utf-8');
  return { success: true, filePath };
});

ipcMain.handle('import:backup', async (event) => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Importar copia de seguridad',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });

  if (canceled || filePaths.length === 0) return { success: false, canceled: true };

  try {
    const content = fs.readFileSync(filePaths[0], 'utf-8');
    const data = JSON.parse(content);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
