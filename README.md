# Spotify Playlists MCP

Servidor MCP remoto para que Claude gestione tus playlists de Spotify y tu lista «Me gusta», y consulte qué escuchas más.

Herramientas: ver la sección [Herramientas](#herramientas) al final.

> Spotify obliga a volver a iniciar sesión cada 6 meses. Cuando caduca, las herramientas devuelven un mensaje con el enlace de `/login`. Con Vercel Blob el token nuevo se guarda solo: basta con abrir el enlace y pulsar «Aceptar».

## 1. Crear la app de Spotify

1. Entra en <https://developer.spotify.com/dashboard> y pulsa **Create app** (la cuenta dueña de la app necesita Premium).
2. En **Redirect URIs** añade `https://TU-PROYECTO.vercel.app/callback` (y `http://127.0.0.1:3000/callback` para pruebas en local).
3. Marca **Web API** y guarda. Copia el **Client ID** y el **Client Secret**.

## 2. Desplegar en Vercel (recomendado)

1. Importa el repositorio en Vercel. `server.js` exporta la app de Express y Vercel la detecta sin configuración.
2. En **Storage**, crea un almacén **Blob privado** y conéctalo al proyecto (crea `BLOB_STORE_ID`; los almacenes antiguos usan `BLOB_READ_WRITE_TOKEN`). Vuelve a desplegar después de conectarlo.
3. Variables de entorno: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `MCP_SECRET` (`openssl rand -hex 24`). `PUBLIC_URL` es opcional: por defecto usa el dominio de producción.
4. Vuelve a desplegar y abre `https://TU-PROYECTO.vercel.app/login/TU_MCP_SECRET`. El token se guarda solo.

## 3. Conectarlo a Claude

En claude.ai: **Configuración → Conectores → Añadir conector personalizado**.

- **URL**: `https://TU-PROYECTO.vercel.app/mcp/TU_MCP_SECRET`
- **Autenticación**: *Sin inicio de sesión* (la protección es la ruta secreta)

Trata esa URL como una contraseña: quien la tenga puede leer y modificar tus playlists y «Me gusta».

## Otras opciones

- **En local:** `npm install`, rellena `.env` y ejecuta `node --env-file=.env server.js`.
- **Render u otro servidor Node:** sirve `render.yaml`. Sin Blob, copia el token que muestra `/callback` en `SPOTIFY_REFRESH_TOKEN`. El plan gratuito de Render se duerme tras unos minutos sin uso.

## Seguridad

- Pide los permisos de playlists (`playlist-read-private`, `playlist-read-collaborative`, `playlist-modify-public`, `playlist-modify-private`), de «Me gusta» (`user-library-read`, `user-library-modify`) y de actividad (`user-top-read`, `user-read-recently-played`). Al añadir permisos nuevos hay que volver a abrir `/login/TU_MCP_SECRET`.
- Nunca subas `.env` ni pegues el Client Secret o el refresh token en chats.
- Si se filtra algo: regenera el Client Secret en Spotify y cambia `MCP_SECRET`.


## Herramientas

| Herramienta | Qué hace |
| --- | --- |
| `list_playlists` | Lista tus playlists. |
| `get_playlist_tracks` | Canciones de una playlist, con ISRC, duración y fecha en que se añadieron. `query` opcional para filtrar. |
| `search_tracks` | Busca canciones en el catálogo de Spotify. |
| `add_tracks` | Añade canciones a una playlist propia, al final o en la posición `position`. |
| `remove_tracks` | Quita canciones de una playlist propia (todas las apariciones). |
| `get_saved_tracks` | Canciones de «Me gusta». `query` opcional para filtrar. |
| `save_tracks` / `unsave_tracks` | Añade o quita canciones de «Me gusta» (usa `/me/library`, la API de febrero de 2026). |
| `get_top_items` | Ranking de canciones o artistas más escuchados en ~4 semanas, ~6 meses o ~1 año. |
| `get_recently_played` | Tus últimas 50 reproducciones. |
| `auth_status` | Estado de la sesión y enlace para volver a iniciarla. |
