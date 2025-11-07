import fs from "fs";
import path from "path";
import express from "express";
import fetch from "node-fetch";
import http from "http";
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

// Inicializa objetos por canal
const channelStatus = {};
const PLAYLIST_CACHE = {};
for (const ch in channels) {
  channelStatus[ch] = { live: false, lastCheck: 0 };
  PLAYLIST_CACHE[ch] = { data: "#EXTM3U\n", timestamp: 0 };
}

// =============================
// 👥 CONEXIONES ACTIVAS
// =============================
const conexionesActivas = {}; // { canal: { "ip|ua": { dispositivo, ultimaVez } } }
const TTL = 30000; // 30s timeout por usuario

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

function limpiarConexiones() {
  const ahora = Date.now();
  for (const canal in conexionesActivas) {
    for (const key in conexionesActivas[canal]) {
      if (ahora - conexionesActivas[canal][key].ultimaVez > TTL) {
        delete conexionesActivas[canal][key];
      }
    }
  }
}
setInterval(limpiarConexiones, 10000);

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
// 🧠 FUNCION CHECK LIVE
// =============================
async function checkLive(channel) {
  if (!channelStatus[channel]) channelStatus[channel] = { live: false, lastCheck: 0 };
  const url = channels[channel]?.live;
  if (!url) return false;

  try {
    const response = await fetch(url, { headers: { Range: "bytes=0-200" }, timeout: 2000 });
    const text = await response.text();
    const ok = response.ok && text.includes(".ts");
    channelStatus[channel].live = ok;
    channelStatus[channel].lastCheck = Date.now();
    return ok;
  } catch {
    channelStatus[channel].live = false;
    return false;
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
  }
  res.json({ message: "Canales actualizados correctamente" });
});

// =============================
// 🎛️ PROXY DE PLAYLIST
// =============================
const CACHE_TTL = 10000; // 10s

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
      console.warn(`⚠️ Error en ${channel}: ${err.message}, usando cache`);
      res.header("Content-Type", "application/vnd.apple.mpegurl");
      res.send(cache.data);
    } else {
      res.status(500).send("Error al cargar playlist");
    }
  }
});

// =============================
// 🎞️ PROXY DE SEGMENTOS TS (Optimizado para Fly.io)
// =============================
app.get("/proxy/:channel/:segment", async (req, res) => {
  const { channel, segment } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  registrarConexion(channel, req);

  let isLive = channelStatus[channel]?.live || false;
  if (!isLive) isLive = await checkLive(channel);

  const baseUrl = isLive ? config.live : config.cloud;
  const urlObj = new URL(baseUrl);
  urlObj.pathname = urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf("/") + 1);
  const segmentUrl = `${urlObj.toString()}${segment}`;

  try {
    const response = await fetch(segmentUrl, {
      headers: { Range: req.headers.range || "" }
    });

    if (!response.ok) {
      res.status(response.status).end();
      return;
    }

    for (const [key, value] of response.headers) {
      if (["content-type", "content-length", "accept-ranges"].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");

    response.body.pipe(res);
  } catch (err) {
    console.error("❌ Error proxy TS:", err.message);
    res.status(500).send("Error al retransmitir segmento");
  }
});

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
// 🚀 INICIO DEL SERVIDOR CON KEEP-ALIVE
// =============================
const server = http.createServer(app);
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 70 * 1000;

server.listen(PORT, () => {
  console.log(`✅ Proxy TV activo en puerto ${PORT}`);
});
