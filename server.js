import fs from "fs";
import path from "path";
import express from "express";
import fetch from "node-fetch";
import http from "http";

const app = express();
const PORT = process.env.PORT || 8080;

// =============================
// 📡 Cargar canales
// =============================
const CHANNELS_PATH = path.join(process.cwd(), "channels.json");
let channels = {};
try {
  channels = JSON.parse(fs.readFileSync(CHANNELS_PATH, "utf8"));
} catch (e) {
  console.error("❌ No se pudo cargar channels.json:", e.message);
}

// =============================
// 🌍 CORS
// =============================
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

// =============================
// ⚙️ Configuración
// =============================
const BUFFER_SEGMENTS = 30; // Mantener 30 segmentos (~3 min)
const REFRESH_INTERVAL = 5000; // refrescar playlists cada 5s
const CACHE = new Map(); // key=url, value=Buffer
const PLAYLISTS = {}; // canal → {segments: [], base: string, lastUpdate: Date}

// =============================
// 🔁 Actualización periódica
// =============================
async function updatePlaylist(channel, config) {
  const url = config.live || config.cloud;
  const base = url.substring(0, url.lastIndexOf("/") + 1);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Playlist no disponible");
    const body = await res.text();

    const segs = [...body.matchAll(/(.*\.ts.*)/g)].map(m => m[1].trim());
    if (!segs.length) return;

    if (!PLAYLISTS[channel]) PLAYLISTS[channel] = { segments: [], base };

    const existing = PLAYLISTS[channel].segments;
    for (const s of segs) {
      if (!existing.includes(s)) {
        existing.push(s);
        if (existing.length > BUFFER_SEGMENTS) existing.shift(); // eliminar antiguos
      }
    }

    PLAYLISTS[channel].base = base;
    PLAYLISTS[channel].lastUpdate = new Date();

    // Prefetch de los últimos 5 segmentos
    const last5 = existing.slice(-5);
    for (const seg of last5) {
      const full = base + seg;
      if (!CACHE.has(full)) fetchSegment(full);
    }

  } catch (err) {
    console.warn(`⚠️ Error actualizando ${channel}:`, err.message);
  }
}

// Descarga y guarda un segmento
async function fetchSegment(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return;
    const buf = Buffer.from(await res.arrayBuffer());
    CACHE.set(url, buf);
    if (CACHE.size > 60) {
      const firstKey = CACHE.keys().next().value;
      CACHE.delete(firstKey);
    }
  } catch (err) {
    console.warn("Prefetch falló:", err.message);
  }
}

// Ejecutar actualizaciones cada REFRESH_INTERVAL
setInterval(() => {
  for (const [channel, config] of Object.entries(channels)) {
    updatePlaylist(channel, config);
  }
}, REFRESH_INTERVAL);

// =============================
// 🎞 Proxy de playlist
// =============================
app.get("/proxy/:channel/playlist.m3u8", (req, res) => {
  const { channel } = req.params;
  const data = PLAYLISTS[channel];
  if (!data || !data.segments.length)
    return res.status(503).send("# Esperando buffer...");

  let body = "#EXTM3U\n#EXT-X-VERSION:3\n";
  body += "#EXT-X-TARGETDURATION:10\n";
  body += `#EXT-X-MEDIA-SEQUENCE:${Date.now()}\n`;

  for (const seg of data.segments) {
    body += `#EXTINF:10,\n/proxy/${channel}/${seg}\n`;
  }

  res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
  res.send(body);
});

// =============================
// 🎬 Proxy de segmentos
// =============================
app.get("/proxy/:channel/*", async (req, res) => {
  const { channel } = req.params;
  const seg = req.params[0];
  const data = PLAYLISTS[channel];
  if (!data) return res.status(404).send("Canal no encontrado");

  const full = data.base + seg;
  const cached = CACHE.get(full);
  res.setHeader("Content-Type", "video/MP2T");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Connection", "keep-alive");

  if (cached) {
    res.end(cached);
  } else {
    try {
      const response = await fetch(full);
      if (!response.ok || !response.body) {
        res.status(response.status).end();
        return;
      }
      const chunks = [];
      response.body.on("data", (chunk) => chunks.push(chunk));
      response.body.on("end", () => {
        const buf = Buffer.concat(chunks);
        CACHE.set(full, buf);
      });
      response.body.pipe(res);
    } catch (err) {
      console.error("Error segmento:", err.message);
      res.status(500).end();
    }
  }
});

// =============================
// 🚀 Servidor
// =============================
const server = http.createServer(app);
server.keepAliveTimeout = 120 * 1000;
server.headersTimeout = 125 * 1000;

server.listen(PORT, () => console.log(`✅ Proxy estable con buffer extendido en ${PORT}`));
