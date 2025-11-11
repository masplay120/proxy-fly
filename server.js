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
// ⚡ utilidades
// =============================
async function isLive(url) {
  try {
    const res = await fetch(url, { method: "HEAD", timeout: 3000 });
    return res.ok;
  } catch {
    return false;
  }
}

function baseUrlFromM3u8(url) {
  const u = new URL(url);
  u.pathname = u.pathname.substring(0, u.pathname.lastIndexOf("/") + 1);
  return u.toString();
}

// =============================
// 🎛 Proxy playlist con reescritura
// =============================
app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  const live = await isLive(config.live);
  const playlistUrl = live ? config.live : config.cloud;
  const base = baseUrlFromM3u8(playlistUrl);

  try {
    const response = await fetch(playlistUrl);
    if (!response.ok) throw new Error("Playlist no disponible");

    let body = await response.text();
    body = body.replace(/^(?!#)(.*\.ts.*)$/gm, (line) => {
      const clean = line.trim();
      return `/proxy/${channel}/${clean}`;
    });

    // Guardamos últimos segmentos detectados para prefetch
    const segments = [...body.matchAll(/(.*\.ts.*)/g)].map(m => m[1]);
    if (segments.length) {
      prefetchSegments[channel] = {
        base,
        list: segments.slice(-3) // últimos 3 segmentos para precargar
      };
      triggerPrefetch(channel);
    }

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.send(body);
  } catch (e) {
    console.error(`⚠️ Error cargando playlist de ${channel}:`, e.message);
    res.status(500).send("Error al cargar playlist");
  }
});

// =============================
// 📦 Prefetch y caché de segmentos
// =============================
const segmentCache = new Map(); // key: url, value: Buffer
const prefetchSegments = {};    // canal → { base, list }
const MAX_CACHE = 15;           // máximo 15 segmentos en memoria

async function fetchSegment(url) {
  if (segmentCache.has(url)) return; // ya en cache
  try {
    const res = await fetch(url, { timeout: 10000 });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (segmentCache.size > MAX_CACHE) {
        const firstKey = segmentCache.keys().next().value;
        segmentCache.delete(firstKey);
      }
      segmentCache.set(url, buf);
      // console.log("✅ Prefetch", url);
    }
  } catch (err) {
    console.warn("⚠️ Prefetch error:", err.message);
  }
}

function triggerPrefetch(channel) {
  const info = prefetchSegments[channel];
  if (!info) return;
  for (const seg of info.list) {
    const url = info.base + seg;
    fetchSegment(url);
  }
}

// =============================
// 🎞 Proxy de segmentos con buffer
// =============================
app.get("/proxy/:channel/*", async (req, res) => {
  const { channel } = req.params;
  const segment = req.params[0];
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  const live = await isLive(config.live);
  const base = baseUrlFromM3u8(live ? config.live : config.cloud);
  const url = base + segment;

  // ¿Ya está en caché?
  const cached = segmentCache.get(url);
  if (cached) {
    res.setHeader("Content-Type", "video/MP2T");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Connection", "keep-alive");
    res.end(cached);
    return;
  }

  // Si no, descargar y servir en streaming
  try {
    const response = await fetch(url, { timeout: 15000 });
    if (!response.ok || !response.body) {
      res.status(response.status).end();
      return;
    }

    const chunks = [];
    response.body.on("data", (chunk) => chunks.push(chunk));
    response.body.on("end", () => {
      const buf = Buffer.concat(chunks);
      if (segmentCache.size > MAX_CACHE) {
        const firstKey = segmentCache.keys().next().value;
        segmentCache.delete(firstKey);
      }
      segmentCache.set(url, buf);
    });

    res.setHeader("Content-Type", "video/MP2T");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Connection", "keep-alive");
    response.body.pipe(res);
  } catch (err) {
    console.error("❌ Error TS:", err.message);
    res.status(500).send("Error al retransmitir segmento");
  }
});

// =============================
// 🚀 Servidor HTTP
// =============================
const server = http.createServer(app);
server.keepAliveTimeout = 70 * 1000;
server.headersTimeout = 75 * 1000;
server.listen(PORT, () => console.log(`✅ Proxy TV activo en puerto ${PORT}`));
