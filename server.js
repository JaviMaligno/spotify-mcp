// Servidor MCP remoto para tus playlists de Spotify, «Me gusta» y tu actividad de escucha.
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
  CRON_SECRET, // opcional: si existe, /cron/log-plays exige «Authorization: Bearer <valor>» (Vercel Cron lo envía solo)
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

let tokenLoading; // lectura en curso: las llamadas simultáneas en un arranque en frío esperan a la misma

async function loadToken() {
  if (stored !== undefined) return stored;
  tokenLoading ||= (async () => {
    let token = null;
    if (hasBlob) {
      try {
        const res = await getBlob(BLOB_PATH, { access: "private", ...blobAuth });
        if (res?.statusCode === 200) token = JSON.parse(await new Response(res.stream).text());
      } catch (err) {
        console.warn("No se pudo leer el token del almacén Blob:", err.message);
      }
    }
    if (!token?.refresh_token && SPOTIFY_REFRESH_TOKEN) {
      token = { refresh_token: SPOTIFY_REFRESH_TOKEN, obtained_at: null };
    }
    if (stored === undefined) stored = token; // no pisar un token guardado mientras tanto
  })().finally(() => {
    tokenLoading = undefined;
  });
  await tokenLoading;
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

// ---------- Almacén de datos (registro de escuchas e índice de playlists) ----------
async function readJson(path) {
  if (!hasBlob) return null;
  const res = await getBlob(path, { access: "private", useCache: false, ...blobAuth });
  return res?.statusCode === 200 ? JSON.parse(await new Response(res.stream).text()) : null;
}

async function writeJson(path, data) {
  await put(path, JSON.stringify(data), {
    access: "private",
    ...blobAuth,
    contentType: "application/json",
    allowOverwrite: true,
    addRandomSuffix: false,
    cacheControlMaxAge: 60,
  });
}

const needBlob = (what) => {
  if (!hasBlob) throw new Error(`${what} necesita el almacén Blob de Vercel (BLOB_STORE_ID o BLOB_READ_WRITE_TOKEN).`);
};

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
  for (let attempt = 0; attempt < 4; attempt++) {
    const headers = { Authorization: `Bearer ${await getAccessToken()}` };
    if (body) headers["Content-Type"] = "application/json";
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after") || 1);
      if (wait > 15) {
        // Esperas largas (pueden ser horas): mejor avisar que dejar la llamada colgada
        const until = new Date(Date.now() + wait * 1000).toISOString().slice(0, 16).replace("T", " ");
        const pretty = wait >= 3600 ? `${(wait / 3600).toFixed(1)} h` : `${Math.ceil(wait / 60)} min`;
        throw new Error(`Spotify ha limitado las peticiones a ${new URL(url).pathname}: hay que esperar ${pretty} (hasta las ${until} UTC). No se ha hecho el cambio; repítelo después.`);
      }
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (res.status >= 500 && method === "GET" && attempt < 3) {
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt)); // fallos pasajeros de Spotify (502/503/504)
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
    url: t.external_urls?.spotify,
  };
}

// Una línea por canción: «[#rank|posición.] id isrc [fecha] Artistas — Título». Ahorra ~75 % de texto.
const briefTrack = (t) =>
  [
    t.rank && `#${t.rank}`,
    t.position && `${t.position}.`,
    t.id,
    t.isrc || "-",
    t.added_at?.slice(0, 10),
    `${(t.artists || []).join(", ")} — ${t.name}`,
  ]
    .filter(Boolean)
    .join(" ");

