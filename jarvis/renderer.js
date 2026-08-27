const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const $ = (id) => document.getElementById(id);

const state = {
  provider: 'openrouter',
  listening: false,
  speaking: false,
  conversation: [],
  continuous: false,
  omnipresence: false
};

// Configuración persistente por proveedor
const CONFIG_KEY = 'jarvis_config_v1';
const PROVIDERS = ['openrouter', 'openai', 'ollama'];
const DEFAULT_CONFIG = {
  provider: 'openrouter',
  providers: {
    openrouter: { apiKey: '', model: '', ollamaBase: '' },
    openai: { apiKey: '', model: '', ollamaBase: '' },
    ollama: { apiKey: '', model: '', ollamaBase: 'http://localhost:11434' }
  },
  voice: ''
};

const PROVIDER_PRESETS = {
  openrouter: {
    model: 'openrouter/auto', needKey: true, showOllama: false,
    keyHelp: 'Crea una key gratuita en <a href="https://openrouter.ai/keys" target="_blank">openrouter.ai/keys</a>. Da acceso a muchos modelos con una sola key.',
    keyPlaceholder: 'sk-or-v1-...'
  },
  openai: {
    model: 'gpt-4o-mini', needKey: true, showOllama: false,
    keyHelp: 'Crea una key en <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com</a>. Requiere saldo/crédito.',
    keyPlaceholder: 'sk-...'
  },
  ollama: {
    model: '', needKey: false, showOllama: true,
    keyHelp: 'No se necesita key. Solo descarga Ollama en <a href="https://ollama.com" target="_blank">ollama.com</a>, instálalo y descarga un modelo (ej. <code>ollama pull llama3</code>).',
    keyPlaceholder: ''
  }
};

let config = loadConfig();
let recognition = null;
let synth = window.speechSynthesis;
let recognitionStoppedByUs = false;
const connectionStatus = {}; // provider -> 'unknown' | 'ok' | 'warn' | 'error'

function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return mergeConfig(DEFAULT_CONFIG, parsed);
    }
  } catch (_) {}
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function mergeConfig(base, override) {
  const result = JSON.parse(JSON.stringify(base));
  if (override.provider) result.provider = override.provider;
  if (override.voice) result.voice = override.voice;
  if (override.providers) {
    PROVIDERS.forEach((p) => {
      if (override.providers[p]) {
        Object.assign(result.providers[p], override.providers[p]);
      }
    });
  }
  return result;
}

function saveConfig() {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch (_) {}
}

function currentProviderConfig() {
  return config.providers[state.provider];
}

/* -------------- Proveedores / UI -------------- */
function initProviders() {
  document.querySelectorAll('.provider-btn').forEach((btn) => {
    btn.addEventListener('click', () => setProvider(btn.dataset.provider));
  });

  $('btnClose').addEventListener('click', () => window.jarvis.close());
  $('btnMinimize').addEventListener('click', () => window.jarvis.minimize());

  $('apiKey').addEventListener('input', () => {
    currentProviderConfig().apiKey = $('apiKey').value;
    saveConfig();
    updateProviderState();
  });
  $('model').addEventListener('input', () => {
    currentProviderConfig().model = $('model').value;
    saveConfig();
  });
  $('ollamaBase').addEventListener('input', () => {
    currentProviderConfig().ollamaBase = $('ollamaBase').value;
    saveConfig();
  });
  $('voice').addEventListener('change', () => {
    config.voice = $('voice').value;
    saveConfig();
  });
  $('ollamaModel').addEventListener('change', () => {
    currentProviderConfig().model = $('ollamaModel').value;
    saveConfig();
  });
  $('btnTest').addEventListener('click', () => testConnection());

  // Las ayudas con links no deben abrir dentro de la ventana sin frame
  document.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') {
      e.preventDefault();
      window.jarvis.openExternal(e.target.href);
    }
  });

  setProvider(config.provider);
  refreshProviderStates();
  runFirstTimeSetup();
}

function setProvider(name) {
  state.provider = name;
  document.querySelectorAll('.provider-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.provider === name);
  });

  const preset = PROVIDER_PRESETS[name];
  const pc = currentProviderConfig();

  $('apiKey').value = pc.apiKey;
  $('apiKey').placeholder = preset.keyPlaceholder;
  $('apiKey').parentElement.classList.toggle('hidden', !preset.needKey);
  $('apiKeyHelp').classList.toggle('hidden', !preset.needKey);
  $('apiKeyHelp').innerHTML = preset.keyHelp;

  $('model').value = pc.model;
  $('model').placeholder = preset.model || 'llama3';
  $('model').parentElement.classList.toggle('hidden', preset.showOllama);

  $('ollamaBase').value = pc.ollamaBase;
  $('ollamaBase').parentElement.classList.toggle('hidden', !preset.showOllama);
  $('ollamaModel').parentElement.classList.toggle('hidden', !preset.showOllama);

  $('testResult').textContent = '';
  updateProviderState();

  // Si es Ollama, refresca el estado y modelos
  if (name === 'ollama') refreshOllama();
}

