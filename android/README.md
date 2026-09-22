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
- visualizzazione interna di immagini e PDF;
- zoom tramite due dita, doppio tocco e trascinamento;
- scorrimento verticale delle pagine PDF e galleria immagini;
- spostamento di file e cartelle;
- rinomina, copia, taglia e incolla;
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

## Importazione in Android Studio

1. Estrai lo ZIP del progetto in una cartella locale.
2. Avvia Android Studio e scegli **Open**.
3. Seleziona la cartella estratta che contiene `settings.gradle`, non la cartella `app`.
4. Quando richiesto, imposta **Gradle JDK 17** e attendi il completamento di **Gradle Sync**.
5. Se Android Studio propone di installare Android SDK 35, conferma l'installazione.
6. Scegli la variante da **Build > Select Build Variant**:
   - `lanDebug` per server HTTP nella rete privata;
   - `publicCloudDebug` per server HTTPS pubblici.
7. Collega un telefono con debug USB oppure avvia un emulatore e premi **Run**.

Il progetto usa Java e viste Android native. Il punto di ingresso è
`app/src/main/java/it/arcadrive/mobile/MainActivity.java`; il componente touch
per immagini e PDF è `ZoomImageView.java`, mentre le chiamate al server sono in
`ApiClient.java`.

Non inserire password, token o indirizzi privati direttamente nel codice sorgente.
