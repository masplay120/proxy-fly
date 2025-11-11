import fs from "fs";
import path from "path";
import express from "express";
import fetch from "node-fetch";
import http from "http";

const app = express();
const PORT = process.env.PORT || 8080;

// =============================
// 📡 CONFIGURACIÓN DE CANALES
// =============================
const CHANNELS_PATH = path.join(process.cwd(), "channels.json");
let channels = JSON.parse(fs.readFileSync(CHANNELS_PATH, "utf8"));

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
// ⚙️ CABECERAS COMUNES PARA STREAMING
// =============================
const STREAM_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  "Accept": "*/*",
  "Referer": "https://www.estacionmixtv.com/",
  "Origin": "https://www.estacionmixtv.com"
};

// =============================
// 🧠 CACHE DE PLAYLIST Y SEGMENTOS
// =============================
const PLAYLIST_CACHE = {};
const SEGMENT_CACHE = {};
const PLAYLIST_TTL = 8000; // 8 segundos
const SEGMENT_TTL = 120000; // 2 minutos de buffer

// =============================
// 🧩 PLAYLIST PROXY
// =============================
app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  const playlistUrl = config.live || config.cloud;
  const now = Date.now();
  const cache = PLAYLIST_CACHE[channel];

  // Servir desde cache si aún es válido
  if (cache && now - cache.timestamp < PLAYLIST_TTL) {
    res.header("Content-Type", "application/vnd.apple.mpegurl");
    return res.send(cache.data);
  }

  try {
    const response = await fetch(playlistUrl, { headers: STREAM_HEADERS });
    let text = await response.text();

    // Reescribir rutas de .ts
    text = text.replace(/^(?!#)(.*\.ts.*)$/gm, (line) => {
      if (line.startsWith("http")) return `/proxy/${channel}/${line}?v=${Date.now()}`;
      const base = new URL(playlistUrl);
      base.pathname = base.pathname.substring(0, base.pathname.lastIndexOf("/") + 1);
      return `/proxy/${channel}/${base}${line}?v=${Date.now()}`;
    });

    PLAYLIST_CACHE[channel] = { data: text, timestamp: now };

    res.header("Content-Type", "application/vnd.apple.mpegurl");
    res.send(text);
  } catch (err) {
    console.error(`❌ Error cargando playlist ${channel}:`, err.message);
    if (cache) {
      res.header("Content-Type", "application/vnd.apple.mpegurl");
      res.send(cache.data);
    } else {
      res.status(503).send("# Esperando buffer...");
    }
  }
});

// =============================
// 🎞️ SEGMENTOS .TS CON BUFFER
// =============================
app.get("/proxy/:channel/*", async (req, res) => {
  const { channel } = req.params;
  const segment = req.params[0];
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  const playlistUrl = config.live || config.cloud;
  const base = new URL(playlistUrl);
  base.pathname = base.pathname.substring(0, base.pathname.lastIndexOf("/") + 1);
  const segmentUrl = `${base}${segment}`;

  // Cache existente
  if (!SEGMENT_CACHE[channel]) SEGMENT_CACHE[channel] = {};
  const cached = SEGMENT_CACHE[channel][segment];
  const now = Date.now();

  if (cached && now - cached.timestamp < SEGMENT_TTL) {
    res.setHeader("Content-Type", "video/MP2T");
    return res.send(cached.buffer);
  }

  try {
    const response = await fetch(segmentUrl, { headers: STREAM_HEADERS });
    if (!response.ok) throw new Error(`Status ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());

    SEGMENT_CACHE[channel][segment] = { buffer, timestamp: now };
    res.setHeader("Content-Type", "video/MP2T");
    res.send(buffer);
  } catch (err) {
    console.error(`⚠️ Error TS ${channel}:`, err.message);
    if (cached) {
      res.setHeader("Content-Type", "video/MP2T");
      res.send(cached.buffer);
    } else {
      res.status(503).send();
    }
  }
});

// =============================
// 🚀 SERVIDOR
// =============================
const server = http.createServer(app);
server.keepAliveTimeout = 70 * 1000;
server.headersTimeout = 75 * 1000;

server.listen(PORT, () => {
  console.log(`✅ Proxy activo en puerto ${PORT}`);
});