function setConnectionStatus(provider, status, msg) {
  connectionStatus[provider] = status;
  const btn = document.querySelector(`.provider-btn[data-provider="${provider}"]`);
  if (btn) {
    btn.classList.remove('ready', 'warn', 'error');
    if (status !== 'unknown') btn.classList.add(status);
  }

  if (provider === state.provider) {
    const box = $('connStatus');
    if (status === 'unknown' || !msg) {
      box.style.display = 'none';
    } else {
      box.style.display = 'block';
      box.className = 'conn-status ' + status;
      box.textContent = msg;
    }
  }
}

function updateProviderState() {
  const provider = state.provider;
  const preset = PROVIDER_PRESETS[provider];
  const pc = currentProviderConfig();

  if (provider === 'ollama') {
    if (connectionStatus[provider] === 'ok') {
      setConnectionStatus('ollama', 'ok', 'Ollama detectado y listo.');
    } else {
      setConnectionStatus('ollama', 'warn', 'Ollama no detectado. Ábrelo e instala un modelo (ej. "ollama pull llama3"). Puedes verificar abajo.');
    }
    return;
  }

  if (!pc.apiKey) {
    setConnectionStatus(provider, 'warn', 'Aún no has configurado tu API Key. Pégalo arriba o crea una en el enlace indicado.');
  } else {
    // Key presente, pero no verificada aún
    if (connectionStatus[provider] !== 'ok') {
      setConnectionStatus(provider, 'warn', 'API Key guardada. Pulsa "Verificar conexión" para confirmar.');
    }
  }
}

function refreshProviderStates() {
  // Estado inicial de cada proveedor según su config
  PROVIDERS.forEach((p) => {
    const pc = config.providers[p];
    if (p === 'ollama') {
      // Se verifica bajo demanda
    } else if (pc.apiKey) {
      setConnectionStatus(p, 'warn', 'Pulsa "Verificar conexión" para confirmar la key.');
    } else {
      setConnectionStatus(p, 'warn', 'Configura tu API Key.');
    }
  });
  updateProviderState();
}

async function testConnection() {
  const btn = $('btnTest');
  btn.disabled = true;
  btn.textContent = 'Verificando...';
  $('testResult').textContent = '';

  const provider = state.provider;
  const pc = currentProviderConfig();
  const preset = PROVIDER_PRESETS[provider];

  try {
    if (provider === 'ollama') {
      const res = await window.jarvis.ollamaStatus({ ollamaBase: pc.ollamaBase });
      if (res.ok && res.models.length) {
        setConnectionStatus('ollama', 'ok', 'Conectado. Modelos disponibles: ' + res.models.join(', '));
        showTestResult('ok', 'Conectado a Ollama ✔');
      } else {
        setConnectionStatus('ollama', 'error', res.error || 'Sin modelos detectados. Ejecuta "ollama pull llama3".');
        showTestResult('error', 'No se pudo conectar: ' + (res.error || 'sin modelos'));
      }
    } else {
      if (!pc.apiKey) {
        showTestResult('error', 'Falta la API Key.');
        updateProviderState();
        return;
      }
      const res = await window.jarvis.aiTest({
        provider, model: pc.model, apiKey: pc.apiKey
      });
      if (res.ok) {
        setConnectionStatus(provider, 'ok', 'Conexión correcta. Modelo "' + (pc.model || 'por defecto') + '" responde.');
        showTestResult('ok', 'Conexión correcta ✔');
      } else {
        setConnectionStatus(provider, 'error', res.error);
        showTestResult('error', 'Error: ' + res.error);
      }
    }
  } catch (err) {
    showTestResult('error', 'Error: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Verificar conexión';
  }
}

function showTestResult(kind, text) {
  const el = $('testResult');
  el.className = 'test-result ' + kind;
  el.textContent = text;
}

async function refreshOllama() {
  if (state.provider !== 'ollama') return;
  const pc = currentProviderConfig();
  const res = await window.jarvis.ollamaStatus({ ollamaBase: pc.ollamaBase });
  const select = $('ollamaModel');
  select.innerHTML = '';

  if (res.ok && res.models.length) {
    res.models.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      select.appendChild(opt);
    });
    if (pc.model && res.models.includes(pc.model)) select.value = pc.model;
    $('connStatus').style.display = 'block';
    $('connStatus').className = 'conn-status ok';
    $('connStatus').textContent = 'Ollama conectado. Elige un modelo o instala más con: ollama pull <nombre>';
    // si no había modelo, usa el primero
    if (!pc.model) {
      pc.model = select.value;
      $('model').value = select.value;
      saveConfig();
    }
  } else {
    select.innerHTML = '<option value="">Ollama no detectado</option>';
    setConnectionStatus('ollama', 'error', res.error || 'Ollama no detectado');
  }
}

