# API mobile Arca Drive

Tutte le rotte protette richiedono:

```http
Authorization: Bearer ACCESS_TOKEN
```

Gli access token durano 15 minuti per impostazione predefinita. I refresh token sono ruotati a ogni rinnovo e devono essere conservati nell'Android Keystore.

## Login

```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "utente@azienda.it",
  "password": "...",
  "deviceName": "Pixel 10",
  "platform": "android"
}
```

La risposta contiene `accessToken`, `refreshToken`, `expiresIn` e `user`.

## Rinnovo

```http
POST /api/auth/refresh
Content-Type: application/json

{ "refreshToken": "..." }
```

Il refresh token precedente diventa immediatamente inutilizzabile.

## Dispositivi

- `GET /api/devices`: sessioni attive.
- `DELETE /api/devices/:id`: revoca una sessione.
- `POST /api/auth/logout`: revoca la sessione corrente.

## Sincronizzazione incrementale

Al primo avvio o dopo la perdita dello stato locale:

```http
GET /api/sync/bootstrap
```

Salva gli elementi ricevuti e il relativo `cursor`.

```http
GET /api/changes?cursor=0&limit=200
```

Conserva `nextCursor` sul dispositivo e usalo nella richiesta successiva. Se `hasMore` è vero, continua finché diventa falso.

## Upload riprendibile

1. Inizializza:

```http
POST /api/uploads
Content-Type: application/json

{
  "name": "documento.pdf",
  "mimeType": "application/pdf",
  "size": 52428800,
  "parentId": null
}
```

La risposta contiene `uploadId`, `offset` e `chunkSize`.

2. Invia un blocco:

```http
PATCH /api/uploads/UPLOAD_ID
Content-Type: application/octet-stream
Upload-Offset: 0

[byte del blocco]
```

La risposta `204` contiene il nuovo header `Upload-Offset`. Quando l'upload è completo contiene anche `Upload-Complete: true` ed `Entry-Id`.

3. Dopo un'interruzione:

```http
GET /api/uploads/UPLOAD_ID
```

Riprendi dal valore `offset`. Le sessioni incomplete scadono dopo 24 ore.

## File e cartelle

- `GET /api/entries`
- `POST /api/folders`
- `GET /api/entries/:id/content`
- `PATCH /api/entries/:id/move`
- `DELETE /api/entries/:id`
- `POST /api/entries/:id/restore`

## Sicurezza di trasporto

Per client mobili usa esclusivamente HTTPS con un certificato attendibile. Dietro un reverse proxy configura `TRUST_PROXY=true` e `REQUIRE_HTTPS=true`.
