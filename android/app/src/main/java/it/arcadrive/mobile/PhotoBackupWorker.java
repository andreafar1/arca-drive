package it.arcadrive.mobile;

import android.content.Context;
import android.content.ContentResolver;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;

import androidx.annotation.NonNull;
import androidx.work.Constraints;
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
            .setConstraints(constraints).build();
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC_NAME, ExistingPeriodicWorkPolicy.UPDATE, work);
    }

    static void runNow(Context context) {
        Constraints constraints = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        OneTimeWorkRequest work = new OneTimeWorkRequest.Builder(PhotoBackupWorker.class).setConstraints(constraints).build();
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
            int uploaded = scanAndUpload(Uri.parse(treeValue), destination, nasDestination, api, settings);
            settings.edit().putLong("backup_last_time", System.currentTimeMillis())
                .putString("backup_last_status", uploaded == 0 ? "Nessuna nuova foto" : uploaded + " nuove foto caricate")
                .apply();
            return uploaded >= MAX_FILES_PER_RUN ? Result.retry() : Result.success();
        } catch (SecurityException error) {
            return finish(settings, "Autorizzazione alla cartella non più valida", 0, false);
        } catch (Exception error) {
            settings.edit().putLong("backup_last_time", System.currentTimeMillis())
                .putString("backup_last_status", error.getMessage() == null ? "Backup non riuscito" : error.getMessage()).apply();
            return Result.retry();
        }
    }

    private int scanAndUpload(Uri treeUri, String destination, boolean nasDestination, ApiClient api, SharedPreferences settings) throws Exception {
        ContentResolver resolver = getApplicationContext().getContentResolver();
        Deque<String> directories = new ArrayDeque<>();
        directories.add(DocumentsContract.getTreeDocumentId(treeUri));
        int uploaded = 0;
        boolean includeVideos = settings.getBoolean("backup_include_videos", false);
        long maximumBytes = settings.getLong("backup_max_bytes", 200L * 1024 * 1024);
        String[] projection = {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED
        };
        while (!directories.isEmpty() && uploaded < MAX_FILES_PER_RUN && !isStopped()) {
            String parentId = directories.removeFirst();
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentId);
            try (Cursor cursor = resolver.query(children, projection, null, null, null)) {
                if (cursor == null) continue;
                while (cursor.moveToNext() && uploaded < MAX_FILES_PER_RUN && !isStopped()) {
                    String documentId = cursor.getString(0);
                    String name = cursor.getString(1);
                    String mime = cursor.getString(2);
                    long size = cursor.isNull(3) ? 0 : cursor.getLong(3);
                    long modified = cursor.isNull(4) ? 0 : cursor.getLong(4);
                    if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) { directories.addLast(documentId); continue; }
                    if (mime == null || (!mime.startsWith("image/") && !(includeVideos && mime.startsWith("video/")))) continue;
                    if (maximumBytes > 0 && size > maximumBytes) continue;
                    String key = "uploaded_" + digest(documentId + ':' + size + ':' + modified);
                    if (settings.getBoolean(key, false)) continue;
                    Uri document = DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId);
                    String uploadName = name == null || name.isBlank() ? "media-" + System.currentTimeMillis() : name;
                    if (nasDestination) api.uploadNas(resolver, document, uploadName, mime, destination, sent -> {});
                    else api.upload(resolver, document, uploadName, mime, destination, sent -> {});
                    settings.edit().putBoolean(key, true).apply();
                    uploaded++;
                }
            }
        }
        return uploaded;
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
