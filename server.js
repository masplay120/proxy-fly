import fs from "fs";
import path from "path";
import http from "http";
import fetch from "node-fetch";
import { pipeline } from "stream";
import { promisify } from "util";

const streamPipeline = promisify(pipeline);
const PORT = process.env.PORT || 8080;

// ==============================
// 📂 CARGAR CANALES DESDE JSON
// ==============================
const CHANNELS_PATH = path.join(process.cwd(), "channels.json");
if (!fs.existsSync(CHANNELS_PATH)) {
  console.error("❌ No se encontró channels.json");
  process.exit(1);
}

let channels = JSON.parse(fs.readFileSync(CHANNELS_PATH, "utf8"));
console.log(`✅ ${Object.keys(channels).length} canales cargados`);

// ==============================
// ⚙️ CONFIGURACIÓN
// ==============================
const CACHE_TTL = 15000; // 15s para playlist
const FETCH_TIMEOUT_MS = 10000; // 10s timeout fetch
const cache = {};

// ==============================
// 🧠 FUNCIONES AUXILIARES
// ==============================
async function fetchConTimeout(url, options = {}, timeout = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// Verifica si un canal está en vivo
async function checkLive(channel) {
  const config = channels[channel];
  if (!config?.live) return false;
  try {
    const response = await fetch(config.live, { timeout: 2000 });
    return response.ok;
  } catch {
    return false;
  }
}

// ==============================
// 🚀 SERVIDOR HTTP
// ==============================
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  if (req.method === "OPTIONS") return res.end();

  const parts = req.url.split("/").filter(Boolean);
  if (parts[0] !== "proxy") {
    res.writeHead(404);
    return res.end("Ruta no válida");
  }

  const canal = parts[1];
  const archivo = parts.slice(2).join("/");
  const config = channels[canal];
  if (!config) {
    res.writeHead(404);
    return res.end("Canal no encontrado");
  }

  // Detectar URL base
  const liveDisponible = await checkLive(canal);
  const baseUrl = liveDisponible ? config.live : config.cloud;

  if (!archivo) {
    // Solicitud del playlist principal
    try {
      const playlistRes = await fetchConTimeout(baseUrl);
      const text = await playlistRes.text();

      // Reescribir las rutas internas para pasar por el proxy
      const baseDir = baseUrl.substring(0, baseUrl.lastIndexOf("/") + 1);
      const modified = text.replace(/^(?!#)(.*\.ts.*)$/gm, (line) => {
        const url = line.startsWith("http") ? line : baseDir + line;
        return `/proxy/${canal}/${url.replace(baseDir, "")}?v=${Date.now()}`;
      });

      cache[canal] = { data: modified, time: Date.now() };
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end(modified);
    } catch (err) {
      console.warn("⚠️ Playlist error:", err.message);
      const cached = cache[canal];
      if (cached && Date.now() - cached.time < CACHE_TTL) {
        res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
        res.end(cached.data);
      } else {
        res.writeHead(502);
        res.end("Error cargando playlist");
      }
    }
    return;
  }

  // Segmentos .ts o sublistas
  const baseDir = baseUrl.substring(0, baseUrl.lastIndexOf("/") + 1);
  const targetUrl = archivo.startsWith("http") ? archivo : baseDir + archivo;

  try {
    const resp = await fetchConTimeout(targetUrl, {
      headers: { Range: req.headers.range || "" },
    });

    if (!resp.ok) {
      res.writeHead(resp.status);
      return res.end(`Error origen: ${resp.status}`);
    }

    res.setHeader("Content-Type", resp.headers.get("content-type") || "application/octet-stream");
    res.setHeader("Accept-Ranges", "bytes");
    await streamPipeline(resp.body, res);
  } catch (err) {
    console.error("Error al enviar segmento:", err.message);
    res.writeHead(502);
    res.end("Error al conectar con el origen");
  }
});

// ==============================
// 🕓 MANTENER ACTIVO EN FLY.IO
// ==============================
setInterval(() => {
  const canalPing = Object.keys(channels)[0];
  if (canalPing) {
    fetch(`http://localhost:${PORT}/proxy/${canalPing}`).catch(() => {});
  }
}, 4500000);

// Ajustar timeouts largos para evitar cortes
server.keepAliveTimeout = 12000000; // 2 min
server.headersTimeout = 13000000; // 2 min 10s

server.listen(PORT, () => {
  console.log(`🚀 Proxy fluido activo en http://localhost:${PORT}`);
});
