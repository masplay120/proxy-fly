import fs from "fs";
import path from "path";
import express from "express";
import fetch from "node-fetch";
import http from "http";

const app = express();
const PORT = process.env.PORT || 8080;

// === Cargar canales desde channels.json ===
const CHANNELS_PATH = path.join(process.cwd(), "channels.json");
let channels = JSON.parse(fs.readFileSync(CHANNELS_PATH, "utf8"));

// === Cabeceras globales ===
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Range"
  );
  res.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.header("Pragma", "no-cache");
  res.header("Expires", "0");
  next();
});

// === Headers comunes para fetch ===
const STREAM_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  Accept: "*/*",
  Connection: "keep-alive",
  Referer: "https://www.estacionmixtv.com/",
  Origin: "https://www.estacionmixtv.com",
};

// === Función auxiliar: intenta live, luego cloud ===
async function fetchWithFallback(urls, headers) {
  for (const url of urls) {
    const finalUrl = url; // sin nocache extra para no romper CDN
    const start = Date.now();
    try {
      const res = await fetch(finalUrl, { headers, timeout: 5000 });
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`✅ ${url} respondió en ${elapsed}s (${res.status})`);
      if (res.ok) return res;
    } catch (e) {
      console.warn(`⚠️ Fallback: ${url} no disponible (${e.message})`);
    }
  }
  throw new Error("Ninguna fuente disponible");
}

// === Proxy de playlist optimizado ===
app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const cfg = channels[channel];
  if (!cfg) return res.status(404).send("Canal no encontrado");

  const urls = [cfg.live, cfg.cloud].filter(Boolean);

  try {
    const response = await fetchWithFallback(urls, STREAM_HEADERS);
    let text = await response.text();

    const base = new URL(response.url);
    const basePath =
      base.origin + base.pathname.substring(0, base.pathname.lastIndexOf("/") + 1);

    // Reescribir segmentos sin timestamp extra (más rápido)
    text = text.replace(/^(?!#)(.*\.ts.*)$/gm, (line) => {
      let segment = line.trim();
      if (!segment.startsWith("http")) segment = basePath + segment;
      return `/proxy/${channel}/segment?url=${encodeURIComponent(segment)}`;
    });

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.send(text);
  } catch (err) {
    console.error(`❌ Error playlist ${channel}:`, err.message);
    res.status(503).send("#EXTM3U\n# Esperando buffer...\n");
  }
});

// === Proxy de segmentos optimizado (streaming directo) ===
app.get("/proxy/:channel/segment", async (req, res) => {
  const { channel } = req.params;
  const segmentUrl = req.query.url;
  if (!segmentUrl) return res.status(400).send("Falta parámetro");

  try {
    const response = await fetch(segmentUrl, { headers: STREAM_HEADERS });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    res.setHeader("Content-Type", "video/MP2T");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

    // Transmitir mientras se descarga (sin esperar a terminar)
    response.body.pipe(res);
  } catch (err) {
    console.error(`⚠️ Segmento error ${channel}:`, err.message);
    res.status(503).end();
  }
});

// === Servidor HTTP con Keep-Alive extendido ===
const server = http.createServer(app);
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;

server.listen(PORT, () => {
  console.log(`✅ Proxy HLS en puerto ${PORT}`);
});
