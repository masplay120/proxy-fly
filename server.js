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

const CHANNELS_PATH = path.join(process.cwd(), "channels.json");
let channels = {};

try {
  channels = JSON.parse(fs.readFileSync(CHANNELS_PATH, "utf8"));
} catch (e) {
  console.error("Error al cargar channels.json:", e.message);
}

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  next();
});

async function checkLive(url) {
  try {
    const res = await fetch(url, { method: "HEAD", timeout: 2000 });
    return res.ok;
  } catch {
    return false;
  }
}

app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  const isLive = await checkLive(config.live);
  const playlistUrl = isLive ? config.live : config.cloud;

  try {
    const response = await fetch(playlistUrl);
    let text = await response.text();
    text = text.replace(/^(?!#)(.*\.ts.*)$/gm, (line) => `/proxy/${channel}/${line}`);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.send(text);
  } catch (err) {
    res.status(500).send("Error al cargar playlist");
  }
});

app.get("/proxy/:channel/*", async (req, res) => {
  const { channel } = req.params;
  const segment = req.params[0];
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  const isLive = await checkLive(config.live);
  const baseUrl = new URL(isLive ? config.live : config.cloud);
  const segmentUrl = new URL(segment, baseUrl).href;

  try {
    const response = await fetch(segmentUrl);
    if (!response.ok || !response.body) return res.status(response.status).end();
    res.setHeader("Content-Type", "video/MP2T");
    await streamPipeline(response.body, res);
  } catch {
    res.status(500).send("Error en retransmisión");
  }
});

http.createServer(app).listen(PORT, () => console.log(`Proxy activo en puerto ${PORT}`));
