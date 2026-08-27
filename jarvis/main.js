const { app, BrowserWindow, ipcMain, shell, session, globalShortcut } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { execFile } = require('child_process');

// --- Servidor estático local ---
// Servir la app por http://localhost hace que Chromium la trate como
// "secure context", lo que permite que la Web Speech API (reconocimiento
// de voz) funcione de forma fiable en una aplicación de escritorio.
const WEB_EXT = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

let server = null;
let mainWindow = null;
const APP_PORT = 1947; // Puerto fijo para que el origen (y el localStorage) sea consistente

const WAKE_SOUND = null; // (reservado para un chime al despertar)

// Muestra y enfoca la ventana de Jarvis (la trae al frente)
function wakeWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.setAlwaysOnTop(true);
  setTimeout(() => mainWindow.setAlwaysOnTop(false), 2000);
  try {
    mainWindow.webContents.send('app:wake');
  } catch (_) {}
}

// Registra el atajo global para activar Jarvis desde cualquier app
function registerGlobalHotkeys() {
  try {
    const ok = globalShortcut.register('Control+Space', () => {
      wakeWindow();
    });
    if (ok) mainWindow.webContents.send('app:status', { omnipresence: true, hotkeyRegistered: true });
    return ok;
  } catch (err) {
    console.error('globalShortcut error:', err.message);
    return false;
  }
}

function startStaticServer(publicDir, allowedFiles) {
  server = http.createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      let filePath;
      if (urlPath === '/' || urlPath === '') {
        filePath = path.join(publicDir, 'index.html');
      } else {
        // Evitar navegación fuera del directorio y accesos no permitidos
        filePath = path.resolve(publicDir, '.' + urlPath);
        if (!filePath.startsWith(path.resolve(publicDir)) || !allowedFiles.includes(path.basename(filePath))) {
          res.writeHead(403); res.end('Forbidden'); return;
        }
      }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.writeHead(404); res.end('Not found'); return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': WEB_EXT[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      res.writeHead(500); res.end('Server error');
    }
  });
  return new Promise((resolve, reject) => {
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error('El puerto ' + APP_PORT + ' está en uso. Cierra otra instancia de Jarvis.'));
      } else {
        reject(err);
      }
    });
    server.listen(APP_PORT, '127.0.0.1', () => resolve(APP_PORT));
  });
}

const PUBLIC_DIR = __dirname;
const APP_FILES = ['index.html', 'renderer.js', 'styles.css', 'preload.js', 'main.js', 'ai.js', 'web.js'];

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 650,
    minWidth: 600,
    minHeight: 500,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    title: 'Jarvis',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  return win;
}

// --- Búsqueda web con acceso a internet ---
async function webSearchRaw(query) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  const response = await fetch(url, {
    signal: controller.signal,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Jarvis/1.0'
    }
  });
  clearTimeout(timeout);
  return await response.text();
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDuckDuckGoResults(html) {
  const results = [];
  const resultBlocks = html.split('result__body');
  for (let i = 1; i < resultBlocks.length; i++) {
    const block = resultBlocks[i];
    const titleMatch = block.match(/<a[^>]*class="result__a"[^>]*>(.*?)<\/a>/s);
    const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/s);
    const urlMatch = block.match(/href="([^"]+)"[^>]*class="result__a"/);
    if (titleMatch) {
      results.push({
        title: stripHtml(titleMatch[1]),
        snippet: snippetMatch ? stripHtml(snippetMatch[1]) : '',
        url: urlMatch ? urlMatch[1] : ''
      });
    }
    if (results.length >= 5) break;
  }
  return results;
}

// --- Motor multi-proveedor de IA ---
async function callProvider(provider, config) {
  const { model, messages, apiKey, baseUrl } = config;

  if (provider === 'ollama') {
    const ollamaBase = config.ollamaBase || 'http://localhost:11434';
    const response = await fetch(ollamaBase + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || 'llama3',
        messages,
        stream: false
      })
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error('Ollama error ' + response.status + ': ' + errText);
    }
    const data = await response.json();
    return data.message?.content || '';
  }

  // OpenRouter y OpenAI usan el mismo formato de API compatible con OpenAI
  let endpoint;
  let headers = { 'Content-Type': 'application/json' };
  if (provider === 'openrouter') {
    endpoint = (baseUrl || 'https://openrouter.ai/api/v1/chat/completions');
    headers['Authorization'] = 'Bearer ' + apiKey;
    if (config.httpReferer) headers['HTTP-Referer'] = config.httpReferer;
    if (config.httpTitle) headers['X-Title'] = config.httpTitle;
  } else {
    endpoint = (baseUrl || 'https://api.openai.com/v1/chat/completions');
    headers['Authorization'] = 'Bearer ' + apiKey;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages,
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 1024
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(provider + ' error ' + response.status + ': ' + errText);
  }
  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