/* -------------- Asistente de primera ejecución -------------- */
async function runFirstTimeSetup() {
  // Detectar si ya hay un proveedor configurado y verificado
  const anyKey = PROVIDERS.some((p) => p !== 'ollama' && config.providers[p].apiKey);
  if (anyKey) return;

  // Comprobar automáticamente si Ollama está disponible
  setStatus('Detectando entorno...', 'busy');
  const ollamaRes = await window.jarvis.ollamaStatus({ ollamaBase: config.providers.ollama.ollamaBase });
  if (ollamaRes.ok && ollamaRes.models.length) {
    config.provider = 'ollama';
    if (!currentProviderConfig().model || !ollamaRes.models.includes(currentProviderConfig().model)) {
      currentProviderConfig().model = ollamaRes.models[0];
    }
    saveConfig();
    setProvider('ollama');
    refreshOllama();
    setStatus('Ollama detectado. Listo para hablar.', 'ok');
    addLog('jarvis', 'He detectado Ollama en tu equipo con los modelos: ' + ollamaRes.models.join(', ') + '. Estoy listo.');
    return;
  }

  // No hay key ni Ollama: guiar al usuario
  config.provider = 'openrouter';
  saveConfig();
  setProvider('openrouter');
  setStatus('Configura un proveedor para empezar.', 'busy');
  addLog('jarvis', '¡Hola! Soy JARVIS. Para que pueda pensar, necesitas configurar un proveedor de IA:');
  addLog('jarvis', '1. Por Internet: OpenRouter (recomendado, gratis para probar) u OpenAI. Solo pega tu API Key y pulsa "Verificar conexión".');
  addLog('jarvis', '2. 100% local: Ollama. Instálalo en ollama.com, descarga un modelo y seleccionaré la pestaña Ollama.');
}

/* -------------- Status / log -------------- */
function setStatus(text, type = '') {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (type ? ' ' + type : '');
}

function addLog(who, text) {
  const el = document.createElement('div');
  el.className = 'entry ' + who;
  el.textContent = (who === 'you' ? 'Tú: ' : 'Jarvis: ') + text;
  $('log').appendChild(el);
  $('log').scrollTop = $('log').scrollHeight;
}

/* -------------- Config / voz -------------- */
function loadVoices() {
  const list = synth.getVoices();
  const select = $('voice');
  const current = config.voice || select.value;
  select.innerHTML = '';
  const esVoices = list.filter((v) => v.lang && v.lang.toLowerCase().startsWith('es'));
  const others = list.filter((v) => !(v.lang && v.lang.toLowerCase().startsWith('es')));
  const ordered = [...esVoices, ...others];
  ordered.forEach((v) => {
    const opt = document.createElement('option');
    opt.value = v.name;
    opt.textContent = v.name + ' (' + v.lang + ')';
    select.appendChild(opt);
  });
  if (current && ordered.some((v) => v.name === current)) select.value = current;
  else if (esVoices.length) select.value = esVoices[0].name;
}
synth.onvoiceschanged = loadVoices;
if (synth.getVoices().length) loadVoices();

/* -------------- Voz de salida -------------- */
function speak(text) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) { resolve(); return; }
    synth.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'es-ES';
    const chosen = $('voice').value;
    if (chosen) {
      const voice = synth.getVoices().find((v) => v.name === chosen);
      if (voice) utter.voice = voice;
    }
    utter.rate = 1.02;
    utter.pitch = 1;
    setSpeaking(true);
    utter.onend = () => { setSpeaking(false); resolve(); };
    utter.onerror = () => { setSpeaking(false); resolve(); };
    synth.speak(utter);
  });
}

function setSpeaking(on) {
  state.speaking = on;
  document.body.classList.toggle('speaking', on);
  setStatus(on ? 'Hablando...' : 'En espera...');
}

