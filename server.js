/* proxy-tv-optimized.js
   Requisitos: Node 18+ (fetch nativo). No usar `node-fetch`.
*/

import fs from "fs";
import path from "path";
import express from "express";
import http from "http";
import events from "events";
import { pipeline } from "stream";
import { promisify } from "util";

events.EventEmitter.defaultMaxListeners = 1000000;
const streamPipeline = promisify(pipeline);

const app = express();
const PORT = process.env.PORT || 8080;
app.use(express.json());

// ------------------- CONFIG -------------------
const ENABLE_STATS = process.env.ENABLE_STATS === "1"; // por defecto false (desactiva contador de oyentes)
const CACHE_TTL_MS = 30 * 1000; // tiempo para considerar un segmento fresco (30s)
const CHECK_LIVE_TTL_MS = 5 * 1000; // cache del resultado de checkLive
const FETCH_TIMEOUT_MS = 5000; // timeout para fetch de segmentos/playlist
const PRELOAD_SEGMENTS = 2; // cuantos segmentos próximos pre-cargar
const MAX_SEGMENTS_PER_CHANNEL = 60; // límite LRU por canal
const MAX_BYTES_PER_SEGMENT = 2 * 1024 * 1024; // si el segmento > 2MB, no lo cacheamos (típico .ts pequeño < 1MB)
const CHANNELS_PATH = path.join(process.cwd(), "channels.json");

// ------------------- ADMIN (basic auth) -------------------
const ADMIN_USER = process.env.ADMIN_USER || "";
const ADMIN_PASS = process.env.ADMIN_PASS || "";

app.use("/admin", (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  const [type, credentials] = authHeader.split(" ");
  if (type === "Basic" && credentials) {
    const [user, pass] = Buffer.from(credentials, "base64").toString().split(":");
    if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Panel Admin"');
  res.status(401).send("Acceso denegado");
});

// ------------------- CARGA CANALES -------------------
if (!fs.existsSync(CHANNELS_PATH)) {
  console.error("No se encontró channels.json en:", CHANNELS_PATH);
  process.exit(1);
}
let channels = JSON.parse(fs.readFileSync(CHANNELS_PATH, "utf8"));

// ------------------- ESTADOS / CACHE -------------------
/*
SEGMENT_CACHE structure:
{
  channelName: Map( segmentName => { buffer: Buffer, timestamp: number, size: number } )
}
*/
const channelStatus = {}; // { channel: { live: bool, lastCheck: number } }
const PLAYLIST_CACHE = {}; // { channel: { data: string, timestamp } }
const SEGMENT_CACHE = {}; // per-channel Map (LRU by Map insertion order)

for (const ch in channels) {
  channelStatus[ch] = { live: false, lastCheck: 0 };
  PLAYLIST_CACHE[ch] = { data: "#EXTM3U\n", timestamp: 0 };
  SEGMENT_CACHE[ch] = new Map();
}

// ------------------- (Opcional) Estadísticas de usuarios -------------------
const conexionesActivas = {}; // only if ENABLE_STATS true
const CONNECTION_TTL = 30 * 1000;
if (ENABLE_STATS) {
  // implementa si realmente lo querés
  // registrarConexion y limpiarConexiones serán usados.
}

function detectarDispositivo(userAgent = "") {
  userAgent = userAgent.toLowerCase();
  if (/smart|hbbtv|tv|netcast|tizen|roku|firetv|bravia/.test(userAgent)) return "SmartTV";
  if (/mobile|iphone|android|tablet|ipad/.test(userAgent)) return "Móvil";
  return "PC";
}
function registrarConexion(canal, req) {
  if (!ENABLE_STATS) return;
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
  const ua = req.headers["user-agent"] || "Desconocido";
  const key = `${ip}|${ua}`;
  if (!conexionesActivas[canal]) conexionesActivas[canal] = {};
  conexionesActivas[canal][key] = { dispositivo: detectarDispositivo(ua), ultimaVez: Date.now() };
}
if (ENABLE_STATS) {
  setInterval(() => {
    const ahora = Date.now();
    for (const canal in conexionesActivas) {
      for (const key in conexionesActivas[canal]) {
        if (ahora - conexionesActivas[canal][key].ultimaVez > CONNECTION_TTL) {
          delete conexionesActivas[canal][key];
        }
      }
    }
  }, 10_000);
}

// ------------------- UTIL: timeout-fetch -------------------
async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const merged = { ...opts, signal: controller.signal };
    const resp = await fetch(url, merged);
    clearTimeout(id);
    return resp;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

// ------------------- REGLAS CORS -------------------
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");
  next();
});

