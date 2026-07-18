# ORI♡N LENTE

Sistema personal de enfoque y gestión creativa con entrada en lenguaje natural, tablero por artista, dictado, modo offline y sincronización opcional con Google Calendar.

## Arquitectura

- **Frontend:** HTML/CSS/JavaScript estático en GitHub Pages.
- **Modo local:** los datos se conservan en `localStorage`; funciona sin cuenta ni conexión.
- **Nube personal:** Cloudflare Worker + D1, protegido por Google OAuth y una lista de un solo correo.
- **Calendario:** cada tarea abierta con fecha crea o actualiza un evento de día completo en Google Calendar; al terminarla o eliminarla, también elimina el evento.
- **OpenAI:** no es necesario. El analizador local sigue funcionando gratis y sin enviar el texto a terceros.

## Archivos importantes

- `index.html`: entrada de GitHub Pages.
- `outputs/maleza-control.html`: interfaz ORI♡N LENTE.
- `outputs/cloud-sync.js`: sincronización web y sesión.
- `config.js`: URL pública del backend.
- `backend/src/index.js`: API, OAuth y Calendar.
- `backend/schema.sql`: base de datos D1.
- `backend/wrangler.toml`: configuración de Cloudflare.

## 1. Publicar el frontend

1. Usa el repositorio público `nadanadaorion/lente`.
2. Sube el contenido de este proyecto a la rama `main`.
3. En GitHub abre **Settings → Pages**.
4. Elige **Deploy from a branch**, rama `main`, carpeta `/ (root)`.
5. La dirección prevista es `https://nadanadaorion.github.io/lente/`.

GitHub Pages no ejecuta el backend: únicamente sirve la interfaz. El Worker mantiene los tokens y datos privados fuera del repositorio.

## 2. Preparar Google Calendar

En Google Cloud Console:

1. Crea un proyecto, por ejemplo `ORI♡N LENTE`.
2. Activa **Google Calendar API**.
3. Configura la pantalla de consentimiento como **External** y agrega tu correo como usuario de prueba.
4. Crea credenciales **OAuth client ID → Web application**.
5. Agrega como URI de redirección autorizada:
   `https://orion-lente-api.TU_SUBDOMINIO.workers.dev/auth/callback`
6. Conserva el Client ID y Client Secret; nunca los agregues al repositorio.

## 3. Crear el backend gratuito

Desde la raíz del proyecto, con una cuenta gratuita de Cloudflare:

```powershell
npx wrangler login
npx wrangler d1 create orion-lente-db
```

Copia el `database_id` recibido en `backend/wrangler.toml`. Sustituye también:

- `WORKER_URL` con tu subdominio real de Workers.
- `ALLOWED_EMAIL` con el único correo Google autorizado.
- `FRONTEND_URL` si el repositorio tiene otro nombre.

Inicializa D1:

```powershell
npx wrangler d1 execute orion-lente-db --remote --file backend/schema.sql
```

Guarda los secretos; Wrangler los solicita sin escribirlos en archivos:

```powershell
npx wrangler secret put GOOGLE_CLIENT_ID --config backend/wrangler.toml
npx wrangler secret put GOOGLE_CLIENT_SECRET --config backend/wrangler.toml
npx wrangler secret put TOKEN_ENCRYPTION_KEY --config backend/wrangler.toml
```

`TOKEN_ENCRYPTION_KEY` puede ser una frase larga aleatoria. El Worker deriva de ella una clave AES-GCM para cifrar el refresh token de Google antes de guardarlo.

Publica el backend:

```powershell
npx wrangler deploy --config backend/wrangler.toml
```

Por último, coloca la URL publicada en `config.js`:

```js
window.ORION_LENTE_CONFIG = {
  apiBase: "https://orion-lente-api.TU_SUBDOMINIO.workers.dev"
};
```

Sube ese cambio a GitHub. Al pulsar **Conectar Google**, la app pedirá acceso a tu cuenta y sincronizará el estado local inicial.

## Seguridad y costos

- El backend rechaza cualquier Google Account distinta de `ALLOWED_EMAIL`.
- Los secretos viven en Cloudflare, nunca en GitHub Pages.
- Las sesiones se guardan como hashes SHA-256 y expiran en 90 días.
- El refresh token de Google se cifra en D1.
- Para uso personal normal, GitHub Pages y los niveles gratuitos de Workers/D1 suelen ser suficientes.
- No hay consumo de OpenAI en esta versión.

## Probar localmente

La interfaz puede abrirse directamente desde `outputs/maleza-control.html`. Para probar la navegación igual que GitHub Pages:

```powershell
python -m http.server 8080
```

Después abre `http://localhost:8080/`. Sin `apiBase`, la app muestra “Modo local · backend pendiente”.