/* -------------- Voz de entrada -------------- */
function startRecognition(continuous) {
  if (!SpeechRecognition) {
    setStatus('Reconocimiento de voz no soportado', 'error');
    return;
  }
  if (recognition) stopRecognition();
  recognition = new SpeechRecognition();
  recognition.lang = 'es-ES';
  recognition.continuous = !!continuous;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognitionStoppedByUs = false;

  recognition.onstart = () => {
    state.listening = true;
    document.body.classList.add('listening');
    setStatus('Escuchando...');
  };
  recognition.onresult = (event) => {
    let transcript = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    if (transcript.trim()) handleUserText(transcript.trim());
  };
  recognition.onerror = (event) => {
    if (recognitionStoppedByUs) return;
    const msg = event.error === 'not-allowed'
      ? 'Acceso al micrófono denegado'
      : event.error === 'no-speech'
        ? 'No te escuché, intenta de nuevo'
        : 'Error: ' + event.error;
    setStatus(msg, 'error');
    if (state.continuous && !recognitionStoppedByUs) {
      try { recognition.start(); } catch (_) {}
    }
  };
  recognition.onend = () => {
    state.listening = false;
    document.body.classList.remove('listening');
    if (!recognitionStoppedByUs && state.continuous) {
      try { recognition.start(); } catch (_) {}
    } else {
      setStatus('En espera...');
    }
  };

  try { recognition.start(); } catch (_) {}
}

function stopRecognition() {
  recognitionStoppedByUs = true;
  state.listening = false;
  document.body.classList.remove('listening');
  if (recognition) {
    recognition.stop();
    recognition = null;
  }
}

/* -------------- Omnipresencia -------------- */
let omniRecognition = null;

function playChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.value = 0.08;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
    osc.stop(ctx.currentTime + 0.6);
  } catch (_) {}
}

function stopOmniRecognition() {
  if (omniRecognition) {
    try { omniRecognition.abort(); } catch (_) {}
    omniRecognition = null;
  }
}

// Escucha continua de la palabra clave "Oye Jarvis" en segundo plano
function startOmniRecognition() {
  if (!SpeechRecognition || omniRecognition || !state.omnipresence) return;
  try {
    const rec = new SpeechRecognition();
    rec.lang = 'es-ES';
    rec.continuous = true;
    rec.interimResults = false;
    omniRecognition = rec;

    rec.onresult = (event) => {
      let text = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        text += event.results[i][0].transcript;
      }
      const lower = (' ' + text).toLowerCase().trim();
      if (/\b(oye|hey|ok|okay|hola)?\s*jarvis\b/.test(lower) || /\bjarvis\b/.test(lower)) {
        handleWakeKeyword();
      }
    };
    rec.onerror = () => {
      if (state.omnipresence) setTimeout(() => startOmniRecognition(), 1500);
    };
    rec.onend = () => {
      omniRecognition = null;
      if (state.omnipresence) setTimeout(() => startOmniRecognition(), 800);
    };
    rec.start();
  } catch (_) {}
}

function handleWakeKeyword() {
  window.jarvis.wakeSelf();
  playChime();
  stopOmniRecognition();
  setStatus('¿Sí, dime...', 'busy');
  addLog('jarvis', 'Te escucho. Dime.');
  // Capturar la orden en una sola toma
  state.continuous = false;
  startRecognition(false);
  // Cuando termine de escuchar, reactivar omnipresencia
  state.rearmAfter = true;
}

function setOmnipresence(on) {
  state.omnipresence = on;
  const toggle = $('omniToggle');
  if (toggle) toggle.checked = on;
  config.omnipresence = on;
  saveConfig();
  try {
    $('omniHint').textContent = on
      ? 'Activo: dí "Oye Jarvis" o pulsa Ctrl+Espacio en cualquier app.'
      : 'Inactivo. Repúlalo para escuchar siempre "Oye Jarvis".';
  } catch (_) {}
  if (on) {
    setStatus('Omnipresencia activa. Escuchando "Oye Jarvis"...');
    startOmniRecognition();
  } else {
    stopOmniRecognition();
    setStatus('Omnipresencia desactivada.');
  }
}

