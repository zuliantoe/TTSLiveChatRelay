## TikTok Live Chat Relay (Node.js)

### Menjalankan

1. Salin konfigurasi env:
   - Duplikat `env.example` menjadi `.env` (opsional). Atur `PORT` bila perlu.
2. Install deps dan jalankan dev:

```
npm i
npm run dev
```

Atau build dan start:

```
npm run build
npm start
```

Server default berjalan pada `http://localhost:3001`.

### Endpoint HTTP

- `GET /health` → cek kesehatan.
- `GET /status` → daftar `rooms` yang sedang tersambung.
- `POST /connect` body `{ "uniqueId": "<tiktok_username>" }` → sambung.
- `POST /disconnect` body `{ "uniqueId": "<tiktok_username>" }` → putus.

### Relay (berbasis username di path)

- WebSocket: `ws://localhost:3001/<username>`
- SSE: `GET http://localhost:3001/<username>`

Payload event memiliki bentuk umum:

```json
{
  "type": "chat|gift|like|...",
  "payload": { "..." },
  "timestamp": 1730000000000
}
```

Konsumsi di klien:

```js
// WebSocket
const ws = new WebSocket('ws://localhost:3001/<username>');
ws.onmessage = (m) => console.log(JSON.parse(m.data));

// SSE
const es = new EventSource('http://localhost:3001/<username>');
es.onmessage = (e) => console.log(JSON.parse(e.data));
```

Jika klien pertama membuka `/:username`, server akan mencoba auto-connect ke TikTok untuk username tersebut. Saat klien terakhir pergi (SSE dan WS kosong), server akan auto-disconnect.