// Aplica offset/limit y, si se pide, el formato breve
function shape(tracks, { limit, offset = 0, brief } = {}) {
  const slice = tracks.slice(offset, limit ? offset + limit : undefined);
  return {
    ...(limit || offset ? { offset, returned: slice.length } : {}),
    tracks: brief ? slice.map(briefTrack) : slice,
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

// ---------- Filtros de conjuntos ----------
// Una «lista» es una playlist (nombre, id o enlace) o «Me gusta» (me_gusta).
const LIKED_RE = /^(me[ _]?gusta|liked|saved)$/i;
const isrcKey = (t) => t.isrc?.toUpperCase();

async function listKeys(spec) {
  const data = LIKED_RE.test(spec.trim()) ? await getSavedTracks() : await getPlaylistTracks(spec);
  return { isrcs: new Set(data.tracks.map(isrcKey).filter(Boolean)), ids: new Set(data.tracks.map((t) => t.id)) };
}

// not_in / also_in comparan por ISRC (misma grabación aunque cambie el id) y, si falta, por id.
// duplicates deja solo las grabaciones que aparecen más de una vez, agrupadas.
async function applyFilters(tracks, { not_in, also_in, duplicates } = {}) {
  let out = tracks;
  for (const [spec, keep] of [[not_in, false], [also_in, true]]) {
    if (!spec) continue;
    const keys = await listKeys(spec);
    out = out.filter((t) => (keys.isrcs.has(isrcKey(t)) || keys.ids.has(t.id)) === keep);
  }
  if (duplicates) {
    const groups = new Map();
    for (const t of out) {
      const k = isrcKey(t) || t.id;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
    out = [...groups.values()]
      .filter((g) => g.length > 1)
      .flatMap((g) => g.sort((a, b) => String(a.added_at).localeCompare(String(b.added_at)))); // la más antigua primero
  }
  return out;
}
const hasFilters = (o = {}) => Boolean(o.not_in || o.also_in || o.duplicates);
const filterInfo = (o = {}) => ({
  ...(o.not_in ? { not_in: o.not_in } : {}),
  ...(o.also_in ? { also_in: o.also_in } : {}),
  ...(o.duplicates ? { duplicates: true } : {}),
});

// Descarga en paralelo todas las páginas de un listado con limit/offset
async function fetchAllPages(pageUrl, pageSize) {
  const first = await spotify(pageUrl(0));
  const pages = [first];
  const offsets = [];
  for (let o = pageSize; o < (first.total || 0); o += pageSize) offsets.push(o);
  for (let i = 0; i < offsets.length; i += 4) {
    pages.push(...(await Promise.all(offsets.slice(i, i + 4).map((o) => spotify(pageUrl(o))))));
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
        owner_id: p.owner?.id,
        snapshot_id: p.snapshot_id,
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

async function getPlaylistTracks(value, query, opts) {
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
      const { id: tid, url, ...rest } = formatTrack(t);
      tracks.push({ position: index, ...rest, added_at: item.added_at, id: tid, url });
    }
  }
  const total = tracks.length;
  const out = await applyFilters(filterTracks(tracks, query), opts);
  const filtered = query || hasFilters(opts);
  return { id: meta.id, name: meta.name, owner: meta.owner?.display_name, url: meta.external_urls?.spotify, total, ...(query ? { query } : {}), ...filterInfo(opts), ...(filtered ? { matches: out.length } : {}), ...shape(out, opts) };
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
const SAVED_CACHE = "spotify/saved-cache.json";
let savedMem; // { sig, tracks }

function parseSaved(pages) {
  const tracks = [];
  for (const page of pages) {
    for (const item of page.items || []) {
      const t = item.item || item.track;
      if (!t || (t.type && t.type !== "track")) continue;
      const { id, url, ...rest } = formatTrack(t);
      tracks.push({ ...rest, added_at: item.added_at, id, url });
    }
  }
  return tracks;
}

// «Me gusta» completa con caché: una sola petición comprueba si ha cambiado (total y última canción guardada)
// y solo entonces se vuelven a bajar todas las páginas. Evita que Spotify limite /me/tracks por uso repetido.
async function loadAllSaved() {
  const pageUrl = (o) => `/me/tracks?limit=50&offset=${o}`;
  const head = await spotify(pageUrl(0));
  const top = head.items?.[0];
  const sig = `${head.total}|${top?.added_at}|${(top?.item || top?.track)?.id}`;
  if (savedMem?.sig !== sig && hasBlob) {
    const cached = await readJson(SAVED_CACHE).catch(() => null);
    if (cached?.sig === sig) savedMem = cached;
  }
  if (savedMem?.sig === sig) return savedMem.tracks;
  const pages = [head];
  const offsets = [];
  for (let o = 50; o < (head.total || 0); o += 50) offsets.push(o);
  for (let i = 0; i < offsets.length; i += 4) {
    pages.push(...(await Promise.all(offsets.slice(i, i + 4).map((o) => spotify(pageUrl(o))))));
  }
  savedMem = { sig, tracks: parseSaved(pages) };
  if (hasBlob) await writeJson(SAVED_CACHE, savedMem).catch((err) => console.warn("No se pudo guardar la caché de «Me gusta»:", err.message));
  return savedMem.tracks;
}

async function getSavedTracks(query, opts = {}) {
  const { limit, offset = 0, brief } = opts;
  const pageUrl = (o) => `/me/tracks?limit=50&offset=${o}`;
  // Sin query y con limit basta con descargar las páginas pedidas
  const partial = !query && !hasFilters(opts) && limit;
  let pages = [];
  let first = 0;
  let tracks;
  if (partial) {
    first = Math.floor(offset / 50) * 50;
    const offsets = [];
    for (let o = first; o < offset + limit; o += 50) offsets.push(o);
    pages = await Promise.all(offsets.map((o) => spotify(pageUrl(o))));
    tracks = parseSaved(pages);
  } else {
    tracks = await loadAllSaved();
  }
  const out = await applyFilters(filterTracks(tracks, query), opts);
  const total = partial ? pages[0]?.total ?? tracks.length : tracks.length;
  const shaped = shape(out, { limit, offset: partial ? offset - first : offset, brief });
  const filtered = query || hasFilters(opts);
  return { total, ...(query ? { query } : {}), ...filterInfo(opts), ...(filtered ? { matches: out.length } : {}), ...shaped, ...(limit || offset ? { offset } : {}) };
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

async function getTop(type, timeRange = "medium_term", limit = 50, brief = false, filters = {}) {
  const items = [];
  let next = `/me/top/${type}?time_range=${timeRange}&limit=50`;
  while (next && items.length < limit) {
    const page = await spotify(next);
    items.push(...(page.items || []));
    next = page.next;
  }
  let list = items.slice(0, limit).map((x, i) =>
    type === "tracks"
      ? { rank: i + 1, ...formatTrack(x) }
      : { rank: i + 1, name: x.name, genres: x.genres, id: x.id, url: x.external_urls?.spotify }
  );
  const total = list.length;
  const filtered = type === "tracks" && hasFilters(filters);
  if (filtered) list = await applyFilters(list, { not_in: filters.not_in, also_in: filters.also_in });
  return { type, time_range: timeRange, period: TIME_RANGES[timeRange], total, ...(filtered ? { ...filterInfo({ ...filters, duplicates: false }), matches: list.length } : {}), items: brief && type === "tracks" ? list.map(briefTrack) : list };
}

async function getRecentlyPlayed() {
  const data = await spotify("/me/player/recently-played?limit=50");
  return (data.items || []).map((x) => ({
    played_at: x.played_at,
    context: x.context?.type ? `${x.context.type}:${x.context.uri}` : null,
    ...formatTrack(x.track || x.item),
  }));
}

// ---------- Registro de escuchas ----------
// Spotify solo devuelve las últimas 50 reproducciones. Aquí se acumulan en Blob, un archivo por mes,
// con el contexto (playlist, álbum…) desde el que sonó cada una, que el historial extendido no trae.
const playsPath = (month) => `spotify/plays/${month}.json`;
const LOG_EVERY = 10 * 60_000;
let lastLogAt = 0;

async function logPlays({ force = false } = {}) {
  if (!hasBlob) return { logged: 0 };
  if (!force && Date.now() - lastLogAt < LOG_EVERY) return { logged: 0, skipped: true };
  const previous = lastLogAt;
  lastLogAt = Date.now();
  try {
    const data = await spotify("/me/player/recently-played?limit=50");
    const byMonth = new Map();
    for (const x of data.items || []) {
      const t = x.track || x.item;
      if (!t || !x.played_at) continue;
      const month = x.played_at.slice(0, 7);
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month).push({
        played_at: x.played_at,
        id: t.id,
        isrc: t.external_ids?.isrc ?? null,
        name: t.name,
        artists: (t.artists || []).map((a) => a.name),
        duration_ms: t.duration_ms,
        context: x.context?.uri ?? null,
      });
    }
    let logged = 0;
    for (const [month, plays] of byMonth) {
      const existing = (await readJson(playsPath(month))) || [];
      const seen = new Set(existing.map((p) => p.played_at));
      const fresh = plays.filter((p) => !seen.has(p.played_at));
      if (!fresh.length) continue;
      const merged = [...existing, ...fresh].sort((a, b) => (a.played_at < b.played_at ? -1 : 1));
      await writeJson(playsPath(month), merged);
      logged += fresh.length;
    }
    return { logged };
  } catch (err) {
    lastLogAt = previous; // que el siguiente intento no espere
    throw err;
  }
}

function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.slice(0, 7).split("-").map(Number);
  const end = to.slice(0, 7);
  for (let i = 0; i < 240; i++) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (key > end) break;
    out.push(key);
    if (++m > 12) (m = 1), y++;
  }
  return out;
}

async function getPlayLog({ since, until, detail = false, limit = 200 } = {}) {
  needBlob("El registro de escuchas");
  await logPlays({ force: true }).catch((err) => console.warn("No se pudo actualizar el registro:", err.message));
  const now = new Date().toISOString();
  const from = since || new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);
  const to = until || now.slice(0, 10);
  const files = await Promise.all(monthsBetween(from, to).map((m) => readJson(playsPath(m))));
  const plays = files.flat().filter((p) => p && p.played_at >= from && p.played_at.slice(0, to.length) <= to);

  const names = new Map((await listPlaylists()).map((p) => [`spotify:playlist:${p.id}`, p.name]));
  const where = (uri) => {
    if (!uri) return "sin contexto";
    if (names.has(uri)) return names.get(uri);
    if (uri.endsWith(":collection")) return "Me gusta";
    return uri.split(":").slice(1, 3).join(":"); // album:<id>, artist:<id>, playlist:<id ajena>
  };
  const range = { since: from, until: to, plays: plays.length, oldest: plays[0]?.played_at ?? null };

  if (detail) {
    const rows = plays.slice(-limit).map((p) => `${p.played_at.slice(0, 16)} ${p.id} ${p.isrc || "-"} ${p.artists.join(", ")} — ${p.name} [${where(p.context)}]`);
    return { ...range, returned: rows.length, rows };
  }
  const byTrack = new Map();
  for (const p of plays) {
    const key = p.isrc || p.id;
    if (!byTrack.has(key)) byTrack.set(key, { plays: 0, id: p.id, isrc: p.isrc, track: `${p.artists.join(", ")} — ${p.name}`, days: new Set(), last: p.played_at, from: {} });
    const s = byTrack.get(key);
    s.plays++;
    s.days.add(p.played_at.slice(0, 10));
    if (p.played_at > s.last) s.last = p.played_at;
    const w = where(p.context);
    s.from[w] = (s.from[w] || 0) + 1;
  }
  const tracks = [...byTrack.values()]
    .sort((a, b) => b.plays - a.plays || (a.last < b.last ? 1 : -1))
    .slice(0, limit)
    .map((s) => ({ ...s, days: s.days.size, last: s.last.slice(0, 10) }));
  return { ...range, distinct_tracks: byTrack.size, returned: tracks.length, tracks };
}

// ---------- Índice de playlists propias ----------
// Para saber en qué playlists está una canción (comparando por ISRC, que sobrevive a los cambios de id).
// Cada playlist se guarda en Blob con su snapshot_id y solo se vuelve a descargar cuando cambia.
const indexPath = (id) => `spotify/index/${id}.json`;
const indexMem = new Map(); // id -> { snapshot_id, tracks: [[id, isrc, "Artistas — Título"], ...] }

async function loadIndex(budgetMs = 20_000) {
  needBlob("El índice de playlists");
  const start = Date.now();
  const me = await spotify("/me");
  const own = (await listPlaylists()).filter((p) => p.owner_id === me.id).sort((a, b) => (a.tracks || 0) - (b.tracks || 0));
  const cached = await Promise.all(
    own.map((p) => (indexMem.get(p.id)?.snapshot_id === p.snapshot_id ? indexMem.get(p.id) : readJson(indexPath(p.id)).catch(() => null)))
  );
  const index = [];
  const pending = [];
  for (let i = 0; i < own.length; i++) {
    const p = own[i];
    let entry = cached[i];
    if (!entry || entry.snapshot_id !== p.snapshot_id) {
      if (Date.now() - start > budgetMs) {
        pending.push(p.name); // se indexará en la siguiente llamada; mientras, vale la copia anterior si existe
        if (!entry) continue;
      } else {
        const data = await getPlaylistTracks(p.id);
        entry = { snapshot_id: p.snapshot_id, tracks: data.tracks.map((t) => [t.id, t.isrc || null, `${t.artists.join(", ")} — ${t.name}`]) };
        await writeJson(indexPath(p.id), entry);
      }
    }
    indexMem.set(p.id, entry);
    index.push({ id: p.id, name: p.name, tracks: entry.tracks });
  }
  return { index, pending };
}

const ISRC_RE = /^[A-Za-z]{2}[A-Za-z0-9]{3}\d{7}$/;

async function findInPlaylists({ tracks = [], playlist } = {}) {
  if (!tracks.length && !playlist) throw new Error("Indica tracks, playlist o ambos.");
  const { index, pending } = await loadIndex();
  const byId = new Map(); // id -> { isrc, label }
  const idIn = new Map(); // id -> Set(nombres)
  const isrcIn = new Map(); // isrc -> Set(nombres)
  const add = (map, key, name) => key && (map.get(key) || map.set(key, new Set()).get(key)).add(name);
  for (const p of index) {
    for (const [id, isrc, label] of p.tracks) {
      if (!byId.has(id)) byId.set(id, { isrc, label });
      add(idIn, id, p.name);
      add(isrcIn, isrc?.toUpperCase(), p.name);
    }
  }
  const wanted = [];
  let skip = null;
  if (playlist) {
    const data = await getPlaylistTracks(playlist);
    skip = data.name;
    for (const t of data.tracks) wanted.push({ id: t.id, isrc: t.isrc, label: `${t.artists.join(", ")} — ${t.name}` });
  }
  for (const raw of tracks) {
    if (ISRC_RE.test(raw)) {
      wanted.push({ isrc: raw });
      continue;
    }
    const id = toTrackUris([raw])[0].split(":")[2];
    wanted.push({ id, ...byId.get(id) });
  }
  const results = wanted.map((w) => {
    const isrc = w.isrc?.toUpperCase();
    const found = new Set([...(idIn.get(w.id) || []), ...(isrcIn.get(isrc) || [])]);
    if (skip) found.delete(skip);
    return { track: w.label ?? null, id: w.id ?? null, isrc: isrc ?? null, playlists: [...found].sort() };
  });
  return {
    indexed_playlists: index.length,
    ...(pending.length ? { pending, note: "Faltan playlists por indexar: repite la llamada para completarlas." } : {}),
    ...(skip ? { excluding: skip } : {}),
    results,
  };
}

// ---------- Motor de recomendación ----------
// Aprende de las decisiones explícitas (qué está en la lista objetivo) con una regresión logística
// y se valida escondiendo una quinta parte de la lista cada vez. No modifica nada en Spotify.
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

function fitLogistic(X, y, rows, d, { iters = 300, lr = 1, l2 = 0.01 } = {}) {
  const n = rows.length;
  const mean = new Float64Array(d);
  const std = new Float64Array(d);
  for (const r of rows) for (let j = 0; j < d; j++) mean[j] += X[r * d + j];
  for (let j = 0; j < d; j++) mean[j] /= n;
  for (const r of rows) for (let j = 0; j < d; j++) std[j] += (X[r * d + j] - mean[j]) ** 2;
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j] / n) || 1;
  let pos = 0;
  for (const r of rows) pos += y[r];
  const wPos = n / (2 * Math.max(pos, 1)); // clases equilibradas: la lista suele ser una fracción pequeña
  const wNeg = n / (2 * Math.max(n - pos, 1));
  const w = new Float64Array(d);
  let b = 0;
  const g = new Float64Array(d);
  for (let it = 0; it < iters; it++) {
    g.fill(0);
    let gb = 0;
    for (const r of rows) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * ((X[r * d + j] - mean[j]) / std[j]);
      const e = (sigmoid(z) - y[r]) * (y[r] ? wPos : wNeg);
      gb += e;
      for (let j = 0; j < d; j++) g[j] += e * ((X[r * d + j] - mean[j]) / std[j]);
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (g[j] / n + l2 * w[j]);
    b -= lr * (gb / n);
  }
  const contrib = (r) => Array.from(w, (wj, j) => wj * ((X[r * d + j] - mean[j]) / std[j]));
  const score = (r) => sigmoid(b + contrib(r).reduce((a, c) => a + c, 0));
  return { w, score, contrib };
}

