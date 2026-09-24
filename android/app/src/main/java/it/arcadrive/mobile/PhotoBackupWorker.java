package it.arcadrive.mobile;

import android.content.Context;
import android.content.ContentResolver;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;

import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.BackoffPolicy;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.concurrent.TimeUnit;

public final class PhotoBackupWorker extends Worker {
    static final String SETTINGS = "arca_settings";
    private static final String PERIODIC_NAME = "arca-photo-backup-periodic";
    private static final String MANUAL_NAME = "arca-photo-backup-manual";
    private static final int MAX_FILES_PER_RUN = 25;

    public PhotoBackupWorker(@NonNull Context context, @NonNull WorkerParameters parameters) { super(context, parameters); }

    static void schedule(Context context) {
        SharedPreferences settings = context.getSharedPreferences(SETTINGS, Context.MODE_PRIVATE);
        boolean wifiOnly = settings.getBoolean("backup_wifi_only", true);
        boolean chargingOnly = settings.getBoolean("backup_charging_only", false);
        long frequencyMinutes = Math.max(15, settings.getLong("backup_frequency_minutes", 360));
        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(wifiOnly ? NetworkType.UNMETERED : NetworkType.CONNECTED)
            .setRequiresBatteryNotLow(true)
            .setRequiresCharging(chargingOnly)
            .build();
        PeriodicWorkRequest work = new PeriodicWorkRequest.Builder(PhotoBackupWorker.class, frequencyMinutes, TimeUnit.MINUTES)
            .setBackoffCriteria(BackoffPolicy.LINEAR, 10, TimeUnit.SECONDS)
            .setConstraints(constraints).build();
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC_NAME, ExistingPeriodicWorkPolicy.UPDATE, work);
    }

    static void runNow(Context context) {
        Constraints constraints = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        OneTimeWorkRequest work = new OneTimeWorkRequest.Builder(PhotoBackupWorker.class)
            .setBackoffCriteria(BackoffPolicy.LINEAR, 10, TimeUnit.SECONDS)
            .setConstraints(constraints).build();
        WorkManager.getInstance(context).enqueueUniqueWork(MANUAL_NAME, ExistingWorkPolicy.REPLACE, work);
    }

    static void disable(Context context) {
        WorkManager manager = WorkManager.getInstance(context);
        manager.cancelUniqueWork(PERIODIC_NAME); manager.cancelUniqueWork(MANUAL_NAME);
    }

    @NonNull @Override public Result doWork() {
        Context context = getApplicationContext();
        SharedPreferences settings = context.getSharedPreferences(SETTINGS, Context.MODE_PRIVATE);
        if (!settings.getBoolean("backup_enabled", false)) return Result.success();
        String treeValue = settings.getString("backup_tree_uri", "");
        String server = settings.getString("server", "");
        if (treeValue.isBlank() || server.isBlank()) return finish(settings, "Configurazione backup incompleta", 0, false);
        SecureStore secure = new SecureStore(context);
        if (secure.get("access") == null) return finish(settings, "Accedi ad Arca Drive per continuare il backup", 0, false);
        try {
            ApiClient api = new ApiClient(secure, server, BuildConfig.ALLOW_LOCAL_HTTP);
            boolean nasDestination = "nas".equals(settings.getString("backup_destination", "drive"));
            String destination = nasDestination ? api.ensureNasPhoneBackupFolder() : api.ensurePhoneBackupFolder();
            boolean initial = !settings.getBoolean("backup_initial_complete", false);
            ScanResult scan = scanAndUpload(Uri.parse(treeValue), destination, nasDestination, api, settings);
            SharedPreferences.Editor update = settings.edit().putLong("backup_last_time", System.currentTimeMillis());
            if (initial) {
                if (scan.limitReached) update.putString("backup_last_status", "Backup iniziale in corso: " + scan.completed + " di " + scan.total);
                else update.putBoolean("backup_initial_complete", true)
                    .putString("backup_last_status", "Backup iniziale completato: " + scan.completed + " di " + scan.total);
            } else {
                update.putString("backup_last_status", scan.uploaded == 0 ? "Backup aggiornato: nessun nuovo file" : scan.uploaded + " nuovi file caricati");
            }
            update.apply();
            return scan.limitReached ? Result.retry() : Result.success();
        } catch (SecurityException error) {
            return finish(settings, "Autorizzazione alla cartella non più valida", 0, false);
        } catch (Exception error) {
            settings.edit().putLong("backup_last_time", System.currentTimeMillis())
                .putString("backup_last_status", error.getMessage() == null ? "Backup non riuscito" : error.getMessage()).apply();
            return Result.retry();
        }
    }

    private ScanResult scanAndUpload(Uri treeUri, String destination, boolean nasDestination, ApiClient api, SharedPreferences settings) throws Exception {
        ContentResolver resolver = getApplicationContext().getContentResolver();
        Deque<String> directories = new ArrayDeque<>();
        directories.add(DocumentsContract.getTreeDocumentId(treeUri));
        int uploaded = 0;
        int total = 0;
        int completed = 0;
        boolean pending = false;
        settings.edit().putInt("backup_source_total", 0).putInt("backup_uploaded_total", 0).apply();
        boolean includeVideos = settings.getBoolean("backup_include_videos", false);
        long maximumBytes = settings.getLong("backup_max_bytes", 200L * 1024 * 1024);
        String[] projection = {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED
        };
        while (!directories.isEmpty() && !isStopped()) {
            String parentId = directories.removeFirst();
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentId);
            try (Cursor cursor = resolver.query(children, projection, null, null, null)) {
                if (cursor == null) continue;
                while (cursor.moveToNext() && !isStopped()) {
                    String documentId = cursor.getString(0);
                    String name = cursor.getString(1);
                    String mime = cursor.getString(2);
                    long size = cursor.isNull(3) ? 0 : cursor.getLong(3);
                    long modified = cursor.isNull(4) ? 0 : cursor.getLong(4);
                    if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) { directories.addLast(documentId); continue; }
                    if (mime == null || (!mime.startsWith("image/") && !(includeVideos && mime.startsWith("video/")))) continue;
                    if (maximumBytes > 0 && size > maximumBytes) continue;
                    total++;
                    String key = "uploaded_" + digest(documentId + ':' + size + ':' + modified);
                    if (settings.getBoolean(key, false)) {
                        completed++;
                        settings.edit().putInt("backup_source_total", total).putInt("backup_uploaded_total", completed).apply();
                        continue;
                    }
                    if (uploaded >= MAX_FILES_PER_RUN) {
                        pending = true;
                        settings.edit().putInt("backup_source_total", total).putInt("backup_uploaded_total", completed).apply();
                        continue;
                    }
                    Uri document = DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId);
                    String uploadName = name == null || name.isBlank() ? "media-" + System.currentTimeMillis() : name;
                    if (nasDestination) api.uploadNas(resolver, document, uploadName, mime, destination, sent -> {});
                    else api.upload(resolver, document, uploadName, mime, destination, sent -> {});
                    uploaded++;
                    completed++;
                    settings.edit().putBoolean(key, true)
                        .putInt("backup_source_total", total)
                        .putInt("backup_uploaded_total", completed).apply();
                }
            }
        }
        settings.edit().putInt("backup_source_total", total).putInt("backup_uploaded_total", completed).apply();
        return new ScanResult(uploaded, total, completed, pending || isStopped());
    }

    private static final class ScanResult {
        final int uploaded;
        final int total;
        final int completed;
        final boolean limitReached;
        ScanResult(int uploaded, int total, int completed, boolean limitReached) {
            this.uploaded = uploaded; this.total = total; this.completed = completed; this.limitReached = limitReached;
        }
    }

    private static String digest(String value) throws Exception {
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder result = new StringBuilder();
        for (byte item : hash) result.append(String.format("%02x", item));
        return result.toString();
    }

    private Result finish(SharedPreferences settings, String status, int uploaded, boolean retry) {
        settings.edit().putLong("backup_last_time", System.currentTimeMillis()).putString("backup_last_status", status).apply();
        return retry ? Result.retry() : Result.success();
    }
}
