# Spotify Playlists MCP

Servidor MCP remoto **de solo lectura** para que Claude pueda leer tus playlists de Spotify: listar tus playlists y ver todas las canciones de una de ellas. No puede modificar nada.

Herramientas que ofrece:

| Herramienta | Qué hace |
| --- | --- |
| `list_playlists` | Lista tus playlists con id, nombre, propietario y número de canciones |
| `get_playlist_tracks` | Devuelve todas las canciones de una playlist (por nombre, id o enlace) |

## 1. Crear la app de Spotify

1. Entra en <https://developer.spotify.com/dashboard> y pulsa **Create app**.
2. En **Redirect URIs** añade:
   - `http://127.0.0.1:3000/callback` (pruebas en local)
   - `https://TU-SERVICIO.onrender.com/callback` (cuando sepas la URL de Render)
3. Marca **Web API** y guarda.
4. Copia el **Client ID** y el **Client Secret** (en *Settings*).

## 2. Probar en tu ordenador (opcional)

Necesitas Node 18 o superior.

```bash
npm install
cp .env.example .env      # rellena SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET y MCP_SECRET
node --env-file=.env server.js
```

Abre `http://127.0.0.1:3000/login/TU_MCP_SECRET`, acepta en Spotify y copia el **refresh token** que aparece en `SPOTIFY_REFRESH_TOKEN` del `.env`.

## 3. Desplegar en Render

1. Sube esta carpeta a un repositorio **privado** de GitHub (el `.gitignore` ya excluye `.env`).
2. En Render: **New → Blueprint** y elige el repositorio (usa `render.yaml`), o **New → Web Service** con build `npm install` y start `npm start`.
3. Variables de entorno:
   - `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`
   - `MCP_SECRET`: Render puede generarla; si no, usa `openssl rand -hex 32`
   - `PUBLIC_URL`: la URL que te dé Render, p. ej. `https://spotify-mcp-javi.onrender.com`
4. Añade `https://…onrender.com/callback` en las Redirect URIs de tu app de Spotify.
5. Abre `https://…onrender.com/login/TU_MCP_SECRET`, acepta y copia el refresh token en `SPOTIFY_REFRESH_TOKEN`. Render reiniciará el servicio.

> El plan gratuito de Render "duerme" el servicio tras 15 minutos sin uso y la primera petición tarda unos 50 segundos en despertarlo. Si el conector falla por tiempo de espera, reintenta, o usa el plan de pago más barato.

## 4. Conectarlo a Claude

En claude.ai: **Configuración → Conectores → Añadir conector personalizado**.

- **URL**: `https://…onrender.com/mcp/TU_MCP_SECRET`
- **Autenticación**: *Sin inicio de sesión* (la protección es la ruta secreta)

Trata esa URL como una contraseña: quien la tenga puede leer tus playlists.

## Vercel

El código usa Express con un servidor persistente, que es lo que mejor encaja con Render, Railway o Fly.io. En Vercel (funciones serverless) haría falta adaptarlo un poco, y el paso de `/login` puede fallar porque el estado se guarda en memoria. Si prefieres Vercel, haz el `/login` en local para obtener el refresh token y pídeme la versión adaptada.

## Seguridad

- Solo pide los permisos `playlist-read-private` y `playlist-read-collaborative`.
- Nunca subas `.env` ni pegues el Client Secret o el refresh token en chats.
- Si se filtra algo: regenera el Client Secret en Spotify y cambia `MCP_SECRET`.