function aucOf(scores, labels) {
  const order = scores.map((s, i) => [s, labels[i]]).sort((a, b) => a[0] - b[0]);
  let rankSum = 0;
  let pos = 0;
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j < order.length && order[j][0] === order[i][0]) j++;
    const avg = (i + 1 + j) / 2; // rango medio en los empates
    for (let k = i; k < j; k++) if (order[k][1]) (rankSum += avg), pos++;
    i = j;
  }
  const neg = order.length - pos;
  return pos && neg ? (rankSum - (pos * (pos + 1)) / 2) / (pos * neg) : null;
}

function seededShuffle(arr, seed = 7) {
  let a = seed;
  const rnd = () => ((a = (a + 0x6d2b79f5) | 0), (((Math.imul(a ^ (a >>> 15), 1 | a) ^ (a >>> 7)) >>> 0) / 4294967296));
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const round = (x, n = 2) => (x == null ? null : Number(x.toFixed(n)));

// Lo que se aprende son las decisiones RECIENTES y fechadas: veredictos guardados (sí/no) y lo añadido
// a la lista desde `since`. Lo que ya estaba en la lista de antes no se da por bueno: las listas pueden
// estar anticuadas, así que el modelo las puntúa igual que al resto y señala las que menos encajan hoy.
const FEEDBACK_PATH = "spotify/feedback.json";

async function recommend({ target, within, exclude = [], since, yes = [], no = [], top = 30, ask = 20 } = {}) {
  needBlob("El motor de recomendación");
  const targetIsLiked = LIKED_RE.test(target.trim());
  const [{ index, pending }, saved, ...tops] = await Promise.all([
    loadIndex(25_000),
    getSavedTracks(),
    getTop("tracks", "short_term", 500),
    getTop("tracks", "medium_term", 500),
    getTop("tracks", "long_term", 500),
  ]);
  const targetData = targetIsLiked ? saved : await getPlaylistTracks(target);
  const targetName = targetIsLiked ? "Me gusta" : targetData.name;
  const now = new Date().toISOString();
  const sinceDate = since || new Date(Date.now() - 365 * DAY).toISOString().slice(0, 10);

  // Canciones conocidas, por ISRC (o id si no tiene)
  const tracks = new Map(); // clave -> { id, label, artists }
  const keyOfId = new Map();
  const see = (isrc, id, label, artists) => {
    const k = isrc?.toUpperCase() || id;
    if (!tracks.has(k)) tracks.set(k, { id, label, artists: artists || label.split(" — ")[0].split(",").map((a) => a.trim()) });
    keyOfId.set(id, k);
    return k;
  };
  const seeFull = (t) => see(t.isrc, t.id, `${t.artists.join(", ")} — ${t.name}`, t.artists);
  const lists = new Map(index.map((p) => [p.name, new Set(p.tracks.map(([id, isrc, label]) => see(isrc, id, label)))]));
  const liked = new Set(saved.tracks.map(seeFull));
  const ranks = tops.map((t) => new Map(t.items.map((x) => [seeFull(x), 1 - (x.rank - 1) / Math.max(t.items.length, 1)])));
  const plays = new Map();
  for (const p of (await Promise.all(monthsBetween("2026-11", now).map((m) => readJson(playsPath(m))))).flat().filter(Boolean)) {
    const k = see(p.isrc, p.id, `${p.artists.join(", ")} — ${p.name}`, p.artists);
    plays.set(k, (plays.get(k) || 0) + 1);
  }
  const members = new Set(targetData.tracks.map(seeFull));

  // Veredictos: se guardan los nuevos y se usan todos los de esta lista (el más reciente manda)
  const resolve = (raw) => {
    if (ISRC_RE.test(raw)) return raw.toUpperCase();
    const id = toTrackUris([raw])[0].split(":")[2];
    return keyOfId.get(id) || id;
  };
  const stored = (await readJson(FEEDBACK_PATH)) || [];
  const fresh = [...yes.map((r) => [r, "yes"]), ...no.map((r) => [r, "no"])].map(([raw, verdict]) => {
    const key = resolve(raw);
    return { at: now, list: targetName, verdict, key, id: tracks.get(key)?.id ?? null, label: tracks.get(key)?.label ?? null };
  });
  if (fresh.length) await writeJson(FEEDBACK_PATH, [...stored, ...fresh]);
  const labels = new Map(); // clave -> 1 | 0
  let fromAdditions = 0;
  for (const t of targetData.tracks) if ((t.added_at || "") >= sinceDate) labels.set(seeFull(t), 1), fromAdditions++;
  const verdicts = [...stored, ...fresh].filter((f) => f.list === targetName);
  for (const f of verdicts) labels.set(f.key, f.verdict === "yes" ? 1 : 0);

  // Excluidas por género: las de esas playlists, los títulos que las nombran y los artistas que viven en ellas
  const banned = new Set();
  for (const name of exclude) {
    const set = lists.get(name) || new Set((await getPlaylistTracks(name)).tracks.map(seeFull));
    const word = norm(name).replace(/[^a-z0-9]/g, "");
    const tagged = new Set(set);
    if (word.length >= 4) for (const [k, t] of tracks) if (norm(t.label).includes(word)) tagged.add(k);
    const perArtist = new Map();
    for (const [k, t] of tracks) for (const a of t.artists) {
      const c = perArtist.get(a) || perArtist.set(a, [0, 0]).get(a);
      c[0]++;
      if (tagged.has(k)) c[1]++;
    }
    for (const [k, t] of tracks) if (tagged.has(k) || t.artists.some((a) => perArtist.get(a)[0] >= 3 && perArtist.get(a)[1] / perArtist.get(a)[0] >= 0.6)) banned.add(k);
  }

  // De dónde salen las candidatas: «Me gusta», de todo lo conocido; una playlist, de `within` (por defecto «Me gusta»)
  const pool = targetIsLiked
    ? new Set(tracks.keys())
    : !within || LIKED_RE.test(within.trim())
      ? liked
      : new Set((await getPlaylistTracks(within)).tracks.map(seeFull));
  const keys = [...new Set([...pool, ...members, ...[...labels.keys()].filter((k) => tracks.has(k))])];
  const rowOf = new Map(keys.map((k, i) => [k, i]));
  const trainRows = [...labels.keys()].filter((k) => rowOf.has(k)).map((k) => rowOf.get(k));
  const labelOf = (i) => labels.get(keys[i]);

  // Señales. Las afinidades no cuentan la propia canción.
  const count = (set) => {
    const m = new Map();
    for (const [k, t] of tracks) for (const a of t.artists) {
      const c = m.get(a) || m.set(a, [0, 0]).get(a);
      c[0]++;
      if (set.has(k)) c[1]++;
    }
    return m;
  };
  const yesSet = new Set([...labels].filter(([, v]) => v === 1).map(([k]) => k));
  const affinity = (m, set, k) => Math.max(...tracks.get(k).artists.map((a) => (m.get(a)[1] - (set.has(k) ? 1 : 0) + 0.5) / (m.get(a)[0] - 1 + 5)));
  const byLiked = count(liked);
  const byYes = count(yesSet);
  const labeled = trainRows.map((i) => keys[i]);
  const tags = [...lists.entries()]
    .filter(([name, set]) => name !== targetName && set.size >= 30)
    .filter(([, set]) => {
      const inside = labeled.reduce((n, k) => n + set.has(k), 0);
      return inside >= 8 && inside <= 0.9 * labeled.length; // solo playlists con ejemplos suficientes a favor y en contra
    });
  const otherLists = [...lists.entries()].filter(([name]) => name !== targetName);
  const names = ["top 4 semanas", "top 6 meses", "top 1 año", "nº de ventanas", "afinidad por artista (guardadas)", "afinidad por artista (síes recientes)", "escuchas registradas", "nº de playlists", ...tags.map(([n]) => `en «${n}»`)];
  const d = names.length;
  const X = new Float64Array(keys.length * d);
  const y = new Float64Array(keys.length);
  keys.forEach((k, i) => {
    const r = ranks.map((m) => m.get(k) || 0);
    X.set(
      [...r, r.filter((v) => v > 0).length, affinity(byLiked, liked, k), affinity(byYes, yesSet, k), Math.log1p(plays.get(k) || 0), Math.log1p(otherLists.reduce((n, [, set]) => n + set.has(k), 0)), ...tags.map(([, set]) => (set.has(k) ? 1 : 0))],
      i * d
    );
    y[i] = labels.get(k) === 1 ? 1 : 0;
  });

  const nYes = trainRows.filter((i) => labelOf(i) === 1).length;
  const nNo = trainRows.length - nYes;
  const line = (i, score) => `${score.toFixed(2)} ${tracks.get(keys[i]).id} ${tracks.get(keys[i]).label}`;
  const diverse = (rows, n) => {
    const perArtist = new Map();
    const out = [];
    for (const i of rows) {
      const a = tracks.get(keys[i]).artists[0];
      if ((perArtist.get(a) || 0) >= 2) continue; // como mucho dos por artista: preguntas variadas
      perArtist.set(a, (perArtist.get(a) || 0) + 1);
      out.push(i);
      if (out.length >= n) break;
    }
    return out;
  };
  const open = keys.map((_, i) => i).filter((i) => !members.has(keys[i]) && !labels.has(keys[i]) && !banned.has(keys[i]) && pool.has(keys[i]));
  const head = {
    target: targetName,
    labels: { yes: nYes, no: nNo, from_verdicts: verdicts.length, from_additions_since: `${fromAdditions} (${sinceDate})`, recorded_now: fresh.length },
    ...(pending.length ? { pending_playlists: pending } : {}),
    excluded_by_genre: banned.size,
  };

  if (nYes < 8 || nNo < 8) {
    // Sin ejemplos suficientes de ambos tipos no se entrena: se pregunta por lo que más suena ahora
    const heur = (i) => X[i * d] + X[i * d + 1] + 0.5 * X[i * d + 2] + X[i * d + 5];
    return {
      ...head,
      model: `sin entrenar: hacen falta al menos 8 síes y 8 noes recientes (hay ${nYes} y ${nNo})`,
      ask: diverse(open.slice().sort((a, b) => heur(b) - heur(a)), ask).map((i) => line(i, heur(i))),
    };
  }

  // Validación: pliegues estratificados sobre las decisiones recientes
  const folds = Array.from({ length: Math.min(5, nYes, nNo) }, () => []);
  for (const cls of [1, 0]) seededShuffle(trainRows.filter((i) => labelOf(i) === cls)).forEach((i, n) => folds[n % folds.length].push(i));
  const cv = new Map();
  const opts = { l2: 0.05, iters: 400 };
  for (let f = 0; f < folds.length; f++) {
    const m = fitLogistic(X, y, folds.flatMap((rows, n) => (n === f ? [] : rows)), d, opts);
    for (const i of folds[f]) cv.set(i, m.score(i));
  }
  const hits = trainRows.filter((i) => cv.get(i) >= 0.5 === (labelOf(i) === 1)).length;

  const m = fitLogistic(X, y, trainRows, d, opts);
  const final = keys.map((_, i) => m.score(i));
  const why = (i) => {
    const c = m.contrib(i);
    // Solo señales con peso a favor que la canción tiene: «le favorece tener poco de X» no es un motivo legible
    return c.map((v, j) => [v, j]).filter(([v, j]) => v > 0.05 && m.w[j] > 0 && X[i * d + j] > 0).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, j]) => names[j]).join(", ") || "—";
  };
  const byScore = open.slice().sort((a, b) => final[b] - final[a]);
  const candidates = byScore.slice(0, top);
  const shown = new Set(candidates);
  return {
    ...head,
    validation: {
      method: `${folds.length} pliegues sobre tus decisiones recientes: se esconde una parte y se predice`,
      auc: round(aucOf(trainRows.map((i) => cv.get(i)), trainRows.map((i) => (labelOf(i) === 1 ? 1 : 0)))),
      accuracy: round(hits / trainRows.length),
      baseline_accuracy: round(Math.max(nYes, nNo) / trainRows.length),
    },
    signals: Array.from(m.w, (w, j) => [names[j], round(w)]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 12).map(([n, w]) => `${n} ${w > 0 ? "+" : ""}${w}`),
    candidates: candidates.map((i) => `${line(i, final[i])} | ${why(i)}`),
    // Las dudosas: donde tu respuesta enseña más al modelo
    ask: diverse(open.filter((i) => !shown.has(i)).sort((a, b) => Math.abs(final[a] - 0.5) - Math.abs(final[b] - 0.5)), ask).map((i) => line(i, final[i])),
    // De lo que ya estaba en la lista sin decisión reciente, lo que menos se parece a lo que eliges ahora
    review_in_list: keys.map((_, i) => i).filter((i) => members.has(keys[i]) && !labels.has(keys[i])).sort((a, b) => final[a] - final[b]).slice(0, top).map((i) => line(i, final[i])),
  };
}

