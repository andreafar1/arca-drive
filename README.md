# Arca Drive

Arca Drive è un file manager aziendale self-hosted per Ubuntu, distribuito con Docker Compose.

## Funzioni

- configurazione del primo amministratore;
- accesso tramite email e password;
- creazione di utenti con ruoli amministratore, collaboratore o visualizzatore;
- upload e download persistenti;
- cartelle, ricerca, cestino e ripristino;
- anteprima nel browser di PDF e immagini;
- PostgreSQL per utenti e metadati;
- volume Docker separato per i documenti.

## Requisiti

- Ubuntu Server 22.04 o successivo;
- Docker Engine e Docker Compose v2;
- Git;
- almeno 2 GB di RAM;
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
