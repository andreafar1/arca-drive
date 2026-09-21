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

Il client accetta esclusivamente un URL HTTPS con certificato valido, così password, token e documenti non transitano in chiaro.

## Build locale

Installa Android SDK 35, Java 17 e Gradle 8.9, quindi:

```bash
cd android
gradle assembleDebug
```

L'APK sarà disponibile in `app/build/outputs/apk/debug/app-debug.apk`.

In alternativa avvia il workflow **Android APK** dalla scheda Actions del repository e scarica l'artefatto prodotto.
