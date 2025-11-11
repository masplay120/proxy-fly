import fs from "fs";
import path from "path";
import express from "express";
import fetch from "node-fetch";
import http from "http";
import { pipeline } from "stream";
import { promisify } from "util";
import pLimit from "p-limit";
const streamPipeline = promisify(pipeline);

const app = express();
const PORT = process.env.PORT || 8080;
app.use(express.json());

// =============================
// 🔐 PANEL ADMIN (opcional)
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
// 📡 CARGA DE CANALES
// =============================
const CHANNELS_PATH = path.join(process.cwd(), "channels.json");
let channels = JSON.parse(fs.readFileSync(CHANNELS_PATH, "utf8"));

const channelStatus = {};
const PLAYLIST_CACHE = {};
for (const ch in channels) {
  channelStatus[ch] = { live: false, lastCheck: 0 };
  PLAYLIST_CACHE[ch] = { data: "#EXTM3U\n", timestamp: 0 };
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
// 🧠 FUNCIONES AUXILIARES
// =============================

const limit = pLimit(10); // Máximo 10 fetch simultáneos

function fetchConTimeout(url, options = {}, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    fetch(url, { ...options, signal: controller.signal })
      .then(resolve)
      .catch(reject)
      .finally(() => clearTimeout(id));
  });
}

async function fetchConLimite(url, options = {}, timeout = 10000) {
  return limit(() => fetchConTimeout(url, options, timeout));
}

async function checkLive(channel) {
  if (!channelStatus[channel]) channelStatus[channel] = { live: false, lastCheck: 0 };
  const url = channels[channel]?.live;
  if (!url) return false;

  try {
    const response = await fetchConLimite(url, { headers: { Range: "bytes=0-200" } }, 3000);
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
const CACHE_TTL = 10000; // 10s cache playlist

app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  const isLive = await checkLive(channel);
  const playlistUrl = isLive ? config.live : config.cloud;

  try {
    const response = await fetchConLimite(playlistUrl);
    let text = await response.text();

    // Reescribir URLs .ts
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
      console.error("⚠️ Playlist error:", err.message);
      res.status(500).send("Error al cargar playlist");
    }
  }
});

// =============================
// 🎞️ PROXY DE SEGMENTOS (streaming directo)
// =============================
app.get("/proxy/:channel/*", async (req, res) => {
  const { channel } = req.params;
  const segment = req.params[0];
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  let isLive = channelStatus[channel]?.live || false;
  if (!isLive) isLive = await checkLive(channel);

  const baseUrl = isLive ? config.live : config.cloud;
  const urlObj = new URL(baseUrl);
  urlObj.pathname = urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf("/") + 1);
  const segmentUrl = `${urlObj.toString()}${segment}`;

  try {
    const response = await fetchConLimite(segmentUrl, { headers: { Range: req.headers.range || "" } }, 15000);
    if (!response.ok) {
      res.status(response.status).end();
      return;
    }

    res.setHeader("Content-Type", "video/MP2T");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Accept-Ranges", "bytes");

    // 🔄 Enviar flujo directo (sin almacenar en memoria)
    await streamPipeline(response.body, res);
  } catch (err) {
    console.error(`❌ Error en segmento ${segmentUrl}:`, err.message);
    res.status(500).send("Error al retransmitir segmento");
  }
});

// =============================
// 📊 ESTADO DEL CANAL
// =============================
app.get("/status/:channel", (req, res) => {
  const { channel } = req.params;
  if (!channels[channel]) return res.status(404).json({ error: "Canal no encontrado" });

  res.json({
    live: channelStatus[channel]?.live || false,
    actualizado: new Date(channelStatus[channel]?.lastCheck || 0).toISOString(),
  });
});

// =============================
// ⚙️ MANTENER VIVA INSTANCIA (Fly.io)
// =============================
if (process.env.FLY_APP_NAME) {
  setInterval(() => console.log("⏱️ Manteniendo instancia activa..."), 60000);
}

// =============================
// 🚀 SERVIDOR HTTP ESTABLE
// =============================
const server = http.createServer(app);
server.keepAliveTimeout = 70 * 1000;
server.headersTimeout = 75 * 1000;

server.listen(PORT, () => {
  console.log(`✅ Proxy TV activo en puerto ${PORT}`);
});

// =============================
// 🧯 PROTECCIÓN ANTI-REINICIO
// =============================
process.on("uncaughtException", (err) => {
  console.error("❌ Excepción no controlada:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("⚠️ Promesa rechazada sin catch:", reason);
});