// ---------- Servidor MCP ----------
// Algunos clientes envían los booleanos como texto ("true"/"false") cuando aún no conocen el parámetro
const bool = (description) =>
  z.preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean().optional()).describe(description);

// Listas de texto: también se aceptan como JSON o separadas por comas (clientes que aún no conocen el parámetro)
const strings = (description) =>
  z
    .preprocess((v) => {
      if (typeof v !== "string") return v;
      try {
        const parsed = JSON.parse(v);
        if (Array.isArray(parsed)) return parsed;
      } catch {}
      return v.split(",").map((x) => x.trim()).filter(Boolean);
    }, z.array(z.string()).optional())
    .describe(description);

const PAGING = {
  limit: z.number().int().min(1).optional().describe("Máximo de canciones a devolver. Por defecto, todas."),
  offset: z.number().int().min(0).optional().describe("Cuántas saltar desde el principio (para paginar). Por defecto 0."),
  brief: bool("true = una línea por canción («id isrc fecha Artistas — Título»). Recomendado en listas grandes."),
};

const SETS = {
  not_in: z.string().optional().describe('Solo las canciones que NO están en esta otra lista: nombre, id o enlace de una playlist, o "me_gusta". Compara por ISRC.'),
  also_in: z.string().optional().describe('Solo las canciones que TAMBIÉN están en esta otra lista (playlist o "me_gusta"). Compara por ISRC.'),
};
const DUPLICATES = bool("true = solo las grabaciones repetidas (mismo ISRC), agrupadas y con la más antigua primero.");

