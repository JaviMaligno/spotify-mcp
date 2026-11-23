// Servidor MCP remoto de solo lectura para tus playlists de Spotify.
// Pensado para un único usuario: tú. Se protege con una ruta secreta.
// Funciona en Vercel (exporta la app) y en cualquier servidor Node (app.listen).

import crypto from "node:crypto";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { put, get as getBlob } from "@vercel/blob";

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REFRESH_TOKEN, // opcional si hay almacén Blob: el token se guarda solo tras /login
  MCP_SECRET, // cadena larga y aleatoria; forma parte de la URL del conector
  PUBLIC_URL, // URL pública sin barra final; en Vercel se deduce sola
  BLOB_READ_WRITE_TOKEN, // almacenes Blob antiguos o fuera de Vercel
  BLOB_STORE_ID, // almacenes Blob nuevos conectados al proyecto (autenticación OIDC)
  PORT = 3000,
} = process.env;

if (!MCP_SECRET) throw new Error("Falta la variable MCP_SECRET.");
if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
  console.warn("Faltan SPOTIFY_CLIENT_ID y/o SPOTIFY_CLIENT_SECRET: el servidor arranca, pero no podrá hablar con Spotify hasta que las añadas.");
}

const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
const BASE_URL = (PUBLIC_URL || vercelUrl || `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const REDIRECT_URI = `${BASE_URL}/callback`;
const LOGIN_URL = `${BASE_URL}/login/${MCP_SECRET}`;
const SCOPES = [
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-public",
  "playlist-modify-private",
  "user-library-read", // leer «Me gusta»
  "user-library-modify", // añadir y quitar de «Me gusta»
  "user-top-read", // canciones y artistas más escuchados
  "user-read-recently-played", // últimas 50 reproducciones
].join(" ");
const API = "https://api.spotify.com/v1";
const TOKEN_LIFETIME_DAYS = 180; // Spotify obliga a volver a iniciar sesión cada 6 meses
const DAY = 86_400_000;

// ---------- Almacén del refresh token ----------
// Con Vercel Blob el token se guarda solo (al iniciar sesión y cuando Spotify lo rota).
// Sin Blob se usa SPOTIFY_REFRESH_TOKEN y la memoria del proceso.
const BLOB_PATH = "spotify/refresh-token.json";
// Vercel permite un prefijo al conectar el almacén (p. ej. MI_BLOB_READ_WRITE_TOKEN): se aceptan ambos
const findEnv = (suffix) =>
  Object.entries(process.env).find(([k, v]) => v && (k === suffix || k.endsWith(`_${suffix}`)));
const rwTokenEnv = BLOB_READ_WRITE_TOKEN ? ["BLOB_READ_WRITE_TOKEN", BLOB_READ_WRITE_TOKEN] : findEnv("BLOB_READ_WRITE_TOKEN");
const storeIdEnv = BLOB_STORE_ID ? ["BLOB_STORE_ID", BLOB_STORE_ID] : findEnv("BLOB_STORE_ID");
const blobAuth = rwTokenEnv ? { token: rwTokenEnv[1] } : storeIdEnv ? { storeId: storeIdEnv[1] } : {};
const hasBlob = Boolean(rwTokenEnv || storeIdEnv);
console.log(`Almacén Blob: ${hasBlob ? (rwTokenEnv?.[0] || storeIdEnv?.[0]) : "no configurado"}`);
let stored; // { refresh_token, obtained_at } | null | undefined (sin leer)

async function loadToken() {
  if (stored !== undefined) return stored;
  stored = null;
  if (hasBlob) {
    try {
      const res = await getBlob(BLOB_PATH, { access: "private", ...blobAuth });
      if (res?.statusCode === 200) stored = JSON.parse(await new Response(res.stream).text());
    } catch (err) {
      console.warn("No se pudo leer el token del almacén Blob:", err.message);
    }
  }
  if (!stored?.refresh_token && SPOTIFY_REFRESH_TOKEN) {
    stored = { refresh_token: SPOTIFY_REFRESH_TOKEN, obtained_at: null };
  }
  return stored;
}

async function saveToken(data) {
  stored = data;
  if (!hasBlob) return false;
  await put(BLOB_PATH, JSON.stringify(data), {
    access: "private",
    ...blobAuth,
    contentType: "application/json",
    allowOverwrite: true,
    addRandomSuffix: false,
    cacheControlMaxAge: 60,
  });
  return true;
}

async function clearToken() {
  stored = null;
  if (hasBlob) await saveToken({ refresh_token: null, obtained_at: null, expired_at: new Date().toISOString() });
}

function daysLeft(token) {
  if (!token?.obtained_at) return null;
  return Math.floor((Date.parse(token.obtained_at) + TOKEN_LIFETIME_DAYS * DAY - Date.now()) / DAY);
}

// ---------- Token de acceso de Spotify ----------
let accessToken = null;
let accessTokenExpiresAt = 0;

const basicAuth = () =>
  "Basic " + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64");

const reloginMessage = (why) =>
  `${why} Spotify obliga a volver a iniciar sesión cada 6 meses. Abre ${LOGIN_URL} y pulsa «Aceptar»` +
  (hasBlob ? "; el token nuevo se guarda solo." : "; después copia el token en SPOTIFY_REFRESH_TOKEN.");

async function getAccessToken() {
  if (accessToken && Date.now() < accessTokenExpiresAt - 60_000) return accessToken;
  const token = await loadToken();
  if (!token?.refresh_token) throw new Error(reloginMessage("No hay sesión de Spotify."));

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { Authorization: basicAuth(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refresh_token }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 400 && body.includes("invalid_grant")) {
      await clearToken(); // no reintentar: Spotify pide un inicio de sesión nuevo
      throw new Error(reloginMessage("La sesión de Spotify ha caducado o se ha revocado."));
    }
    throw new Error(`Spotify rechazó la renovación del token (${res.status}): ${body}`);
  }
  const data = await res.json();
  accessToken = data.access_token;
  accessTokenExpiresAt = Date.now() + data.expires_in * 1000;
  if (data.refresh_token && data.refresh_token !== token.refresh_token) {
    // Spotify a veces rota el refresh token; se conserva la fecha del inicio de sesión original
    const saved = await saveToken({ ...token, refresh_token: data.refresh_token });
    if (!saved) console.warn("Spotify ha emitido un refresh token nuevo y no hay almacén Blob para guardarlo.");
  }
  return accessToken;
}

// state firmado (sin memoria compartida: funciona en serverless)
function makeState() {
  const ts = Date.now().toString(36);
  const sig = crypto.createHmac("sha256", MCP_SECRET).update(ts).digest("hex").slice(0, 32);
  return `${ts}.${sig}`;
}
function checkState(state) {
  const [ts, sig] = String(state || "").split(".");
  if (!ts || !sig) return false;
  const expected = crypto.createHmac("sha256", MCP_SECRET).update(ts).digest("hex").slice(0, 32);
  const fresh = Date.now() - parseInt(ts, 36) < 15 * 60_000;
  return fresh && sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

async function spotify(pathOrUrl, { method = "GET", body } = {}) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${API}${pathOrUrl}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const headers = { Authorization: `Bearer ${await getAccessToken()}` };
    if (body) headers["Content-Type"] = "application/json";
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after") || 1);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (res.status === 403) {
      const text = await res.text();
      if (method !== "GET" || /scope/i.test(text)) {
        throw new Error(`La sesión actual no tiene permiso para esta operación (403: ${text}). Vuelve a iniciar sesión para conceder los permisos nuevos: ${LOGIN_URL}`);
      }
      throw new Error(`Error de Spotify 403 en ${url}: ${text}`);
    }
    if (!res.ok) throw new Error(`Error de Spotify ${res.status} en ${url}: ${await res.text()}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }
  throw new Error("Spotify sigue limitando las peticiones (429). Prueba más tarde.");
}