// ------------------- ADMIN STATIC / API Channels -------------------
app.use("/admin", express.static("admin"));
app.get("/api/channels", (req, res) => res.json(channels));
app.post("/api/channels", (req, res) => {
  channels = req.body;
  fs.writeFileSync(CHANNELS_PATH, JSON.stringify(channels, null, 2));
  for (const ch in channels) {
    if (!channelStatus[ch]) channelStatus[ch] = { live: false, lastCheck: 0 };
    if (!PLAYLIST_CACHE[ch]) PLAYLIST_CACHE[ch] = { data: "#EXTM3U\n", timestamp: 0 };
    if (!SEGMENT_CACHE[ch]) SEGMENT_CACHE[ch] = new Map();
  }
  res.json({ message: "Canales actualizados correctamente" });
});

// ------------------- CHECK LIVE (cacheado) -------------------
async function checkLive(channel) {
  const now = Date.now();
  const st = channelStatus[channel] || { live: false, lastCheck: 0 };
  if (now - st.lastCheck < CHECK_LIVE_TTL_MS) return st.live;

  const url = channels[channel]?.live;
  if (!url) {
    channelStatus[channel] = { live: false, lastCheck: now };
    return false;
  }

  try {
    const resp = await fetchWithTimeout(url, { headers: { Range: "bytes=0-200" } }, 1500);
    const txt = await resp.text().catch(() => "");
    const ok = resp.ok && txt.includes(".ts");
    channelStatus[channel] = { live: ok, lastCheck: now };
    return ok;
  } catch {
    channelStatus[channel] = { live: false, lastCheck: now };
    return false;
  }
}

// ------------------- PLAYLIST PROXY (reescribe URLs a /proxy/:channel/...) -------------------
const PLAYLIST_CACHE_TTL = 10 * 1000;
app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const cfg = channels[channel];
  if (!cfg) return res.status(404).send("Canal no encontrado");

  registrarConexion(channel, req);

  const isLive = await checkLive(channel);
  const playlistUrl = isLive ? cfg.live : cfg.cloud;

  try {
    const resp = await fetchWithTimeout(playlistUrl, {}, 3000);
    const text = await resp.text();
    const rewritten = text.replace(/^(?!#)(.*\.ts.*)$/gm, (line) => {
      if (line.startsWith("http")) return line + `?v=${Date.now()}`;
      return `/proxy/${channel}/${line}?v=${Date.now()}`;
    });

    PLAYLIST_CACHE[channel] = { data: rewritten, timestamp: Date.now() };
    res.header("Content-Type", "application/vnd.apple.mpegurl");
    res.send(rewritten);
  } catch (err) {
    const cache = PLAYLIST_CACHE[channel];
    if (cache && (Date.now() - cache.timestamp) < PLAYLIST_CACHE_TTL) {
      res.header("Content-Type", "application/vnd.apple.mpegurl");
      res.send(cache.data);
    } else {
      console.error("Error playlist:", err?.message || err);
      res.status(500).send("Error al cargar playlist");
    }
  }
});

// ------------------- HELPERS CACHE LRU -------------------
function ensureChannelCache(channel) {
  if (!SEGMENT_CACHE[channel]) SEGMENT_CACHE[channel] = new Map();
}
function addSegmentToCache(channel, segmentKey, buffer) {
  ensureChannelCache(channel);
  const map = SEGMENT_CACHE[channel];
  // Si ya existe, borramos para reinsertar y actualizar orden (LRU)
  if (map.has(segmentKey)) map.delete(segmentKey);
  map.set(segmentKey, { buffer, timestamp: Date.now(), size: buffer.length });
  // Evict if over limit
  while (map.size > MAX_SEGMENTS_PER_CHANNEL) {
    // borrar primer elemento insertado (Map preserves insertion order)
    const firstKey = map.keys().next().value;
    map.delete(firstKey);
  }
}
function getSegmentFromCache(channel, segmentKey) {
  const map = SEGMENT_CACHE[channel];
  if (!map) return null;
  const entry = map.get(segmentKey);
  if (!entry) return null;
  // renovar posición LRU:
  map.delete(segmentKey);
  map.set(segmentKey, entry);
  // verificar TTL
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    map.delete(segmentKey);
    return null;
  }
  return entry;
}

// ------------------- PRELOAD (no bloqueante) -------------------
function preloadSegments(channel, baseDir, currentSegment) {
  if (!PRELOAD_SEGMENTS) return;
  const match = currentSegment.match(/(\d+)\.ts$/);
  if (!match) return;
  const idx = parseInt(match[1], 10);

  for (let i = 1; i <= PRELOAD_SEGMENTS; i++) {
    const next = currentSegment.replace(/\d+\.ts$/, `${idx + i}.ts`);
    // si ya en cache -> skip
    if (getSegmentFromCache(channel, next)) continue;

    const url = `${baseDir}${next}`;
    // fetch en background, con limite de tamaño para cachear
    fetchWithTimeout(url, {}, FETCH_TIMEOUT_MS)
      .then(async (r) => {
        if (!r.ok) throw new Error(`Status ${r.status}`);
        // Obtener arrayBuffer pero limitar por tamaño
        const contentLengthHeader = r.headers.get("content-length");
        const contentLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : NaN;
        if (!isNaN(contentLength) && contentLength > MAX_BYTES_PER_SEGMENT) {
          // no cacheamos
          return;
        }
        const ab = await r.arrayBuffer();
        if (ab.byteLength > MAX_BYTES_PER_SEGMENT) return;
        addSegmentToCache(channel, next, Buffer.from(ab));
      })
      .catch(() => {
        /* no loggeo ruido excesivo en preload */
      });
  }
}