// Al despertar por el hotkey global (Ctrl+Espacio) desde cualquier app
function initOmnipresence() {
  if (config.omnipresence) setOmnipresence(true);

  window.jarvis.onWake(() => {
    // Llegó del hotkey global: muestra la ventana y escucha la orden
    if (state.omnipresence) stopOmniRecognition();
    playChime();
    setStatus('¿Sí, dime...', 'busy');
    state.continuous = false;
    startRecognition(false);
    state.rearmAfter = true;
  });

  const toggle = $('omniToggle');
  toggle.checked = !!config.omnipresence;
  toggle.addEventListener('change', () => setOmnipresence(toggle.checked));
}

/* -------------- Lógica principal -------------- */
const NEEDS_WEB_REGEX = /(noticia|hoy|actual|últim|última|último|clima|tiempo|qué hora|precio|resultado|partido|eleccion|elección|nuevo|reciente|weather|news|latest|google|cuánto cuesta|cotiza)/i;

async function handleUserText(text) {
  addLog('you', text);
  const wasContinuous = state.continuous;
  if (state.listening && !wasContinuous) stopRecognition();
  state.conversation.push({ role: 'user', content: text });

  setStatus('Pensando...', 'busy');
  document.body.classList.remove('listening');
  document.body.classList.add('busy');

  try {
    const answer = await getAnswer(text);
    state.conversation.push({ role: 'assistant', content: answer });
    addLog('jarvis', answer);
    setStatus('Respondiendo...', 'busy');
    await speak(answer);
  } catch (error) {
    setStatus('Error: ' + error.message, 'error');
    addLog('jarvis', 'Lo siento, tuve un error: ' + error.message);
  } finally {
    document.body.classList.remove('busy');
    setStatus('En espera...');
    if (state.continuous && !recognitionStoppedByUs) {
      try { recognition.start(); } catch (_) {}
    }
    // Reactivar la omnipresencia (keyword) tras responder, si estaba activa
    if (state.rearmAfter && state.omnipresence) {
      state.rearmAfter = false;
      startOmniRecognition();
    }
  }
}

async function getAnswer(userText) {
  const provider = state.provider;
  const preset = PROVIDER_PRESETS[provider];
  const pc = currentProviderConfig();
  const apiKey = pc.apiKey.trim();
  const model = pc.model.trim();
  const ollamaBase = pc.ollamaBase.trim() || 'http://localhost:11434';

  if (preset.needKey && !apiKey) {
    throw new Error('Falta tu API Key para ' + provider + '. Configúrala en el panel superior.');
  }

  // Buscar en internet si parece relevante
  let webContext = '';
  if (NEEDS_WEB_REGEX.test(userText)) {
    setStatus('Buscando en internet...', 'busy');
    const res = await window.jarvis.webSearch(userText);
    if (res && res.ok && res.results.length) {
      webContext = res.results.map((r, i) =>
        `${i + 1}. ${r.title}: ${r.snippet} (${r.url})`
      ).join('\n');
    }
  }

  const system = [
    'Eres JARVIS, un asistente personal de IA con acceso a internet.',
    'Responde en español, de forma clara, concisa y útil.',
    'Trata al usuario con cercanía y un toque de elegancia, como un mayordomo experto.'
  ].join(' ');

  const messages = [{ role: 'system', content: system }];
  if (webContext) {
    messages.push({
      role: 'system',
      content: 'Información obtenida de internet (puede no ser 100% precisa):\n' + webContext
    });
  }
  messages.push(...state.conversation.slice(-8));

  const payload = { provider, model, messages, apiKey, ollamaBase };
  const result = await window.jarvis.aiChat(payload);
  if (!result.ok) throw new Error(result.error || 'Sin respuesta de la IA');
  return result.content;
}

/* -------------- Mic button -------------- */
function initMic() {
  const btn = $('btnMic');
  btn.addEventListener('mousedown', () => {
    state.continuous = false;
    btn.classList.add('active');
    startRecognition(false);
  });
  btn.addEventListener('mouseup', () => {
    btn.classList.remove('active');
    if (state.listening) stopRecognition();
  });
  btn.addEventListener('mouseleave', () => {
    if (state.listening && !state.continuous) { stopRecognition(); btn.classList.remove('active'); }
  });
  btn.addEventListener('dblclick', () => {
    if (state.listening) {
      stopRecognition();
      $('btnMic').classList.remove('active');
      return;
    }
    state.continuous = true;
    btn.classList.add('active');
    setStatus('Escucha continua activa. Doble clic para desactivar.');
    startRecognition(true);
  });
}

/* -------------- Init -------------- */
window.addEventListener('DOMContentLoaded', () => {
  initProviders();
  initMic();
  loadVoices();
  $('config').classList.add('open');
  setStatus('Listo. Mantén el botón del micrófono para hablar.');
});
