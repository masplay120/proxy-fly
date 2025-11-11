import fs from "fs";
import path from "path";
import express from "express";
import fetch from "node-fetch";
import http from "http";

const app = express();
const PORT = process.env.PORT || 8080;

// =============================
// 📡 CARGAR CANALES
// =============================
const CHANNELS_PATH = path.join(process.cwd(), "channels.json");
let channels = JSON.parse(fs.readFileSync(CHANNELS_PATH, "utf8"));

// =============================
// 🌍 CORS + NO CACHE
// =============================
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Range");
  res.header("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.header("Pragma", "no-cache");
  res.header("Expires", "0");
  next();
});

// =============================
// ⚙️ HEADERS SIMULADOS
// =============================
const STREAM_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  "Accept": "*/*",
  "Referer": "https://www.estacionmixtv.com/",
  "Origin": "https://www.estacionmixtv.com"
};

// =============================
// 🧠 CACHE LOCAL EN MEMORIA
// =============================
const PLAYLIST_CACHE = {};
const SEGMENT_CACHE = {};
const PLAYLIST_TTL = 5000;   // 5 s
const SEGMENT_TTL = 120000;  // 2 min

// =============================
// 🎵 PROXY DE PLAYLIST
// =============================
app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  const playlistUrl = config.live || config.cloud;
  const now = Date.now();
  const cache = PLAYLIST_CACHE[channel];

  // Usa cache si está fresco
  if (cache && now - cache.timestamp < PLAYLIST_TTL) {
    res.header("Content-Type", "application/vnd.apple.mpegurl");
    return res.send(cache.data);
  }

  try {
    const response = await fetch(playlistUrl, { headers: STREAM_HEADERS, timeout: 8000 });
    let text = await response.text();

    // Corrige URLs absolutas y relativas de segmentos
    const base = new URL(playlistUrl);
    const basePath = base.origin + base.pathname.substring(0, base.pathname.lastIndexOf("/") + 1);

    text = text.replace(/^(?!#)(.*\.ts.*)$/gm, (line) => {
      let segment = line.trim();
      if (!segment.startsWith("http")) segment = basePath + segment;
      return `/proxy/${channel}/segment?url=${encodeURIComponent(segment)}&t=${Date.now()}`;
    });

    PLAYLIST_CACHE[channel] = { data: text, timestamp: now };

    res.header("Content-Type", "application/vnd.apple.mpegurl");
    res.send(text);
  } catch (err) {
    console.error(`❌ Error playlist ${channel}:`, err.message);
    if (cache) {
      res.header("Content-Type", "application/vnd.apple.mpegurl");
      res.send(cache.data);
    } else {
      res.status(503).send("# Esperando buffer...");
    }
  }
});

// =============================
// 🎞️ SEGMENTOS (BUFFER EXTENDIDO)
// =============================
app.get("/proxy/:channel/segment", async (req, res) => {
  const { channel } = req.params;
  const segmentUrl = req.query.url;
  if (!segmentUrl) return res.status(400).send("Falta parámetro de segmento");

  if (!SEGMENT_CACHE[channel]) SEGMENT_CACHE[channel] = {};
  const cached = SEGMENT_CACHE[channel][segmentUrl];
  const now = Date.now();

  if (cached && now - cached.timestamp < SEGMENT_TTL) {
    res.setHeader("Content-Type", "video/MP2T");
    return res.end(cached.buffer);
  }

  try {
    const response = await fetch(segmentUrl, { headers: STREAM_HEADERS, timeout: 15000 });
    if (!response.ok) throw new Error(`Status ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    SEGMENT_CACHE[channel][segmentUrl] = { buffer, timestamp: now };

    res.setHeader("Content-Type", "video/MP2T");
    res.end(buffer);
  } catch (err) {
    console.error(`⚠️ TS ${channel}:`, err.message);
    if (cached) {
      res.setHeader("Content-Type", "video/MP2T");
      res.end(cached.buffer);
    } else {
      res.status(503).end();
    }
  }
});

// =============================
// 🚀 SERVIDOR CON KEEP-ALIVE
// =============================
const server = http.createServer(app);
server.keepAliveTimeout = 120 * 1000;
server.headersTimeout = 125 * 1000;

server.listen(PORT, () => {
  console.log(`✅ Proxy HLS activo en puerto ${PORT}`);
});
