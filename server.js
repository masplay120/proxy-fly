import fs from "fs";
import path from "path";
import express from "express";
import events from "events";
events.EventEmitter.defaultMaxListeners = 1000000;

const app = express();
const PORT = process.env.PORT || 8080;
app.use(express.json());

// =============================
// 🔐 SEGURIDAD ADMIN PANEL
// =============================
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

// =============================
// 📡 CONFIGURACIÓN DE CANALES
// =============================
const CHANNELS_PATH = path.join(process.cwd(), "channels.json");
let channels = JSON.parse(fs.readFileSync(CHANNELS_PATH, "utf8"));

const channelStatus = {};
const PLAYLIST_CACHE = {};
const SEGMENT_CACHE = {}; // { canal: { segmento: { data: Buffer, timestamp } } }

for (const ch in channels) {
  channelStatus[ch] = { live: false, lastCheck: 0 };
  PLAYLIST_CACHE[ch] = { data: "#EXTM3U\n", timestamp: 0 };
  SEGMENT_CACHE[ch] = {};
}

// =============================
// 👥 CONEXIONES ACTIVAS
// =============================
const conexionesActivas = {};
const TTL = 30000;

function detectarDispositivo(userAgent) {
  userAgent = userAgent.toLowerCase();
  if (/smart|hbbtv|tv|netcast|tizen|roku|firetv|bravia/.test(userAgent)) return "SmartTV";
  if (/mobile|iphone|android|tablet|ipad/.test(userAgent)) return "Móvil";
  return "PC";
}

function registrarConexion(canal, req) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
  const ua = req.headers["user-agent"] || "Desconocido";
  const key = `${ip}|${ua}`;
  const dispositivo = detectarDispositivo(ua);

  if (!conexionesActivas[canal]) conexionesActivas[canal] = {};
  conexionesActivas[canal][key] = { dispositivo, ultimaVez: Date.now() };
}

setInterval(() => {
  const ahora = Date.now();
  for (const canal in conexionesActivas) {
    for (const key in conexionesActivas[canal]) {
      if (ahora - conexionesActivas[canal][key].ultimaVez > TTL) {
        delete conexionesActivas[canal][key];
      }
    }
  }

  // Limpiar segmentos viejos
  const SEGMENT_TTL = 60000; // 60s
  for (const ch in SEGMENT_CACHE) {
    for (const seg in SEGMENT_CACHE[ch]) {
      if (Date.now() - SEGMENT_CACHE[ch][seg].timestamp > SEGMENT_TTL) {
        delete SEGMENT_CACHE[ch][seg];
      }
    }
  }
}, 10000);

function obtenerEstadoCanal(canal) {
  const usuarios = conexionesActivas[canal] || {};
  const total = Object.keys(usuarios).length;
  const porDispositivo = { PC: 0, Móvil: 0, SmartTV: 0 };
  for (const key in usuarios) {
    const tipo = usuarios[key].dispositivo;
    porDispositivo[tipo] = (porDispositivo[tipo] || 0) + 1;
  }
  return { total, porDispositivo };
}

// =============================
// 🧠 CHECK LIVE
// =============================
async function checkLive(channel) {
  if (!channelStatus[channel]) channelStatus[channel] = { live: false, lastCheck: 0 };
  const url = channels[channel]?.live;
  if (!url) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(url, { headers: { Range: "bytes=0-200" }, signal: controller.signal });
    const text = await response.text();
    const ok = response.ok && text.includes(".ts");
    channelStatus[channel].live = ok;
    channelStatus[channel].lastCheck = Date.now();
    return ok;
  } catch {
    channelStatus[channel].live = false;
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// =============================
// 🌍 CORS
// =============================
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");
  next();
});

// =============================
// 🧰 PANEL ADMIN
// =============================
app.use("/admin", express.static("admin"));

app.get("/api/channels", (req, res) => res.json(channels));

app.post("/api/channels", (req, res) => {
  channels = req.body;
  fs.writeFileSync(CHANNELS_PATH, JSON.stringify(channels, null, 2));
  for (const ch in channels) {
    if (!channelStatus[ch]) channelStatus[ch] = { live: false, lastCheck: 0 };
    if (!PLAYLIST_CACHE[ch]) PLAYLIST_CACHE[ch] = { data: "#EXTM3U\n", timestamp: 0 };
    if (!SEGMENT_CACHE[ch]) SEGMENT_CACHE[ch] = {};
  }
  res.json({ message: "Canales actualizados correctamente" });
});

