import fs from "fs";
import path from "path";
import express from "express";
import fetch from "node-fetch";
import http from "http";

const app = express();
const PORT = process.env.PORT || 8080;

// =============================
// ⚙️ CONFIGURACIÓN
// =============================
const CHANNELS_PATH = path.join(process.cwd(), "channels.json");
let channels = JSON.parse(fs.readFileSync(CHANNELS_PATH, "utf8"));

const PLAYLISTS = {}; // { canal: { base, segments[], lastUpdate } }
const SEGMENT_CACHE = {}; // { canal: { nombre.ts: { buffer, timestamp } } }

const BUFFER_SEGMENTS = 40; // ~2-3 min de buffer según bitrate
const SEGMENT_TTL = 3 * 60 * 1000; // 3 min por segmento

// =============================
// 🌍 CORS
// =============================
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Methods",
    "GET,HEAD,OPTIONS"
  );
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Range"
  );
  next();
});

// =============================
// 📡 ACTUALIZAR PLAYLIST
// =============================
async function updatePlaylist(channel, config) {
  const url = config.live || config.cloud;
  const base = url.substring(0, url.lastIndexOf("/") + 1);

  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
        "Accept": "*/*",
      },
      timeout: 8000,
    });

    if (!res.ok) throw new Error(`Playlist no disponible (${res.status})`);
    const body = await res.text();

    // 🧩 Buscar líneas .ts
    const segs = [...body.matchAll(/(.*\.ts.*)/g)].map((m) => m[1].trim());
    if (!segs.length) {
      console.warn(`⚠️ Playlist sin segmentos para ${channel}`);
      return;
    }

    if (!PLAYLISTS[channel])
      PLAYLISTS[channel] = { base, segments: [], lastUpdate: 0 };

    const existing = PLAYLISTS[channel].segments;
    for (const s of segs) {
      if (!existing.includes(s)) {
        existing.push(s);
        if (existing.length > BUFFER_SEGMENTS) existing.shift();
      }
    }

    PLAYLISTS[channel].base = base;
    PLAYLISTS[channel].lastUpdate = Date.now();

    console.log(`✅ ${channel}: ${existing.length} segmentos listos`);
  } catch (err) {
    console.warn(`❌ Error actualizando ${channel}: ${err.message}`);
  }
}

// =============================
// ⏱️ ACTUALIZACIÓN PERIÓDICA
// =============================
setInterval(() => {
  for (const [ch, conf] of Object.entries(channels)) {
    updatePlaylist(ch, conf);
  }
}, 7000); // cada 7 segundos

// =============================
// 🎞️ PROXY PLAYLIST
// =============================
app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const pl = PLAYLISTS[channel];

  if (!channels[channel]) return res.status(404).send("Canal no encontrado");

  // Si no hay playlist aún
  if (!pl || !pl.segments?.length) {
    res.status(503).send("# Esperando buffer...");
    return;
  }

  // Generar nueva playlist local
  const body =
    "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n" +
    "#EXT-X-MEDIA-SEQUENCE:" +
    Math.max(0, pl.segments.length - 5) +
    "\n" +
    pl.segments
      .slice(-5)
      .map((s) => `#EXTINF:10.0,\n/proxy/${channel}/${encodeURIComponent(s)}`)
      .join("\n");

  res.header("Content-Type", "application/vnd.apple.mpegurl");
  res.send(body);
});

// =============================
// 📦 PROXY SEGMENTOS TS
// =============================
app.get("/proxy/:channel/:segment", async (req, res) => {
  const { channel, segment } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  const segName = decodeURIComponent(segment);
  const cached =
    SEGMENT_CACHE[channel]?.[segName] || null;
  const now = Date.now();

  if (cached && now - cached.timestamp < SEGMENT_TTL) {
    res.setHeader("Content-Type", "video/MP2T");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.send(cached.buffer);
  }

  const pl = PLAYLISTS[channel];
  if (!pl?.base) return res.status(503).send("# Esperando buffer...");

  const segmentUrl = pl.base + segName;
  try {
    const r = await fetch(segmentUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
        "Accept": "*/*",
      },
      timeout: 8000,
    });

    if (!r.ok) {
      res.status(r.status).send(`Error segmento: ${r.status}`);
      return;
    }

    const buf = Buffer.from(await r.arrayBuffer());
    if (!SEGMENT_CACHE[channel]) SEGMENT_CACHE[channel] = {};
    SEGMENT_CACHE[channel][segName] = { buffer: buf, timestamp: now };

    res.setHeader("Content-Type", "video/MP2T");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(buf);
  } catch (err) {
    console.error(`❌ Error TS ${channel}: ${err.message}`);
    res.status(500).send("Error al obtener segmento");
  }
});

// =============================
// 🧾 PRECARGA INICIAL
// =============================
(async () => {
  console.log("⏳ Precargando playlists iniciales...");
  for (const [ch, conf] of Object.entries(channels)) {
    await updatePlaylist(ch, conf);
  }
  console.log("✅ Precarga completada");
})();

// =============================
// 🚀 SERVIDOR
// =============================
const server = http.createServer(app);
server.keepAliveTimeout = 70 * 1000;
server.headersTimeout = 75 * 1000;

server.listen(PORT, () => {
  console.log(`🚀 Proxy TV activo en puerto ${PORT}`);
});
