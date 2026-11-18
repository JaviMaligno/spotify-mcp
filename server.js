// Servidor MCP remoto de solo lectura para tus playlists de Spotify.
// Pensado para un único usuario: tú. Se protege con una ruta secreta.

import crypto from "node:crypto";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REFRESH_TOKEN, // se obtiene una vez con /login/<MCP_SECRET>
  MCP_SECRET, // cadena larga y aleatoria; forma parte de la URL del conector
  PUBLIC_URL, // p. ej. https://tu-app.onrender.com (sin barra final)
  PORT = 3000,
} = process.env;

if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !MCP_SECRET) {
  console.error("Faltan variables: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET y MCP_SECRET son obligatorias.");
  process.exit(1);
}

const BASE_URL = (PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const REDIRECT_URI = `${BASE_URL}/callback`;
const SCOPES = "playlist-read-private playlist-read-collaborative";
const API = "https://api.spotify.com/v1";

// ---------- Token de Spotify ----------
let refreshToken = SPOTIFY_REFRESH_TOKEN;
let accessToken = null;
let accessTokenExpiresAt = 0;

const basicAuth = () =>
  "Basic " + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64");

async function getAccessToken() {
  if (!refreshToken) {
    throw new Error(`Falta SPOTIFY_REFRESH_TOKEN. Abre ${BASE_URL}/login/<MCP_SECRET> para obtenerlo.`);
  }
  if (accessToken && Date.now() < accessTokenExpiresAt - 60_000) return accessToken;

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { Authorization: basicAuth(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!res.ok) throw new Error(`Spotify rechazó el refresh token (${res.status}): ${await res.text()}`);
  const data = await res.json();
  accessToken = data.access_token;
  accessTokenExpiresAt = Date.now() + data.expires_in * 1000;
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    refreshToken = data.refresh_token;
    console.warn("Spotify ha emitido un refresh token nuevo; actualiza SPOTIFY_REFRESH_TOKEN si el servicio se reinicia.");
  }
  return accessToken;
}

async function spotify(pathOrUrl) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${API}${pathOrUrl}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${await getAccessToken()}` } });
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after") || 1);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`Error de Spotify ${res.status} en ${url}: ${await res.text()}`);
    return res.json();
  }
  throw new Error("Spotify sigue limitando las peticiones (429). Prueba más tarde.");
}

// ---------- Lógica de playlists ----------
async function listPlaylists() {
  const out = [];
  let next = "/me/playlists?limit=50";
  while (next) {
    const page = await spotify(next);
    for (const p of page.items || []) {
      if (!p) continue;
      out.push({
        id: p.id,
        name: p.name,
        owner: p.owner?.display_name || p.owner?.id,
        tracks: p.tracks?.total ?? p.items?.total ?? null,
        url: p.external_urls?.spotify,
      });
    }
    next = page.next;
  }
  return out;
}

function extractPlaylistId(value) {
  const m = String(value).match(/playlist[/:]([A-Za-z0-9]{22})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9]{22}$/.test(value)) return value;
  return null;
}

async function resolvePlaylist(value) {
  const id = extractPlaylistId(value);
  if (id) return { id };
  const wanted = String(value).trim().toLowerCase();
  const all = await listPlaylists();
  const exact = all.filter((p) => p.name.trim().toLowerCase() === wanted);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new Error(`Hay ${exact.length} playlists llamadas "${value}". Usa el id: ${exact.map((p) => p.id).join(", ")}`);
  }
  throw new Error(`No encuentro ninguna playlist llamada "${value}".`);
}

async function getPlaylistTracks(value) {
  const { id } = await resolvePlaylist(value);
  const meta = await spotify(`/playlists/${id}?fields=id,name,owner(display_name),external_urls`);
  const tracks = [];
  let next = `/playlists/${id}/tracks?limit=100&fields=next,items(added_at,track(id,name,uri,type,artists(name),album(name),external_urls))`;
  while (next) {
    const page = await spotify(next);
    for (const item of page.items || []) {
      const t = item.track;
      if (!t) continue; // canciones eliminadas o no disponibles
      tracks.push({
        position: tracks.length + 1,
        name: t.name,
        artists: (t.artists || []).map((a) => a.name),
        album: t.album?.name,
        added_at: item.added_at,
        id: t.id,
        uri: t.uri,
        url: t.external_urls?.spotify,
      });
    }
    next = page.next;
  }
  return { id: meta.id, name: meta.name, owner: meta.owner?.display_name, url: meta.external_urls?.spotify, total: tracks.length, tracks };
}

// ---------- Servidor MCP ----------
function buildMcpServer() {
  const server = new McpServer({ name: "spotify-playlists", version: "1.0.0" });

  server.registerTool(
    "list_playlists",
    {
      title: "Listar mis playlists",
      description: "Devuelve todas las playlists de la biblioteca del usuario (propias y seguidas), con id, nombre, propietario y número de canciones.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const playlists = await listPlaylists();
      return { content: [{ type: "text", text: JSON.stringify({ total: playlists.length, playlists }, null, 2) }] };
    }
  );

  server.registerTool(
    "get_playlist_tracks",
    {
      title: "Canciones de una playlist",
      description: "Devuelve todas las canciones de una playlist, en orden, con título, artistas, álbum y fecha en que se añadió. Acepta el nombre exacto de la playlist, su id o su enlace.",
      inputSchema: {
        playlist: z.string().describe('Nombre exacto (p. ej. "Bible"), id de 22 caracteres o enlace open.spotify.com/playlist/...'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ playlist }) => {
      const data = await getPlaylistTracks(playlist);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  return server;
}

// ---------- HTTP ----------
const app = express();
app.use(express.json({ limit: "1mb" }));

const MCP_PATH = `/mcp/${MCP_SECRET}`;

app.post(MCP_PATH, async (req, res) => {
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); // sin estado
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Error interno" }, id: null });
    }
  }
});

const methodNotAllowed = (_req, res) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Método no permitido" }, id: null });
app.get(MCP_PATH, methodNotAllowed);
app.delete(MCP_PATH, methodNotAllowed);

// Inicio de sesión con Spotify (solo una vez, para obtener el refresh token)
const pendingStates = new Set();

app.get(`/login/${MCP_SECRET}`, (_req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  pendingStates.add(state);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: SPOTIFY_CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state,
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

app.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send(`Spotify devolvió un error: ${error}`);
  if (!state || !pendingStates.has(state)) return res.status(400).send("Estado no válido. Vuelve a empezar desde /login.");
  pendingStates.delete(state);

  const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { Authorization: basicAuth(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }),
  });
  if (!tokenRes.ok) return res.status(500).send(`No se pudo canjear el código: ${await tokenRes.text()}`);
  const data = await tokenRes.json();
  refreshToken = data.refresh_token;
  accessToken = data.access_token;
  accessTokenExpiresAt = Date.now() + data.expires_in * 1000;

  res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Spotify conectado</title>
<body style="font-family:system-ui;max-width:640px;margin:40px auto;line-height:1.5">
<h1>Spotify conectado</h1>
<p>Copia este valor en la variable de entorno <code>SPOTIFY_REFRESH_TOKEN</code> de tu servicio y reinícialo:</p>
<textarea readonly style="width:100%;height:120px">${data.refresh_token}</textarea>
<p>No lo compartas con nadie: da acceso de lectura a tus playlists.</p>
</body>`);
});

app.get("/", (_req, res) => res.type("text").send("OK"));

app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
  console.log(`URL de callback para Spotify: ${REDIRECT_URI}`);
});