ipcMain.handle('ai:chat', async (_event, { provider, model, messages, apiKey, ollamaBase }) => {
  try {
    const content = await callProvider(provider, {
      model,
      messages,
      apiKey,
      ollamaBase
    });
    return { ok: true, content };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// Comprueba si Ollama está corriendo y devuelve los modelos instalados
ipcMain.handle('ollama:status', async (_event, { ollamaBase } = {}) => {
  const base = ollamaBase || 'http://localhost:11434';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(base + '/api/tags', { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return { ok: false, running: false, error: 'Ollama no responde (HTTP ' + res.status + ')' };
    const data = await res.json();
    const models = (data.models || []).map((m) => m.name);
    return { ok: true, running: true, models };
  } catch (error) {
    const aborted = error.name === 'AbortError';
    return {
      ok: false,
      running: false,
      error: aborted ? 'Ollama no responde (timeout)' : error.message
    };
  }
});

// Prueba rápida de conexión con un proveedor
ipcMain.handle('ai:test', async (_event, { provider, model, apiKey, ollamaBase }) => {
  if (provider === 'ollama') {
    try {
      const content = await callProvider('ollama', {
        model, messages: [{ role: 'user', content: 'Responde solo con: OK' }], ollamaBase
      });
      return { ok: true, content };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
  try {
    const content = await callProvider(provider, {
      model,
      messages: [{ role: 'user', content: 'Responde solo con la palabra OK' }],
      apiKey,
      maxTokens: 10
    });
    return { ok: true, content };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('web:search', async (_event, query) => {
  try {
    const html = await webSearchRaw(query);
    const results = parseDuckDuckGoResults(html);
    if (results.length === 0) {
      return { ok: false, results: [], reason: 'Sin resultados' };
    }
    return { ok: true, results };
  } catch (error) {
    return { ok: false, results: [], error: error.message };
  }
});

ipcMain.on('window:close', () => {
  const win = BrowserWindow.getFocusedWindow();
  if (win) win.close();
});

ipcMain.on('window:minimize', () => {
  const win = BrowserWindow.getFocusedWindow();
  if (win) win.minimize();
});

ipcMain.handle('app:openExternal', async (_event, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    await shell.openExternal(url);
    return { ok: true };
  }
  return { ok: false, error: 'URL no válida' };
});

app.whenReady().then(async () => {
  // Conceder permisos de micrófono/cámara para el reconocimiento de voz
  const allowed = ['media', 'mediaKeySystem', 'notifications'];
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(allowed.includes(permission) || permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return allowed.includes(permission) || permission === 'media';
  });

  const port = await startStaticServer(PUBLIC_DIR, APP_FILES);
  const win = createWindow();
  mainWindow = win;
  win.loadURL('http://127.0.0.1:' + port + '/');

  // Omnipresencia: registrar el atajo global una vez la ventana cargue
  win.webContents.on('did-finish-load', () => {
    if (win === mainWindow && !process.env.JARVIS_TEST) {
      registerGlobalHotkeys();
    }
  });

  // El renderer notifica al main cuando él mismo detecta la palabra clave
  ipcMain.on('jarvis:wake-self', () => {
    wakeWindow();
  });

  // Modo de prueba: verifica la carga y captura errores de consola
  if (process.env.JARVIS_TEST) {
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) console.log('TEST-CONSOLE[' + level + ']:', message);
    });
    win.webContents.on('did-finish-load', () => {
      console.log('TEST: pagina cargada OK');
      setTimeout(() => app.quit(), 3000);
    });
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      console.log('TEST: fallo de carga', code, desc);
      app.exit(1);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      console.log('TEST: render process gone', JSON.stringify(details));
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const w2 = createWindow();
      w2.loadURL('http://127.0.0.1:' + port + '/');
    }
  });

  // Cerrar el servidor al salir
  app.on('before-quit', () => {
    if (server) server.close();
    globalShortcut.unregisterAll();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
