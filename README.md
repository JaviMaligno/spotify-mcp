# Spotify Playlists MCP

Servidor MCP remoto **de solo lectura** para que Claude pueda leer tus playlists de Spotify: listar tus playlists y ver todas las canciones de una de ellas. No puede modificar nada.

Herramientas que ofrece:

| Herramienta | Qué hace |
| --- | --- |
| `list_playlists` | Lista tus playlists con id, nombre, propietario y número de canciones |
| `get_playlist_tracks` | Devuelve todas las canciones de una playlist (por nombre, id o enlace) |

| `auth_status` | Indica si hay sesión de Spotify y cuántos días quedan para renovarla |

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

Trata esa URL como una contraseña: quien la tenga puede leer tus playlists.

## Otras opciones

- **En local:** `npm install`, rellena `.env` y ejecuta `node --env-file=.env server.js`.
- **Render u otro servidor Node:** sirve `render.yaml`. Sin Blob, copia el token que muestra `/callback` en `SPOTIFY_REFRESH_TOKEN`. El plan gratuito de Render se duerme tras unos minutos sin uso.

## Seguridad

- Solo pide los permisos `playlist-read-private` y `playlist-read-collaborative`.
- Nunca subas `.env` ni pegues el Client Secret o el refresh token en chats.
- Si se filtra algo: regenera el Client Secret en Spotify y cambia `MCP_SECRET`.
- `MCP_SECRET` debe tener al menos 16 caracteres (recomendado: `openssl rand -hex 24`); el servidor no arranca con uno más corto.
- El enlace de inicio de sesión que muestran las herramientas usa una clave derivada, no `MCP_SECRET`: si acaba en un chat, no sirve para leer tus playlists. Aun así, no lo compartas.
- La URL del conector queda en los registros de peticiones de la plataforma (Vercel, Render): limita quién tiene acceso al proyecto.