// ------------------- SERVIR SEGMENTOS: STREAM + CACHE OPCIONAL -------------------
app.get("/proxy/:channel/*", async (req, res) => {
  const { channel } = req.params;
  const segmentKey = req.params[0]; // ruta después de /proxy/:channel/
  const cfg = channels[channel];
  if (!cfg) return res.status(404).send("Canal no encontrado");

  registrarConexion(channel, req);

  let isLive = channelStatus[channel]?.live || false;
  if (!isLive) isLive = await checkLive(channel);

  const baseUrl = isLive ? cfg.live : cfg.cloud;
  const urlObj = new URL(baseUrl);
  urlObj.pathname = urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf("/") + 1);
  const segmentUrl = `${urlObj.toString()}${segmentKey}`;

  // 1) Si está en cache -> enviar directamente (rápido)
  const cached = getSegmentFromCache(channel, segmentKey);
  if (cached) {
    res.setHeader("Content-Type", "video/MP2T");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Accept-Ranges", "bytes");
    // Enviar buffer de cache rápidamente
    res.send(cached.buffer);
    // lanzar preload en background
    preloadSegments(channel, urlObj.toString(), segmentKey);
    return;
  }

  // 2) Si no está en cache -> fetch y stream al cliente mientras acumulamos para cache (si es pequeño)
  try {
    const rangeHeader = req.headers.range || "";
    const resp = await fetchWithTimeout(segmentUrl, { headers: { Range: rangeHeader } }, FETCH_TIMEOUT_MS);
    if (!resp.ok) {
      res.status(resp.status).end();
      return;
    }

    // Intentamos evaluar tamaño: si header content-length > MAX_BYTES_PER_SEGMENT -> no cachear
    const contentLengthHeader = resp.headers.get("content-length");
    const contentLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : NaN;
    const shouldAttemptCache = isNaN(contentLength) ? true : (contentLength <= MAX_BYTES_PER_SEGMENT);

    res.setHeader("Content-Type", "video/MP2T");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Accept-Ranges", "bytes");

    if (!shouldAttemptCache) {
      // Stream directo sin acumular
      await streamPipeline(resp.body, res);
      // Preload siguientes en background (no await)
      preloadSegments(channel, urlObj.toString(), segmentKey);
      return;
    }

    // Si queremos cachear, leer chunks, escribir al cliente y acumular hasta límite
    const chunks = [];
    let total = 0;
    const reader = resp.body.getReader();
    const encoder = new TextEncoder(); // no usado, sólo para compatibilidad

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // value es Uint8Array
      res.write(value);
      if (total + value.length <= MAX_BYTES_PER_SEGMENT) {
        chunks.push(value);
        total += value.length;
      } else {
        // si sobrepasa el límite, dejamos de acumular para cache (pero seguimos enviando)
        // para ahorrar CPU, descartamos acumulado si se pasó demasiado (simple approach)
        chunks.length = 0;
      }
    }
    res.end();

    // Después de enviar, si acumulamos datos -> agregar al cache
    if (chunks.length > 0 && total > 0) {
      const buffer = Buffer.concat(chunks, total);
      addSegmentToCache(channel, segmentKey, buffer);
    }

    // Preload siguientes (background)
    preloadSegments(channel, urlObj.toString(), segmentKey);
  } catch (err) {
    console.error("❌ Error proxy streaming:", err?.message || err);
    try {
      if (!res.headersSent) res.status(500).send("Error al retransmitir segmento");
      else res.end();
    } catch {}
  }
});

// ------------------- STATUS simple -------------------
app.get("/status/:channel", (req, res) => {
  const { channel } = req.params;
  if (!channels[channel]) return res.status(404).json({ error: "Canal no encontrado" });

  const estado = ENABLE_STATS ? (conexionesActivas[channel] || {}) : {};
  const usuarios = ENABLE_STATS ? Object.keys(estado).length : 0;
  res.json({
    live: channelStatus[channel]?.live || false,
    usuariosConectados: usuarios,
    cacheSegments: SEGMENT_CACHE[channel] ? SEGMENT_CACHE[channel].size : 0
  });
});

// ------------------- KEEP-ALIVE SERVER -------------------
const server = http.createServer(app);
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 70 * 1000;

server.listen(PORT, () => {
  console.log(`✅ Proxy TV optimizado activo en puerto ${PORT}`);
  console.log(`  PRELOAD_SEGMENTS=${PRELOAD_SEGMENTS} MAX_SEGMENTS_PER_CHANNEL=${MAX_SEGMENTS_PER_CHANNEL} MAX_BYTES_PER_SEGMENT=${MAX_BYTES_PER_SEGMENT}`);
});
