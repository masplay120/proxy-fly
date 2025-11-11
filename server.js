import fs from "fs";
import path from "path";
import express from "express";
import fetch from "node-fetch";
import http from "http";
import { pipeline } from "stream";
import { promisify } from "util";

const streamPipeline = promisify(pipeline);
const app = express();
const PORT = process.env.PORT || 8080;

// =============================
// 📦 CONFIGURACIÓN DE CANALES
// =============================
const CHANNELS_PATH = path.join(process.cwd(), "channels.json");
let channels = {};

try {
  channels = JSON.parse(fs.readFileSync(CHANNELS_PATH, "utf8"));
} catch (e) {
  console.error("❌ Error al cargar channels.json:", e.message);
  channels = {};
}

// =============================
// 🌍 CORS + HEADERS
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
async function checkLive(url) {
  try {
    const res = await fetch(url, { method: "HEAD", timeout: 2000 });
    return res.ok;
  } catch {
    return false;
  }
}

// =============================
// 🎛️ PROXY DE PLAYLIST (.m3u8)
// =============================
app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  const isLive = await checkLive(config.live);
  const playlistUrl = isLive ? config.live : config.cloud;

  try {
    const response = await fetch(playlistUrl);
    let text = await response.text();

    // Reescribir rutas .ts para pasar por el proxy
    text = text.replace(/^(?!#)(.*\.ts.*)$/gm, (line) => {
      if (line.startsWith("http")) return `/proxy/${channel}/${line}`;
      return `/proxy/${channel}/${line}`;
    });

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.send(text);
  } catch (err) {
    console.error(`❌ Error al cargar playlist de ${channel}:`, err.message);
    res.status(500).send("Error al cargar playlist");
  }
});

// =============================
// 🎞️ PROXY DE SEGMENTOS (.ts)
// =============================
app.get("/proxy/:channel/*", async (req, res) => {
  const { channel } = req.params;
  const segment = req.params[0];
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  const isLive = await checkLive(config.live);
  const baseUrl = new URL(isLive ? config.live : config.cloud);
  const segmentUrl = new URL(segment, baseUrl).href;

  try {
    const response = await fetch(segmentUrl, { headers: { Range: req.headers.range || "" } });
    if (!response.ok || !response.body) {
      res.status(response.status).end();
      return;
    }

    res.setHeader("Content-Type", "video/MP2T");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Accept-Ranges", "bytes");

    // Transmitir directamente al cliente sin guardar en memoria
    await streamPipeline(response.body, res);
  } catch (err) {
    console.error(`❌ Error en segmento ${channel}:`, err.message);
    res.status(500).send("Error en retransmisión");
  }
});

// =============================
// 🚀 SERVIDOR HTTP ESTABLE
// =============================
const server = http.createServer(app);
server.keepAliveTimeout = 75 * 1000; // conexiones persistentes
server.headersTimeout = 80 * 1000;

server.listen(PORT, () => {
  console.log(`✅ Proxy TV estable activo en puerto ${PORT}`);
});
