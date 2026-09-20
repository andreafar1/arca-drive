# Arca Drive

Arca Drive è un file manager aziendale self-hosted per Ubuntu, distribuito con Docker Compose.

## Funzioni

- configurazione del primo amministratore;
- accesso tramite email e password;
- creazione di utenti con ruoli amministratore, collaboratore o visualizzatore;
- upload e download persistenti;
- cartelle, ricerca, cestino e ripristino;
- anteprima nel browser di PDF e immagini;
- modifica nel browser di documenti Word, Excel, PowerPoint e OpenDocument tramite Collabora CODE;
- PostgreSQL per utenti e metadati;
- volume Docker separato per i documenti.
- sessioni per dispositivo con refresh token ruotati e revocabili;
- sincronizzazione incrementale tramite cursore;
- upload riprendibile per client mobili e file grandi.

## Requisiti

- Ubuntu Server 22.04 o successivo;
- Docker Engine e Docker Compose v2;
- Git;
- almeno 4 GB di RAM, consigliati 8 GB con Collabora CODE;
- spazio disco adeguato ai documenti.

## Installazione

```bash
git clone https://github.com/andreafar1/arca-drive.git
cd arca-drive
cp .env.example .env
```

Genera due valori casuali:

```bash
openssl rand -base64 36
openssl rand -base64 48
```

Inserisci il primo come `POSTGRES_PASSWORD` e il secondo come `JWT_SECRET` nel file `.env`:

```bash
nano .env
```

Avvia l'applicazione:

```bash
docker compose up -d --build
docker compose ps
```

Apri `http://IP_DEL_SERVER:8080`. Al primo accesso verrà richiesto di creare l'amministratore iniziale.

Collabora CODE è disponibile sulla porta `9980`. Se accedi ad Arca Drive tramite l'indirizzo IP e le porte predefinite non servono altre impostazioni. Se usi un dominio o un reverse proxy, imposta nel file `.env` l'indirizzo pubblico di Collabora, per esempio:

```env
COLLABORA_PUBLIC_URL=https://office.example.it
```

Il reverse proxy deve inoltrare anche le connessioni WebSocket di Collabora. Arca Drive comunica internamente con CODE e protegge i file tramite token WOPI temporanei. CODE è l'edizione di sviluppo gratuita di Collabora, indicata per test, uso domestico e startup; per un ambiente aziendale di produzione valuta Collabora Online Business.

## Aggiornamento

```bash
git pull
docker compose up -d --build
```

## Backup

Backup del database:

```bash
docker compose exec -T db pg_dump -U arca_drive -d arca_drive | gzip > arca-drive-db-$(date +%F).sql.gz
```

Backup dei documenti:

```bash
docker run --rm -v arca-drive_file_data:/data -v "$PWD":/backup alpine +  tar czf /backup/arca-drive-files-$(date +%F).tar.gz -C /data .
```

Conserva i backup su un disco o sistema diverso dal server.

## Ripristino

Il ripristino deve includere sia PostgreSQL sia il volume `file_data`. I soli metadati o i soli documenti non costituiscono un backup completo.

## Sicurezza

- non pubblicare il file `.env`;
- usa HTTPS tramite un reverse proxy;
- non esporre la porta PostgreSQL;
- aggiorna regolarmente immagini e sistema operativo;
- pianifica backup automatici;
- questa prima versione non include ancora antivirus, versionamento dei file o recupero password via email.

## Client mobili

Le API per Android sono documentate in [docs/mobile-api.md](docs/mobile-api.md). Prima di collegare dispositivi esterni, configura un reverse proxy HTTPS e imposta:

```env
TRUST_PROXY=true
REQUIRE_HTTPS=true
```