function buildMcpServer() {
  const server = new McpServer({ name: "spotify-playlists", version: "1.5.0" });

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
      return { content: [{ type: "text", text: JSON.stringify({ total: playlists.length, playlists }) }] };
    }
  );

  server.registerTool(
    "get_playlist_tracks",
    {
      title: "Canciones de una playlist",
      description: "Devuelve las canciones de una playlist, en orden, con título, artistas, álbum, fecha de salida, duración, ISRC (identifica la grabación) y fecha en que se añadió. Con query solo devuelve las que contienen esas palabras en el título, artista o álbum (sin distinguir mayúsculas ni acentos): úsalo en playlists grandes. Con not_in / also_in la cruza con otra lista y matches da el tamaño del resultado (usa limit bajo si solo quieres contar). Acepta el nombre exacto de la playlist, su id o su enlace.",
      inputSchema: {
        playlist: z.string().describe('Nombre exacto (p. ej. "Bible"), id de 22 caracteres o enlace open.spotify.com/playlist/...'),
        query: z.string().optional().describe('Palabras a buscar, p. ej. "oceans hillsong". Opcional.'),
        ...PAGING,
        ...SETS,
        duplicates: DUPLICATES,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ playlist, query, ...opts }) => {
      const data = await getPlaylistTracks(playlist, query, opts);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
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
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
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
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
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
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }
  );

  const json = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

  server.registerTool(
    "get_saved_tracks",
    {
      title: "Canciones de «Me gusta»",
      description: "Devuelve las canciones guardadas en «Me gusta» (de la más reciente a la más antigua), con título, artistas, álbum, fecha de salida, duración, ISRC y fecha en que se guardó. Con query filtra por título, artista o álbum (sin distinguir mayúsculas ni acentos). Suele tener miles de canciones: usa brief y limit/offset.",
      inputSchema: { query: z.string().optional().describe("Palabras a buscar. Opcional."), ...PAGING, ...SETS, duplicates: DUPLICATES },
      annotations: { readOnlyHint: true },
    },
    async ({ query, ...opts }) => json(await getSavedTracks(query, opts))
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
        brief: PAGING.brief,
        ...SETS,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ type, time_range, limit, brief, not_in, also_in }) => json(await getTop(type, time_range, limit, brief, { not_in, also_in }))
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
    "get_play_log",
    {
      title: "Registro acumulado de escuchas",
      description: "Historial de reproducciones que este servidor va guardando (Spotify solo da las últimas 50). Por defecto resume por canción: número de escuchas, días distintos, última vez y desde qué playlist o contexto sonó. Con detail devuelve las reproducciones una a una. El registro empieza el día en que se desplegó esta función.",
      inputSchema: {
        since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Fecha inicial AAAA-MM-DD (UTC). Por defecto, hace 30 días."),
        until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Fecha final AAAA-MM-DD (UTC), incluida. Por defecto, hoy."),
        detail: bool("true = lista cronológica de reproducciones en vez del resumen por canción."),
        limit: z.number().int().min(1).max(2000).optional().describe("Máximo de filas (por defecto 200: las más escuchadas, o las más recientes con detail)."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => json(await getPlayLog(args))
  );

  server.registerTool(
    "find_in_playlists",
    {
      title: "En qué playlists está una canción",
      description: "Para cada canción indica en cuáles de tus playlists propias está, comparando por ISRC (misma grabación aunque cambie el id). Pasa tracks (ids, uris, enlaces o ISRC) y/o playlist para cruzar todas las canciones de una playlist con las demás. Sirve para usar tus playlists como etiquetas de género (p. ej. saber qué es bachata). La primera llamada indexa todas tus playlists y puede tardar; si devuelve pending, repítela.",
      inputSchema: {
        tracks: z.array(z.string()).optional().describe("Ids, uris, enlaces o ISRC de canciones"),
        playlist: z.string().optional().describe("Nombre exacto, id o enlace de una playlist cuyas canciones se quieren cruzar"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => json(await findInPlaylists(args))
  );

  server.registerTool(
    "recommend",
    {
      title: "Recomendaciones para una lista",
      description: "Motor de recomendación guiado por tus decisiones recientes. Aprende SOLO de veredictos fechados (yes/no, que esta misma herramienta guarda) y de lo añadido a la lista desde `since`; lo que ya estaba en la lista no se da por bueno, porque las listas pueden estar anticuadas. Señales: los tres tops, afinidad por artista, escuchas registradas y playlists propias. Devuelve validación sobre esas decisiones, candidatas con motivo, `ask` (las más dudosas: enséñaselas al usuario y registra su respuesta con yes/no en la siguiente llamada) y `review_in_list` (lo de la lista que menos encaja con lo que elige ahora). Es una ayuda para decidir qué preguntar: el gusto lo decide el usuario. No cambia nada en Spotify; solo guarda los veredictos.",
      inputSchema: {
        target: z.string().describe('Lista objetivo: "me_gusta" o el nombre, id o enlace de una playlist (p. ej. "Perfection").'),
        within: z.string().optional().describe('De dónde salen las candidatas cuando target es una playlist. Por defecto "me_gusta". Se ignora si target es me_gusta (ahí se usa todo lo conocido).'),
        exclude: strings('Playlists propias que marcan un género vetado, p. ej. ["Bachata"]. Se excluyen sus canciones, los títulos que las nombran y los artistas con la mayoría de sus canciones en ellas.'),
        since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("AAAA-MM-DD. Lo añadido a la lista desde ese día cuenta como sí reciente. Por defecto, hace un año."),
        yes: strings("Veredictos nuevos a guardar: canciones (ids, uris, enlaces o ISRC) que el usuario SÍ quiere en la lista."),
        no: strings("Veredictos nuevos a guardar: canciones que el usuario NO quiere en la lista."),
        top: z.coerce.number().int().min(1).max(200).optional().describe("Cuántas candidatas y cuántas a revisar (por defecto 30)."),
        ask: z.coerce.number().int().min(0).max(100).optional().describe("Cuántas dudosas proponer para preguntar (por defecto 20)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => json(await recommend(args))
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
      return { content: [{ type: "text", text: JSON.stringify(info) }] };
    }
  );

  return server;
}

// ---------- HTTP ----------
const app = express();
app.use(express.json({ limit: "1mb" }));

const MCP_PATH = `/mcp/${MCP_SECRET}`;

app.post(MCP_PATH, async (req, res) => {
  // Cada uso del conector aprovecha para guardar las últimas escuchas (como mucho cada 10 minutos)
  if (req.body?.method === "tools/call") await logPlays().catch((err) => console.warn("Registro de escuchas:", err.message));
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

// Copia de trabajo para análisis fuera del servidor: «Me gusta», los tres tops, el índice de playlists
// propias y el registro de escuchas, en un solo JSON. ?playlists=A,B añade el detalle (con added_at) de esas playlists.
async function buildSnapshot(detailed = []) {
  // Cada parte se intenta por separado: si Spotify limita una (p. ej. «Me gusta»), el resto se exporta igual
  const errors = {};
  const attempt = (name, fn) => fn().catch((err) => ((errors[name] = err.message), null));
  const [saved, short_term, medium_term, long_term] = await Promise.all([
    attempt("saved", () => getSavedTracks()),
    attempt("top.short_term", () => getTop("tracks", "short_term", 500)),
    attempt("top.medium_term", () => getTop("tracks", "medium_term", 500)),
    attempt("top.long_term", () => getTop("tracks", "long_term", 500)),
  ]);
  const slim = ({ url, ...t }) => t;
  let index = { index: [], pending: [] };
  let plays = [];
  if (hasBlob) {
    index = (await attempt("playlists", () => loadIndex(40_000))) || index;
    await logPlays({ force: true }).catch(() => {});
    const now = new Date().toISOString();
    plays = (await Promise.all(monthsBetween("2026-11", now).map((m) => readJson(playsPath(m))))).flat().filter(Boolean);
  }
  const detail = {};
  for (const name of detailed) {
    const data = await attempt(`detail.${name}`, () => getPlaylistTracks(name));
    if (data) detail[name] = data.tracks.map(slim);
  }
  return {
    generated_at: new Date().toISOString(),
    errors, // partes que no se pudieron leer; su valor queda en null
    saved: saved ? saved.tracks.map(slim) : null,
    top: {
      short_term: short_term ? short_term.items.map(slim) : null,
      medium_term: medium_term ? medium_term.items.map(slim) : null,
      long_term: long_term ? long_term.items.map(slim) : null,
    },
    playlists: index.index, // [{ id, name, tracks: [[id, isrc, "Artistas — Título"], ...] }]
    playlists_pending: index.pending,
    detail,
    plays,
  };
}

app.get(`/export/${MCP_SECRET}`, async (req, res) => {
  try {
    const detailed = String(req.query.playlists || "").split(",").map((x) => x.trim()).filter(Boolean);
    const snapshot = await buildSnapshot(detailed);
    res.setHeader("Content-Disposition", `attachment; filename="spotify-snapshot-${snapshot.generated_at.slice(0, 10)}.json"`);
    res.json(snapshot);
  } catch (err) {
    console.error("Exportación:", err);
    res.status(500).type("text").send(`No se pudo exportar: ${err.message}`);
  }
});

// Tarea programada: guarda las últimas escuchas. No devuelve datos, y logPlays se limita sola a una vez cada 10 minutos.
app.get("/cron/log-plays", async (req, res) => {
  if (CRON_SECRET && req.headers.authorization !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ ok: false });
  try {
    await logPlays();
    res.json({ ok: true });
  } catch (err) {
    console.error("Registro de escuchas:", err);
    res.status(500).json({ ok: false });
  }
});

app.get("/", (_req, res) => res.type("text").send("OK"));

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
    console.log(`URL de callback para Spotify: ${REDIRECT_URI}`);
  });
}

export default app;
