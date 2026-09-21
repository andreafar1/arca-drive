# Arca Drive per Android

Client Android nativo per Arca Drive, compatibile con Android 8.0 (API 26) e versioni successive.

## Funzioni

- indirizzo server configurabile;
- login email/password e autenticazione a due fattori;
- token conservati con Android Keystore;
- rinnovo automatico della sessione;
- navigazione e ricerca di file e cartelle;
- raccolta Immagini e cestino;
- creazione cartelle e upload tramite selettore Android;
- apertura dei documenti con le applicazioni installate;
- spostamento di file e cartelle;
- ripristino ed eliminazione definitiva dal cestino.

Sono disponibili due varianti:

- `publicCloud`: accetta esclusivamente URL HTTPS con certificato valido;
- `lan`: accetta HTTPS e HTTP soltanto per indirizzi locali privati (`10.x.x.x`, `172.16-31.x.x`, `192.168.x.x`, localhost e `.local`). Non usare HTTP attraverso Internet, perché password, token e documenti transiterebbero in chiaro.

## Build locale

Installa Android SDK 35, Java 17 e Gradle 8.9, quindi:

```bash
cd android
gradle assemblePublicCloudDebug assembleLanDebug
```

Gli APK saranno disponibili nelle cartelle `app/build/outputs/apk/publicCloud/debug` e `app/build/outputs/apk/lan/debug`.

In alternativa avvia il workflow **Android APK** dalla scheda Actions del repository e scarica l'artefatto prodotto.
