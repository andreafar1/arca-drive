# Arca Drive

Prototipo navigabile di un file manager aziendale, distribuibile su Ubuntu con Docker Compose.

> Questa versione è un prototipo front-end: i file caricati restano nella memoria del browser e vengono persi ricaricando la pagina. Non è ancora la versione server con database e storage permanente.

## Requisiti

- Ubuntu Server 22.04 o successivo
- Docker Engine
- Docker Compose v2
- Porta 8080 disponibile

## Installazione rapida

```bash
git clone https://github.com/andreafar1/arca-drive.git
cd arca-drive
docker compose up -d
```

Apri `http://IP_DEL_SERVER:8080`.

## Comandi utili

```bash
docker compose ps
docker compose logs -f
docker compose pull
docker compose up -d
docker compose down
```

## Aggiornamento

```bash
git pull
docker compose up -d --build
```

## HTTPS

Per uso in rete pubblica, pubblica il servizio dietro un reverse proxy HTTPS come Caddy, Nginx Proxy Manager o Traefik. Non esporre il prototipo direttamente a Internet.

## Funzioni incluse

- navigazione tra file e cartelle;
- caricamento simulato;
- ricerca;
- anteprima PDF con PDF.js;
- cestino e ripristino;
- area utenti e permessi dimostrativa;
- pannello sincronizzazione desktop dimostrativo.

## Passaggio alla versione server

La versione server richiederà autenticazione reale, PostgreSQL, storage persistente, autorizzazioni lato server, backup e scansione dei file.
