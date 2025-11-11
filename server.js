import fs from "fs";
import path from "path";
import express from "express";
import fetch from "node-fetch";
import http from "http";

const app = express();
const PORT = process.env.PORT || 8080;

const CHANNELS_PATH = path.join(process.cwd(), "channels.json");
let channels = {};
try {
  channels = JSON.parse(fs.readFileSync(CHANNELS_PATH, "utf8"));
} catch (e) {
  console.error("❌ No se pudo cargar channels.json:", e.message);
}

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

// 🔍 Verifica si la señal en vivo responde
async function checkLive(url) {
  try {
    const response = await fetch(url, { method: "HEAD", timeout: 3000 });
    return response.ok;
  } catch {
    return false;
  }
}

// 📜 Proxy de playlist (.m3u8)
app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  const isLive = await checkLive(config.live);
  const playlistUrl = isLive ? config.live : config.cloud;

  try {
    const response = await fetch(playlistUrl, { timeout: 5000 });
    let text = await response.text();

    // Reescribe URLs de segmentos .ts
    text = text.replace(/^(?!#)(.*\.ts.*)$/gm, (line) => {
      if (line.startsWith("http")) return `/proxy/${channel}/${line.trim()}`;
      return `/proxy/${channel}/${line.trim()}`;
    });

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.send(text);
  } catch (err) {
    console.error(`⚠️ Error cargando playlist ${channel}:`, err.message);
    res.status(500).send("Error al cargar playlist");
  }
});

// 🎞 Proxy de segmentos TS con transmisión directa
app.get("/proxy/:channel/*", async (req, res) => {
  const { channel } = req.params;
  const segment = req.params[0];
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  const isLive = await checkLive(config.live);
  const baseUrl = new URL(isLive ? config.live : config.cloud);
  const segmentUrl = new URL(segment, baseUrl).href;

  try {
    const response = await fetch(segmentUrl, {
      timeout: 15000,
      headers: { "User-Agent": "Node-Proxy/1.0" }
    });

    if (!response.ok || !response.body) {
      res.status(response.status).end();
      return;
    }

    res.setHeader("Content-Type", "video/MP2T");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Connection", "keep-alive");

    // Transmite el flujo en tiempo real sin esperar a terminar
    response.body.pipe(res);
  } catch (err) {
    console.error("❌ Error proxy TS:", err.message);
    res.status(500).send("Error al retransmitir segmento");
  }
});

http.createServer(app).listen(PORT, () => {
  console.log(`✅ Proxy TV estable en puerto ${PORT}`);
});