// ---------- Utilidades ----------
const fmtDuration = (ms) =>
  ms ? `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}` : undefined;

function formatTrack(t) {
  return {
    name: t.name,
    artists: (t.artists || []).map((a) => a.name),
    album: t.album?.name,
    release_date: t.album?.release_date,
    duration: fmtDuration(t.duration_ms),
    isrc: t.external_ids?.isrc,
    id: t.id,
    uri: t.uri,
    url: t.external_urls?.spotify,
  };
}

function toTrackUris(tracks) {
  return tracks.map((t) => {
    const m = String(t).match(/track[/:]([A-Za-z0-9]{22})/);
    if (m) return `spotify:track:${m[1]}`;
    if (/^[A-Za-z0-9]{22}$/.test(t)) return `spotify:track:${t}`;
    throw new Error(`No reconozco la canción "${t}". Usa su id, su uri spotify:track:... o su enlace.`);
  });
}

const norm = (x) => String(x || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

function filterTracks(tracks, query) {
  if (!query) return tracks;
  const words = norm(query).split(/\s+/).filter(Boolean);
  return tracks.filter((t) => {
    const hay = norm([t.name, t.album, ...t.artists].join(" "));
    return words.every((w) => hay.includes(w));
  });
}

// Descarga en paralelo todas las páginas de un listado con limit/offset
async function fetchAllPages(pageUrl, pageSize) {
  const first = await spotify(pageUrl(0));
  const pages = [first];
  const offsets = [];
  for (let o = pageSize; o < (first.total || 0); o += pageSize) offsets.push(o);
  for (let i = 0; i < offsets.length; i += 8) {
    pages.push(...(await Promise.all(offsets.slice(i, i + 8).map((o) => spotify(pageUrl(o))))));
  }
  return pages;
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

async function getPlaylistTracks(value, query) {
  const { id } = await resolvePlaylist(value);
  const meta = await spotify(`/playlists/${id}?fields=id,name,owner(display_name),external_urls`);
  const F = "total,next,items(added_at,item(id,name,uri,type,duration_ms,external_ids(isrc),artists(name),album(name,release_date),external_urls),track(id,name,uri,type,duration_ms,external_ids(isrc),artists(name),album(name,release_date),external_urls))";
  const pages = await fetchAllPages((offset) => `/playlists/${id}/items?limit=100&offset=${offset}&fields=${F}`, 100);
  const tracks = [];
  let index = 0;
  for (const page of pages) {
    for (const item of page.items || []) {
      index++;
      const t = item.item || item.track; // la API de 2026 usa "item"
      if (!t) continue; // canciones eliminadas o no disponibles
      if (t.type && t.type !== "track") continue; // ignora episodios de podcast
      const { id: tid, uri, url, ...rest } = formatTrack(t);
      tracks.push({ position: index, ...rest, added_at: item.added_at, id: tid, uri, url });
    }
  }
  const total = tracks.length;
  const out = filterTracks(tracks, query);
  return { id: meta.id, name: meta.name, owner: meta.owner?.display_name, url: meta.external_urls?.spotify, total, ...(query ? { query, matches: out.length } : {}), tracks: out };
}

async function addTracks(value, tracks, position) {
  const { id } = await resolvePlaylist(value);
  const uris = toTrackUris(tracks);
  for (let i = 0; i < uris.length; i += 100) {
    const body = { uris: uris.slice(i, i + 100) };
    if (position !== undefined) body.position = position + i; // 0 = al principio
    await spotify(`/playlists/${id}/items`, { method: "POST", body });
  }
  return { playlist: id, added: uris.length, ...(position !== undefined ? { position } : {}), uris };
}

async function searchTracks(query, limit = 10) {
  const n = Math.max(1, Math.min(10, limit));
  const data = await spotify(`/search?type=track&limit=${n}&q=${encodeURIComponent(query)}`);
  return (data.tracks?.items || []).map(formatTrack);
}

async function removeTracks(value, tracks) {
  const { id } = await resolvePlaylist(value);
  const uris = toTrackUris(tracks);
  for (let i = 0; i < uris.length; i += 100) {
    await spotify(`/playlists/${id}/items`, { method: "DELETE", body: { items: uris.slice(i, i + 100).map((uri) => ({ uri })) } });
  }
  return { playlist: id, removed: uris.length, uris };
}

// ---------- «Me gusta» (canciones guardadas) ----------
async function getSavedTracks(query) {
  const pages = await fetchAllPages((offset) => `/me/tracks?limit=50&offset=${offset}`, 50);
  const tracks = [];
  for (const page of pages) {
    for (const item of page.items || []) {
      const t = item.item || item.track;
      if (!t || (t.type && t.type !== "track")) continue;
      const { id, uri, url, ...rest } = formatTrack(t);
      tracks.push({ ...rest, added_at: item.added_at, id, uri, url });
    }
  }
  const out = filterTracks(tracks, query);
  return { total: tracks.length, ...(query ? { query, matches: out.length } : {}), tracks: out };
}

// Desde febrero de 2026 guardar y quitar usan /me/library con uris (máx. 40 por petición)
async function changeLibrary(tracks, method) {
  const uris = toTrackUris(tracks);
  for (let i = 0; i < uris.length; i += 40) {
    await spotify(`/me/library?uris=${encodeURIComponent(uris.slice(i, i + 40).join(","))}`, { method });
  }
  return uris;
}

// ---------- Actividad de escucha ----------
const TIME_RANGES = { short_term: "~4 semanas", medium_term: "~6 meses", long_term: "~1 año" };

async function getTop(type, timeRange = "medium_term", limit = 50) {
  const items = [];
  let next = `/me/top/${type}?time_range=${timeRange}&limit=50`;
  while (next && items.length < limit) {
    const page = await spotify(next);
    items.push(...(page.items || []));
    next = page.next;
  }
  const list = items.slice(0, limit).map((x, i) =>
    type === "tracks"
      ? { rank: i + 1, ...formatTrack(x) }
      : { rank: i + 1, name: x.name, genres: x.genres, id: x.id, url: x.external_urls?.spotify }
  );
  return { type, time_range: timeRange, period: TIME_RANGES[timeRange], total: list.length, items: list };
}

async function getRecentlyPlayed() {
  const data = await spotify("/me/player/recently-played?limit=50");
  return (data.items || []).map((x) => ({
    played_at: x.played_at,
    context: x.context?.type ? `${x.context.type}:${x.context.uri}` : null,
    ...formatTrack(x.track || x.item),
  }));
}

// ---------- Servidor MCP ----------
function buildMcpServer() {
  const server = new McpServer({ name: "spotify-playlists", version: "1.1.0" });

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
      description: "Devuelve las canciones de una playlist, en orden, con título, artistas, álbum, fecha de salida, duración, ISRC (identifica la grabación) y fecha en que se añadió. Con query solo devuelve las que contienen esas palabras en el título, artista o álbum (sin distinguir mayúsculas ni acentos): úsalo en playlists grandes. Acepta el nombre exacto de la playlist, su id o su enlace.",
      inputSchema: {
        playlist: z.string().describe('Nombre exacto (p. ej. "Bible"), id de 22 caracteres o enlace open.spotify.com/playlist/...'),
        query: z.string().optional().describe('Palabras a buscar, p. ej. "oceans hillsong". Opcional.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ playlist, query }) => {
      const data = await getPlaylistTracks(playlist, query);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "add_tracks",
    {
      title: "Añadir canciones a una playlist",
      description: "Añade canciones a una playlist propia, al final o en la posición indicada. Acepta ids, uris spotify:track:... o enlaces de canciones. Requiere haber iniciado sesión con permiso de edición.",
      inputSchema: {
        playlist: z.string().describe("Nombre exacto, id o enlace de la playlist"),
        tracks: z.array(z.string()).min(1).describe("Ids, uris o enlaces de las canciones"),
        position: z.number().int().min(0).optional().describe("Posición donde insertarlas, empezando en 0 (0 = al principio). Por defecto, al final."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ playlist, tracks, position }) => {
      const data = await addTracks(playlist, tracks, position);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "search_tracks",
    {
      title: "Buscar canciones en Spotify",
      description: "Busca canciones en el catálogo de Spotify. Admite la sintaxis de Spotify, p. ej. 'track:\"Skin & Bones\" artist:\"Fit For A King\"' o 'album:\"Descendants\"'. Devuelve título, artistas, álbum, fecha, duración, ISRC e id.",
      inputSchema: {
        query: z.string().describe("Texto de búsqueda"),
        limit: z.number().int().min(1).max(10).optional().describe("Resultados (máx. 10)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => {
      const data = await searchTracks(query, limit);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "remove_tracks",
    {
      title: "Quitar canciones de una playlist",
      description: "Quita canciones de una playlist propia (todas las apariciones de cada una). Acepta ids, uris spotify:track:... o enlaces de canciones.",
      inputSchema: {
        playlist: z.string().describe("Nombre exacto, id o enlace de la playlist"),
        tracks: z.array(z.string()).min(1).describe("Ids, uris o enlaces de las canciones"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ playlist, tracks }) => {
      const data = await removeTracks(playlist, tracks);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  const json = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });

  server.registerTool(
    "get_saved_tracks",
    {
      title: "Canciones de «Me gusta»",
      description: "Devuelve las canciones guardadas en «Me gusta» (de la más reciente a la más antigua), con título, artistas, álbum, fecha de salida, duración, ISRC y fecha en que se guardó. Con query filtra por título, artista o álbum (sin distinguir mayúsculas ni acentos).",
      inputSchema: { query: z.string().optional().describe("Palabras a buscar. Opcional.") },
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => json(await getSavedTracks(query))
  );

  server.registerTool(
    "save_tracks",
    {
      title: "Añadir a «Me gusta»",
      description: "Guarda canciones en «Me gusta». Acepta ids, uris spotify:track:... o enlaces.",
      inputSchema: { tracks: z.array(z.string()).min(1).describe("Ids, uris o enlaces de las canciones") },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ tracks }) => json({ saved: (await changeLibrary(tracks, "PUT")).length })
  );

  server.registerTool(
    "unsave_tracks",
    {
      title: "Quitar de «Me gusta»",
      description: "Quita canciones de «Me gusta». Acepta ids, uris spotify:track:... o enlaces.",
      inputSchema: { tracks: z.array(z.string()).min(1).describe("Ids, uris o enlaces de las canciones") },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ tracks }) => json({ removed: (await changeLibrary(tracks, "DELETE")).length })
  );

  server.registerTool(
    "get_top_items",
    {
      title: "Lo que más escuchas",
      description: "Ranking de tus canciones o artistas más escuchados según Spotify (sin número de reproducciones). time_range: short_term (~4 semanas), medium_term (~6 meses) o long_term (~1 año).",
      inputSchema: {
        type: z.enum(["tracks", "artists"]).describe("tracks o artists"),
        time_range: z.enum(["short_term", "medium_term", "long_term"]).optional().describe("Por defecto medium_term"),
        limit: z.number().int().min(1).max(500).optional().describe("Cuántos devolver (por defecto 50; Spotify suele cortar antes)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ type, time_range, limit }) => json(await getTop(type, time_range, limit))
  );

  server.registerTool(
    "get_recently_played",
    {
      title: "Escuchado recientemente",
      description: "Tus últimas 50 reproducciones (límite de Spotify), con fecha y hora y desde dónde se reprodujeron.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json(await getRecentlyPlayed())
  );

  server.registerTool(
    "auth_status",
    {
      title: "Estado de la sesión de Spotify",
      description: "Indica si hay sesión de Spotify, cuántos días quedan antes de tener que volver a iniciar sesión (caduca cada 6 meses) y el enlace para hacerlo.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const token = await loadToken();
      const info = {
        logged_in: Boolean(token?.refresh_token),
        obtained_at: token?.obtained_at ?? null,
        days_left: daysLeft(token),
        auto_save: hasBlob,
        login_url: LOGIN_URL,
      };
      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
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

// Inicio de sesión con Spotify (la primera vez y cada 6 meses)
app.get(`/login/${MCP_SECRET}`, (_req, res) => {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: SPOTIFY_CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state: makeState(),
    show_dialog: "true",
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

const page = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.5"><h1>${title}</h1>${body}</body>`;

app.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).type("html").send(page("Error", `<p>Spotify devolvió: ${String(error).replace(/[<>&"]/g, "")}</p>`));
  if (!checkState(state)) return res.status(400).type("html").send(page("Enlace caducado", "<p>Vuelve a abrir el enlace de inicio de sesión.</p>"));

  const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { Authorization: basicAuth(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }),
  });
  if (!tokenRes.ok) return res.status(500).type("html").send(page("Error", "<p>No se pudo canjear el código con Spotify. Vuelve a intentarlo.</p>"));
  const data = await tokenRes.json();
  accessToken = data.access_token;
  accessTokenExpiresAt = Date.now() + data.expires_in * 1000;

  const record = { refresh_token: data.refresh_token, obtained_at: new Date().toISOString() };
  let saved = false;
  let blobError = null;
  try {
    saved = await saveToken(record);
  } catch (err) {
    blobError = err?.message || String(err);
    console.error("No se pudo guardar el token en Blob:", err);
  }
  const renewBy = new Date(Date.now() + TOKEN_LIFETIME_DAYS * DAY).toLocaleDateString("es-ES");
  if (saved) {
    return res.type("html").send(page("Spotify conectado", `<p>Token guardado automáticamente. No tienes que copiar nada.</p><p>Spotify pedirá volver a iniciar sesión hacia el <b>${renewBy}</b>.</p>`));
  }
  const why = blobError
    ? `<p><b>El almacén Blob está configurado pero falló al guardar:</b> <code>${blobError.replace(/[<>&"]/g, "")}</code></p>`
    : `<p>No hay almacén automático configurado (falta <code>BLOB_STORE_ID</code> o <code>BLOB_READ_WRITE_TOKEN</code>). Variables relacionadas visibles: <code>${Object.keys(process.env).filter((k) => /BLOB|STORE/i.test(k)).join(", ") || "ninguna"}</code>. Entorno: <code>${process.env.VERCEL_ENV || "local"}</code>.</p>`;
  res.type("html").send(page("Spotify conectado", `${why}<p>Mientras tanto, puedes copiar este valor en la variable <code>SPOTIFY_REFRESH_TOKEN</code> y volver a desplegar:</p>
<textarea readonly style="width:100%;height:120px">${data.refresh_token}</textarea>
<p>Spotify pedirá volver a iniciar sesión hacia el <b>${renewBy}</b>. No compartas este valor.</p>`));
});

app.get("/", (_req, res) => res.type("text").send("OK"));

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
    console.log(`URL de callback para Spotify: ${REDIRECT_URI}`);
  });
}

export default app;