// =============================
// 🎛️ PROXY DE PLAYLIST
// =============================
const CACHE_TTL = 10000;
const PRELOAD_SEGMENTS = 3;

app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  registrarConexion(channel, req);

  const isLive = await checkLive(channel);
  const playlistUrl = isLive ? config.live : config.cloud;

  try {
    const response = await fetch(playlistUrl);
    let text = await response.text();

    // Reescribir rutas TS
    text = text.replace(/^(?!#)(.*\.ts.*)$/gm, (line) => {
      if (line.startsWith("http")) return line + `?v=${Date.now()}`;
      return `/proxy/${channel}/${line}?v=${Date.now()}`;
    });

    PLAYLIST_CACHE[channel] = { data: text, timestamp: Date.now() };
    res.header("Content-Type", "application/vnd.apple.mpegurl");
    res.send(text);
  } catch (err) {
    const cache = PLAYLIST_CACHE[channel];
    if (Date.now() - cache.timestamp < CACHE_TTL) {
      res.header("Content-Type", "application/vnd.apple.mpegurl");
      res.send(cache.data);
    } else {
      res.status(500).send("Error al cargar playlist");
    }
  }
});

// =============================
// 🎞️ PROXY DE SEGMENTOS TS CON BUFFER Y PRELOAD
// =============================
app.get("/proxy/:channel/:segment", async (req, res) => {
  const { channel, segment } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  registrarConexion(channel, req);

  let isLive = channelStatus[channel]?.live || false;
  if (!isLive) isLive = await checkLive(channel);

  const baseUrl = isLive ? config.live : config.cloud;
  const baseDir = baseUrl.substring(0, baseUrl.lastIndexOf("/") + 1);

  // Servir desde cache si existe
  if (SEGMENT_CACHE[channel][segment]) {
    const cached = SEGMENT_CACHE[channel][segment];
    res.setHeader("Content-Type", "video/mp2t");
    res.setHeader("Content-Length", cached.data.length);
    res.setHeader("Accept-Ranges", "bytes");
    res.send(cached.data);

    preloadSegments(channel, baseDir, segment);
    return;
  }

  try {
    const segmentUrl = `${baseDir}${segment}`;
    const response = await fetch(segmentUrl, { headers: { Range: req.headers.range || "" } });
    if (!response.ok) return res.status(response.status).end();

    const buffer = Buffer.from(await response.arrayBuffer());
    SEGMENT_CACHE[channel][segment] = { data: buffer, timestamp: Date.now() };

    res.setHeader("Content-Type", "video/mp2t");
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Accept-Ranges", "bytes");
    res.send(buffer);

    preloadSegments(channel, baseDir, segment);
  } catch (err) {
    console.error("❌ Error proxy TS:", err.message);
    res.status(500).send("Error al retransmitir segmento");
  }
});

// =============================
// Función preload
// =============================
async function preloadSegments(channel, baseDir, currentSegment) {
  const match = currentSegment.match(/(\d+)\.ts/);
  if (!match) return;
  let index = parseInt(match[1]);
  for (let i = 1; i <= PRELOAD_SEGMENTS; i++) {
    const nextIndex = index + i;
    const nextSegment = currentSegment.replace(/\d+\.ts/, `${nextIndex}.ts`);
    if (SEGMENT_CACHE[channel][nextSegment]) continue;
    const url = `${baseDir}${nextSegment}`;
    fetch(url)
      .then(res => res.arrayBuffer())
      .then(buffer => {
        SEGMENT_CACHE[channel][nextSegment] = { data: Buffer.from(buffer), timestamp: Date.now() };
      })
      .catch(err => console.warn(`❌ Preload segmento ${nextSegment} error: ${err.message}`));
  }
}

// =============================
// 📊 ESTADO DEL CANAL
// =============================
app.get("/status/:channel", (req, res) => {
  const { channel } = req.params;
  if (!channels[channel]) return res.status(404).json({ error: "Canal no encontrado" });

  const estado = obtenerEstadoCanal(channel);
  res.json({
    live: channelStatus[channel]?.live || false,
    usuariosConectados: estado.total,
    dispositivos: estado.porDispositivo
  });
});

// =============================
// 🚀 INICIO DEL SERVIDOR
// =============================
app.listen(PORT, () => {
  console.log(`✅ Proxy TV activo en http://localhost:${PORT}`);
});
