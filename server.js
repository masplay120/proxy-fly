import fs from "fs";
import path from "path";
import express from "express";
import fetch from "node-fetch";
import http from "http";

const app = express();
const PORT = process.env.PORT || 8080;

// =============================
// 🔧 Cargar canales
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
// 🧠 Chequeo rápido si el canal live responde
// =============================
async function isLive(url) {
  try {
    const res = await fetch(url, { method: "HEAD", timeout: 3000 });
    return res.ok;
  } catch {
    return false;
  }
}

// =============================
// 🎛 Proxy de playlist (.m3u8)
// =============================
app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  const live = await isLive(config.live);
  const playlistUrl = live ? config.live : config.cloud;

  try {
    const response = await fetch(playlistUrl);
    if (!response.ok) throw new Error("Playlist no disponible");

    let body = await response.text();

    // Asegura rutas absolutas reescritas al proxy
    body = body.replace(/^(?!#)(.*\.ts.*)$/gm, (line) => {
      line = line.trim();
      if (line.startsWith("http")) {
        return `/proxy/${channel}/${line}`;
      } else {
        return `/proxy/${channel}/${line}`;
      }
    });

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.send(body);
  } catch (e) {
    console.error(`⚠️ Error cargando playlist de ${channel}:`, e.message);
    res.status(500).send("Error al cargar playlist");
  }
});

// =============================
// 🎞 Proxy de segmentos .ts (streaming directo sin cortes)
// =============================
app.get("/proxy/:channel/*", async (req, res) => {
  const { channel } = req.params;
  const segment = req.params[0];
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  const live = await isLive(config.live);
  const baseUrl = new URL(live ? config.live : config.cloud);
  const segmentUrl = new URL(segment, baseUrl).href;

  try {
    const response = await fetch(segmentUrl, {
      headers: { "User-Agent": "Mozilla/5.0 ProxyFly/1.0" },
      timeout: 15000
    });

    if (!response.ok || !response.body) {
      res.status(response.status).end();
      return;
    }

    res.setHeader("Content-Type", "video/MP2T");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Connection", "keep-alive");

    response.body.pipe(res);
  } catch (err) {
    console.error("❌ Error al reenviar TS:", err.message);
    res.status(500).send("Error al retransmitir segmento");
  }
});

// =============================
// 🚀 Servidor HTTP
// =============================
const server = http.createServer(app);
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 70 * 1000;

server.listen(PORT, () => {
  console.log(`✅ Proxy TV funcionando en puerto ${PORT}`);
});
