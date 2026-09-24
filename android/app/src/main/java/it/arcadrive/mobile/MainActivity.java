package it.arcadrive.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.ProgressDialog;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.ColorFilter;
import android.graphics.PixelFormat;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.InsetDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.graphics.pdf.PdfRenderer;
import android.provider.OpenableColumns;
import android.provider.DocumentsContract;
import android.text.InputType;
import android.text.Editable;
import android.text.TextWatcher;
import android.util.LruCache;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ArrayAdapter;
import android.widget.AbsListView;
import android.widget.BaseAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.ImageView;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.FileProvider;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import org.json.JSONObject;
import org.json.JSONArray;

import java.io.File;
import java.io.InputStream;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Date;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import java.util.Locale;
import java.text.SimpleDateFormat;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final int PICK_FILE = 40;
    private static final int PICK_BACKGROUND = 41;
    private static final int PICK_BACKUP_FOLDER = 42;
    private static final int NAVY = Color.rgb(16, 26, 48);
    private static final int MINT = Color.rgb(49, 199, 163);
    private static final int PAGE = Color.rgb(246, 248, 251);
    private static final int LINE = Color.rgb(224, 229, 237);
    private final Typeface regular = Typeface.create("sans-serif", Typeface.NORMAL);
    private final Typeface medium = Typeface.create("sans-serif-medium", Typeface.NORMAL);
    private final Typeface bold = Typeface.create("sans-serif", Typeface.BOLD);
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final ExecutorService pdfIo = Executors.newSingleThreadExecutor();
    private final ExecutorService thumbnailIo = Executors.newFixedThreadPool(3);
    private final Handler uiHandler = new Handler(Looper.getMainLooper());
    private Runnable pendingSearch;
    private Runnable backupProgressUpdater;
    private final Object pdfLock = new Object();
    private final LruCache<Integer, Bitmap> pdfPageCache = new LruCache<Integer, Bitmap>(48 * 1024 * 1024) {
        @Override protected int sizeOf(Integer key, Bitmap bitmap) { return bitmap.getAllocationByteCount(); }
    };
    private final Set<Integer> pdfRendering = Collections.synchronizedSet(new HashSet<>());
    private final Deque<Entry> folderStack = new ArrayDeque<>();
    private SecureStore secure;
    private ApiClient api;
    private String server;
    private String view = "files";
    private Entry currentFolder;
    private List<Entry> currentEntries = new ArrayList<>();
    private TextView title;
    private EditText search;
    private ListView list;
    private Button back;
    private Button navFiles;
    private Button navImages;
    private Button navTrash;
    private Button drawerNavFiles;
    private Button drawerNavImages;
    private Button drawerNavNas;
    private Button drawerNavTrash;
    private ProgressDialog progress;
    private boolean internalViewer;
    private PdfRenderer activePdfRenderer;
    private ParcelFileDescriptor activePdfDescriptor;
    private final List<Float> activePdfRatios = new ArrayList<>();
    private int pdfRenderGeneration;
    private List<Entry> galleryEntries = new ArrayList<>();
    private int galleryIndex;
    private int galleryRequestId;
    private FrameLayout drawerOverlay;
    private LinearLayout uploadHistoryContainer;
    private boolean drawerOpen;
    private Entry clipboardEntry;
    private boolean clipboardCut;
    private Button pasteButton;
    private boolean backupSettingsOpen;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        secure = new SecureStore(this);
        server = getSharedPreferences(PhotoBackupWorker.SETTINGS, MODE_PRIVATE).getString("server", getPreferences(MODE_PRIVATE).getString("server", ""));
        if (!server.isBlank()) getSharedPreferences(PhotoBackupWorker.SETTINGS, MODE_PRIVATE).edit().putString("server", server).apply();
        api = new ApiClient(secure, server, BuildConfig.ALLOW_LOCAL_HTTP);
        if (getSharedPreferences(PhotoBackupWorker.SETTINGS, MODE_PRIVATE).getBoolean("backup_enabled", false)) PhotoBackupWorker.schedule(this);
        if (server.isBlank()) showServerSetup();
        else if (secure.get("access") == null) showLogin();
        else validateSession();
    }

    private void showServerSetup() {
        LinearLayout page = page();
        page.addView(brand("Collega il tuo cloud"));
        TextView intro = text("Inserisci l’indirizzo completo del server Arca Drive.", 16);
        intro.setPadding(0, dp(12), 0, dp(20)); page.addView(intro);
        EditText url = input("https://drive.azienda.it", InputType.TYPE_TEXT_VARIATION_URI);
        url.setText(server); page.addView(url, matchWrap());
        TextView warning = text(BuildConfig.ALLOW_LOCAL_HTTP
            ? "Questa variante consente HTTP solo nella rete locale. Per Internet utilizza sempre HTTPS."
            : "Il client accetta esclusivamente server HTTPS con un certificato valido.", 13);
        warning.setTextColor(Color.rgb(170, 75, 30)); warning.setPadding(0, dp(10), 0, dp(16)); page.addView(warning);
        Button connect = primary("Continua"); page.addView(connect, matchWrap());
        connect.setOnClickListener(v -> {
            String candidate = url.getText().toString().trim().replaceAll("/+$", "");
            boolean allowed = candidate.matches("https://.+") || (BuildConfig.ALLOW_LOCAL_HTTP && ApiClient.isLocalHttp(candidate));
            if (!allowed) { toast(BuildConfig.ALLOW_LOCAL_HTTP ? "Usa HTTPS oppure un IP HTTP della rete locale" : "Inserisci un indirizzo https:// valido"); return; }
            server = candidate;
            getPreferences(MODE_PRIVATE).edit().putString("server", server).apply();
            getSharedPreferences(PhotoBackupWorker.SETTINGS, MODE_PRIVATE).edit().putString("server", server).apply();
            api.setBaseUrl(server);
            showLogin();
        });
        setContentView(page);
    }

    private void showLogin() {
        LinearLayout page = page();
        page.addView(brand("Accedi ad Arca Drive"));
        TextView host = text(server, 13); host.setTextColor(Color.GRAY); host.setPadding(0, dp(8), 0, dp(18)); page.addView(host);
        EditText email = input("Email", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        EditText password = input("Password", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        page.addView(email, matchWrap()); page.addView(password, spaced());
        Button login = primary("Accedi"); page.addView(login, matchWrap());
        Button change = secondary("Cambia server"); page.addView(change, spaced());
        change.setOnClickListener(v -> showServerSetup());
        login.setOnClickListener(v -> {
            if (email.getText().toString().isBlank() || password.getText().toString().isBlank()) { toast("Inserisci email e password"); return; }
            busy("Accesso…");
            async(() -> api.login(email.getText().toString(), password.getText().toString()), result -> {
                stopBusy();
                try {
                    JSONObject json = result.object();
                    if (json.optBoolean("requiresTwoFactor")) showTwoFactor(json.optString("challengeToken"));
                    else { api.saveSession(json); showDrive(); }
                } catch (Exception error) { fail(error); }
            });
        });
        setContentView(page);
    }

    private void showTwoFactor(String challenge) {
        LinearLayout page = page();
        page.addView(brand("Verifica in due passaggi"));
        TextView info = text("Inserisci il codice dell’app Authenticator oppure un codice di recupero.", 15);
        info.setPadding(0, dp(12), 0, dp(18)); page.addView(info);
        EditText code = input("Codice di verifica", InputType.TYPE_CLASS_TEXT); page.addView(code, matchWrap());
        Button verify = primary("Verifica e accedi"); page.addView(verify, spaced());
        Button cancel = secondary("Annulla"); page.addView(cancel, spaced());
        cancel.setOnClickListener(v -> showLogin());
        verify.setOnClickListener(v -> {
            busy("Verifica…");
            async(() -> api.verify2fa(challenge, code.getText().toString()), result -> {
                stopBusy();
                try { api.saveSession(result.object()); showDrive(); } catch (Exception error) { fail(error); }
            });
        });
        setContentView(page); code.requestFocus();
    }

    private void validateSession() {
        busy("Connessione…");
        async(() -> api.me(), me -> { stopBusy(); showDrive(); });
    }

    private void showDrive() {
        backupSettingsOpen = false;
        closeInternalViewer();
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); applyAppBackground(root);
        LinearLayout header = new LinearLayout(this); header.setGravity(Gravity.CENTER_VERTICAL); header.setPadding(dp(12), dp(10), dp(12), dp(10)); header.setBackgroundColor(NAVY);
        back = smallButton(currentFolder == null ? "☰" : "←"); header.addView(back, new LinearLayout.LayoutParams(dp(48), dp(48)));
        title = text("I miei file", 20); title.setTypeface(medium); title.setGravity(Gravity.CENTER_VERTICAL); title.setSingleLine(); title.setTextColor(Color.WHITE); header.addView(title, new LinearLayout.LayoutParams(0, dp(48), 1));
        Button add = smallButton("＋"); header.addView(add, new LinearLayout.LayoutParams(dp(48), dp(48)));
        pasteButton = smallButton("⎘"); pasteButton.setContentDescription("Incolla"); pasteButton.setVisibility(clipboardEntry == null ? View.GONE : View.VISIBLE); header.addView(pasteButton, new LinearLayout.LayoutParams(dp(48), dp(48)));
        Button more = smallButton("⋮"); header.addView(more, new LinearLayout.LayoutParams(dp(48), dp(48)));
        root.addView(header);

        search = input("⌕  Cerca file e cartelle", InputType.TYPE_CLASS_TEXT); search.setSingleLine();
        search.setBackground(rounded(Color.WHITE, LINE, 14));
        LinearLayout searchRow = new LinearLayout(this); searchRow.setGravity(Gravity.CENTER_VERTICAL); searchRow.setPadding(dp(16), dp(16), dp(16), dp(8)); searchRow.addView(search, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48))); root.addView(searchRow);

        list = new ListView(this); list.setDivider(new android.graphics.drawable.ColorDrawable(LINE)); list.setDividerHeight(dp(1)); list.setPadding(dp(16), dp(4), dp(16), dp(6)); list.setClipToPadding(false); list.setBackgroundColor(Color.TRANSPARENT); root.addView(list, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        LinearLayout nav = new LinearLayout(this); nav.setGravity(Gravity.CENTER); nav.setPadding(dp(10), dp(8), dp(10), dp(8)); nav.setBackgroundColor(Color.WHITE); nav.setElevation(dp(3));
        navFiles = navButton("▦  File"); navImages = navButton("▧  Immagini"); navTrash = navButton("♲  Cestino");
        nav.addView(navFiles, weighted()); nav.addView(navImages, weighted()); nav.addView(navTrash, weighted()); root.addView(nav);
        FrameLayout shell = new FrameLayout(this); shell.addView(root, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        buildDrawer(shell); setContentView(shell);
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars());
            header.setPadding(dp(12), bars.top + dp(8), dp(12), dp(8));
            nav.setPadding(dp(10), dp(8), dp(10), bars.bottom + dp(8));
            return windowInsets;
        });

        back.setOnClickListener(v -> { if (currentFolder == null) openDrawer(); else goBack(); });
        add.setOnClickListener(v -> addMenu());
        pasteButton.setOnClickListener(v -> pasteClipboard());
        more.setOnClickListener(v -> accountMenu());
        search.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence value, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence value, int start, int before, int count) {
                if (!search.hasFocus()) return;
                if (pendingSearch != null) uiHandler.removeCallbacks(pendingSearch);
                pendingSearch = () -> loadEntries(); uiHandler.postDelayed(pendingSearch, 350);
            }
            @Override public void afterTextChanged(Editable value) {}
        });
        navFiles.setOnClickListener(v -> switchView("files")); navImages.setOnClickListener(v -> switchView("images")); navTrash.setOnClickListener(v -> switchView("trash"));
        list.setOnItemClickListener((parent, row, position, id) -> openEntry(currentEntries.get(position)));
        list.setOnItemLongClickListener((parent, row, position, id) -> { entryMenu(currentEntries.get(position)); return true; });
        updateNavState();
        loadEntries();
    }

    private void buildDrawer(FrameLayout shell) {
        drawerOverlay = new FrameLayout(this); drawerOverlay.setBackgroundColor(Color.argb(135, 5, 12, 24)); drawerOverlay.setVisibility(View.GONE); drawerOverlay.setOnClickListener(v -> closeDrawer());
        LinearLayout panel = new LinearLayout(this); panel.setOrientation(LinearLayout.VERTICAL); panel.setPadding(dp(18), dp(18), dp(18), dp(18)); panel.setBackgroundColor(NAVY); panel.setOnClickListener(v -> {});
        FrameLayout.LayoutParams panelParams = new FrameLayout.LayoutParams(dp(310), ViewGroup.LayoutParams.MATCH_PARENT, Gravity.START); drawerOverlay.addView(panel, panelParams);

        LinearLayout brandRow = new LinearLayout(this); brandRow.setGravity(Gravity.CENTER_VERTICAL); brandRow.setPadding(dp(8), 0, 0, dp(18));
        TextView logo = text("A", 20); logo.setTypeface(bold); logo.setGravity(Gravity.CENTER); logo.setTextColor(NAVY); logo.setBackground(rounded(MINT, Color.TRANSPARENT, 10)); brandRow.addView(logo, new LinearLayout.LayoutParams(dp(42), dp(42)));
        TextView brandName = text("Arca Drive", 21); brandName.setTypeface(bold); brandName.setTextColor(Color.WHITE); brandName.setPadding(dp(12), 0, 0, 0); brandRow.addView(brandName); panel.addView(brandRow);

        Button uploadButton = primary("＋  Carica file"); panel.addView(uploadButton, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52))); uploadButton.setOnClickListener(v -> { closeDrawer(); chooseFile(); });
        TextView categoryLabel = drawerLabel("CATEGORIE"); categoryLabel.setPadding(dp(8), dp(24), 0, dp(8)); panel.addView(categoryLabel);
        drawerNavFiles = drawerButton("▦   I miei file"); drawerNavImages = drawerButton("▧   Immagini"); drawerNavNas = drawerButton("▰   NAS"); drawerNavTrash = drawerButton("♲   Cestino");
        panel.addView(drawerNavFiles, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52))); panel.addView(drawerNavImages, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52))); panel.addView(drawerNavNas, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52))); panel.addView(drawerNavTrash, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52)));
        drawerNavFiles.setOnClickListener(v -> { closeDrawer(); switchView("files"); }); drawerNavImages.setOnClickListener(v -> { closeDrawer(); switchView("images"); }); drawerNavNas.setOnClickListener(v -> { closeDrawer(); switchView("nas"); }); drawerNavTrash.setOnClickListener(v -> { closeDrawer(); switchView("trash"); });

        TextView historyLabel = drawerLabel("CRONOLOGIA CARICAMENTI"); historyLabel.setPadding(dp(8), dp(24), 0, dp(8)); panel.addView(historyLabel);
        ScrollView historyScroll = new ScrollView(this); uploadHistoryContainer = new LinearLayout(this); uploadHistoryContainer.setOrientation(LinearLayout.VERTICAL); historyScroll.addView(uploadHistoryContainer); panel.addView(historyScroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        renderUploadHistory(); shell.addView(drawerOverlay, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        ViewCompat.setOnApplyWindowInsetsListener(panel, (view, insets) -> { Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars()); panel.setPadding(dp(18), bars.top + dp(16), dp(18), bars.bottom + dp(16)); return insets; });
    }

    private TextView drawerLabel(String value) { TextView label = text(value, 11); label.setTypeface(bold); label.setTextColor(Color.rgb(126, 142, 169)); label.setLetterSpacing(.08f); return label; }

    private Button drawerButton(String label) { Button button = new Button(this); button.setText(label); button.setAllCaps(false); button.setTextSize(16); button.setTypeface(regular); button.setTextColor(Color.rgb(183, 193, 211)); button.setGravity(Gravity.START | Gravity.CENTER_VERTICAL); button.setPadding(dp(14), 0, dp(14), 0); button.setBackground(rounded(Color.TRANSPARENT, Color.TRANSPARENT, 10)); return button; }

    private void openDrawer() { if (drawerOverlay == null) return; drawerOpen = true; renderUploadHistory(); updateNavState(); drawerOverlay.setAlpha(0f); drawerOverlay.setVisibility(View.VISIBLE); drawerOverlay.animate().alpha(1f).setDuration(160).start(); }
    private void closeDrawer() { if (drawerOverlay == null) return; drawerOpen = false; drawerOverlay.setVisibility(View.GONE); }

    private void recordUpload(String name) {
        try {
            JSONArray history = new JSONArray(getPreferences(MODE_PRIVATE).getString("upload_history", "[]"));
            JSONArray next = new JSONArray(); next.put(new JSONObject().put("name", name).put("time", System.currentTimeMillis()));
            for (int i = 0; i < Math.min(history.length(), 19); i++) next.put(history.getJSONObject(i));
            getPreferences(MODE_PRIVATE).edit().putString("upload_history", next.toString()).apply(); renderUploadHistory();
        } catch (Exception ignored) {}
    }

    private void renderUploadHistory() {
        if (uploadHistoryContainer == null) return; uploadHistoryContainer.removeAllViews();
        try {
            JSONArray history = new JSONArray(getPreferences(MODE_PRIVATE).getString("upload_history", "[]"));
            if (history.length() == 0) { TextView empty = text("Nessun caricamento dal telefono", 13); empty.setTextColor(Color.rgb(126, 142, 169)); empty.setPadding(dp(8), dp(8), dp(8), 0); uploadHistoryContainer.addView(empty); return; }
            SimpleDateFormat format = new SimpleDateFormat("dd MMM · HH:mm", Locale.ITALIAN);
            for (int i = 0; i < Math.min(history.length(), 8); i++) {
                JSONObject item = history.getJSONObject(i); LinearLayout row = new LinearLayout(this); row.setOrientation(LinearLayout.VERTICAL); row.setPadding(dp(10), dp(9), dp(10), dp(9));
                TextView name = text("↑  " + item.optString("name"), 13); name.setTypeface(medium); name.setTextColor(Color.WHITE); name.setSingleLine(); name.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE); row.addView(name);
                TextView time = text(format.format(new Date(item.optLong("time"))), 11); time.setTextColor(Color.rgb(126, 142, 169)); time.setPadding(dp(21), dp(3), 0, 0); row.addView(time); uploadHistoryContainer.addView(row);
            }
        } catch (Exception ignored) {}
    }

    private void loadEntries() {
        busy("Caricamento…");
        String parentId = currentFolder == null ? null : currentFolder.id;
        async(() -> api.entries(parentId, view, search == null ? "" : search.getText().toString()), entries -> {
            stopBusy(); currentEntries = entries;
            list.setAdapter(new ArrayAdapter<Entry>(this, android.R.layout.simple_list_item_2, android.R.id.text1, entries) {
                @Override public View getView(int position, View convert, ViewGroup parent) {
                    Entry entry = getItem(position);
                    LinearLayout row = new LinearLayout(MainActivity.this); row.setOrientation(LinearLayout.HORIZONTAL); row.setGravity(Gravity.CENTER_VERTICAL); row.setPadding(dp(2), dp(11), dp(2), dp(11)); row.setMinimumHeight(dp(70));
                    row.setBackgroundColor(Color.TRANSPARENT);
                    View badge = entry.mime.startsWith("image/") ? thumbnailBadge(entry) : new FileBadgeView(entry);
                    badge.setElevation(dp(1)); row.addView(badge, new LinearLayout.LayoutParams(dp(48), dp(48)));
                    LinearLayout labels = new LinearLayout(MainActivity.this); labels.setOrientation(LinearLayout.VERTICAL); labels.setPadding(dp(13), 0, 0, 0);
                    TextView name = text(entry.name, 15); name.setTypeface(medium); name.setMaxLines(2); labels.addView(name);
                    String detailText = entry.folder() ? "Cartella" : formatSize(entry.size);
                    if (entry.mime.startsWith("image/") && !entry.displayDate.isBlank()) detailText += "  ·  " + formatEntryDate(entry.displayDate);
                    TextView detail = text(detailText, 13); detail.setTextColor(Color.rgb(112, 124, 143)); detail.setPadding(0, dp(3), 0, 0); labels.addView(detail);
                    row.addView(labels, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
                    Button actions = new Button(MainActivity.this); actions.setText("⋮"); actions.setTextSize(21); actions.setTextColor(Color.rgb(91, 104, 125)); actions.setMinWidth(0); actions.setMinimumWidth(0); actions.setPadding(0, 0, 0, 0); actions.setBackground(rounded(Color.TRANSPARENT, Color.TRANSPARENT, 10)); actions.setContentDescription("Azioni per " + entry.name); actions.setOnClickListener(v -> entryMenu(entry));
                    row.addView(actions, new LinearLayout.LayoutParams(dp(42), dp(42)));
                    row.setClickable(true);
                    row.setOnClickListener(v -> openEntry(entry));
                    row.setOnLongClickListener(v -> { entryMenu(entry); return true; });
                    return row;
                }
            });
        });
    }

    private void openEntry(Entry entry) {
        if (entry.folder()) {
            if (currentFolder != null) folderStack.push(currentFolder);
            currentFolder = entry; title.setText(entry.name); back.setText("←"); search.setText(""); loadEntries();
        } else preview(entry);
    }

    private View thumbnailBadge(Entry entry) {
        FrameLayout holder = new FrameLayout(this);
        FileBadgeView placeholder = new FileBadgeView(entry); holder.addView(placeholder, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        ImageView thumbnail = new ImageView(this); thumbnail.setScaleType(ImageView.ScaleType.CENTER_CROP); thumbnail.setBackground(rounded(Color.rgb(238, 234, 255), Color.TRANSPARENT, 11)); thumbnail.setClipToOutline(true); thumbnail.setVisibility(View.INVISIBLE); thumbnail.setContentDescription("Miniatura " + entry.name);
        holder.addView(thumbnail, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        String cacheKey = Integer.toHexString((entry.id + ":" + entry.updatedAt).hashCode()); thumbnail.setTag(cacheKey);
        File directory = new File(getCacheDir(), "thumbnails"); directory.mkdirs(); File cached = new File(directory, cacheKey + ".webp");
        thumbnailIo.execute(() -> {
            File temporary = new File(directory, cacheKey + "-" + System.nanoTime() + ".part");
            try {
                if (!cached.isFile()) {
                    api.downloadThumbnail(entry, temporary);
                    if (!cached.isFile() && !temporary.renameTo(cached)) throw new Exception("Cache miniatura non disponibile");
                    temporary.delete();
                }
                Bitmap bitmap = decodeSampled(cached, dp(192));
                runOnUiThread(() -> {
                    if (cacheKey.equals(thumbnail.getTag()) && bitmap != null) { thumbnail.setImageBitmap(bitmap); thumbnail.setVisibility(View.VISIBLE); }
                });
            } catch (Exception ignored) { temporary.delete(); }
        });
        return holder;
    }

    private void preview(Entry entry) {
        busy("Apertura…");
        async(() -> {
            File directory = new File(getCacheDir(), "previews"); directory.mkdirs();
            String safe = entry.name.replaceAll("[^A-Za-z0-9._ -]", "_");
            return entry.nas ? api.downloadNas(entry.id, new File(directory, safe)) : api.download(entry.id, new File(directory, safe));
        }, file -> {
            stopBusy();
            if (entry.mime.contains("pdf")) {
                showPdf(file, entry);
            } else if (entry.mime.startsWith("image/")) {
                galleryEntries = new ArrayList<>();
                for (Entry item : currentEntries) if (!item.folder() && item.mime.startsWith("image/")) galleryEntries.add(item);
                galleryIndex = Math.max(0, galleryEntries.indexOf(entry));
                showImageGallery();
            } else try {
                Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".files", file);
                Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, entry.mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivity(Intent.createChooser(intent, "Apri con"));
            } catch (Exception error) { toast("Nessuna app disponibile per aprire questo formato"); }
        });
    }

    private void showPdf(File file, Entry entry) {
        closeInternalViewer(); internalViewer = true;
        try {
            activePdfDescriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
            activePdfRenderer = new PdfRenderer(activePdfDescriptor);
            activePdfRatios.clear();
            synchronized (pdfLock) {
                for (int index = 0; index < activePdfRenderer.getPageCount(); index++) {
                    PdfRenderer.Page page = activePdfRenderer.openPage(index);
                    activePdfRatios.add(page.getHeight() / (float) page.getWidth());
                    page.close();
                }
            }
            final int pageCount = activePdfRatios.size();
            LinearLayout root = viewerPage(); root.addView(viewerHeader(entry.name));
            ListView pages = new ListView(this); pages.setDividerHeight(dp(10)); pages.setDivider(new android.graphics.drawable.ColorDrawable(PAGE)); pages.setPadding(dp(10), dp(10), dp(10), dp(10)); pages.setClipToPadding(false); pages.setBackgroundColor(Color.rgb(225, 230, 237));
            pages.setAdapter(new PdfPageAdapter());
            root.addView(pages, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
            LinearLayout status = new LinearLayout(this); status.setGravity(Gravity.CENTER_VERTICAL); status.setPadding(dp(16), dp(6), dp(16), dp(6)); status.setBackgroundColor(Color.WHITE);
            TextView hint = text("Pizzica o tocca due volte per ingrandire", 12); hint.setTextColor(Color.rgb(91, 104, 125));
            TextView counter = text(pageCount == 0 ? "" : "1 / " + pageCount, 13); counter.setTypeface(medium); counter.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
            status.addView(hint, new LinearLayout.LayoutParams(0, dp(34), 1)); status.addView(counter, new LinearLayout.LayoutParams(dp(90), dp(34))); root.addView(status);
            pages.setOnScrollListener(new AbsListView.OnScrollListener() {
                @Override public void onScrollStateChanged(AbsListView view, int state) {}
                @Override public void onScroll(AbsListView view, int firstVisible, int visibleCount, int totalCount) {
                    if (totalCount > 0) counter.setText((Math.min(firstVisible + 1, totalCount)) + " / " + totalCount);
                }
            });
            setContentView(root);
        } catch (Exception error) { closeInternalViewer(); fail(error); showDrive(); }
    }

    private void showImageGallery() {
        closePdf(); internalViewer = true;
        if (galleryEntries.isEmpty()) { showDrive(); return; }
        Entry entry = galleryEntries.get(galleryIndex);
        LinearLayout root = viewerPage(); root.addView(viewerHeader(entry.name));
        ZoomImageView image = new ZoomImageView(this); image.setBackgroundColor(Color.rgb(238, 241, 245)); image.setContentDescription("Anteprima " + entry.name);
        root.addView(image, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        LinearLayout controls = new LinearLayout(this); controls.setGravity(Gravity.CENTER); controls.setPadding(dp(14), dp(10), dp(14), dp(10)); controls.setBackgroundColor(Color.WHITE);
        Button previous = secondary("←  Precedente"); Button next = secondary("Successiva  →");
        TextView counter = text((galleryIndex + 1) + " di " + galleryEntries.size(), 13); counter.setGravity(Gravity.CENTER); counter.setTextColor(Color.rgb(91, 104, 125));
        controls.addView(previous, new LinearLayout.LayoutParams(0, dp(48), 1)); controls.addView(counter, new LinearLayout.LayoutParams(dp(80), dp(48))); controls.addView(next, new LinearLayout.LayoutParams(0, dp(48), 1)); root.addView(controls); setContentView(root);
        previous.setEnabled(galleryIndex > 0); next.setEnabled(galleryIndex < galleryEntries.size() - 1);
        previous.setOnClickListener(v -> navigateGallery(-1)); next.setOnClickListener(v -> navigateGallery(1));
        image.setHorizontalSwipeListener(this::navigateGallery);
        int requestId = ++galleryRequestId; busy("Caricamento immagine…");
        async(() -> {
            File directory = new File(getCacheDir(), "previews"); directory.mkdirs(); File destination = new File(directory, "image-" + Integer.toHexString(entry.id.hashCode()));
            if (entry.nas) api.downloadNas(entry.id, destination); else api.download(entry.id, destination); return decodeSampled(destination, getResources().getDisplayMetrics().widthPixels * 2);
        }, bitmap -> { stopBusy(); if (requestId == galleryRequestId && internalViewer) image.setImageBitmap(bitmap); });
    }

    private void navigateGallery(int direction) { int next = galleryIndex + direction; if (next < 0 || next >= galleryEntries.size()) return; galleryIndex = next; showImageGallery(); }

    private LinearLayout viewerPage() { LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); applyAppBackground(root); return root; }

    private LinearLayout viewerHeader(String name) {
        LinearLayout header = new LinearLayout(this); header.setGravity(Gravity.CENTER_VERTICAL); header.setPadding(dp(10), dp(10), dp(10), dp(8)); header.setBackgroundColor(NAVY);
        Button close = smallButton("←"); header.addView(close, new LinearLayout.LayoutParams(dp(48), dp(48)));
        TextView nameView = text(name, 17); nameView.setTypeface(medium); nameView.setSingleLine(); nameView.setEllipsize(android.text.TextUtils.TruncateAt.END); nameView.setTextColor(Color.WHITE); nameView.setGravity(Gravity.CENTER_VERTICAL); header.addView(nameView, new LinearLayout.LayoutParams(0, dp(48), 1));
        close.setOnClickListener(v -> showDrive());
        ViewCompat.setOnApplyWindowInsetsListener(header, (view, insets) -> { Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars()); header.setPadding(dp(10), bars.top + dp(8), dp(10), dp(8)); return insets; }); return header;
    }

    private Bitmap decodeSampled(File file, int maximumWidth) {
        BitmapFactory.Options bounds = new BitmapFactory.Options(); bounds.inJustDecodeBounds = true; BitmapFactory.decodeFile(file.getAbsolutePath(), bounds);
        int sample = 1; while (bounds.outWidth / sample > maximumWidth) sample *= 2;
        BitmapFactory.Options options = new BitmapFactory.Options(); options.inSampleSize = Math.max(1, sample); return BitmapFactory.decodeFile(file.getAbsolutePath(), options);
    }

    private void closeInternalViewer() { internalViewer = false; galleryRequestId++; closePdf(); }
    private void closePdf() {
        pdfRenderGeneration++;
        pdfPageCache.evictAll();
        pdfRendering.clear();
        activePdfRatios.clear();
        synchronized (pdfLock) {
            if (activePdfRenderer != null) { activePdfRenderer.close(); activePdfRenderer = null; }
            if (activePdfDescriptor != null) { try { activePdfDescriptor.close(); } catch (Exception ignored) {} activePdfDescriptor = null; }
        }
    }

    private void addMenu() {
        if (!"files".equals(view) && !"nas".equals(view)) { chooseFile(); return; }
        new AlertDialog.Builder(this).setTitle("Aggiungi").setItems(new String[]{"Carica file", "Nuova cartella"}, (dialog, which) -> {
            if (which == 0) chooseFile(); else folderDialog();
        }).show();
    }

    private void chooseFile() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE);
        startActivityForResult(intent, PICK_FILE);
    }

    private void chooseBackgroundImage() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(intent, PICK_BACKGROUND);
    }

    private void chooseBackupFolder() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        startActivityForResult(intent, PICK_BACKUP_FOLDER);
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (resultCode != RESULT_OK || data == null || data.getData() == null) return;
        if (requestCode == PICK_BACKGROUND) {
            Uri background = data.getData();
            try { getContentResolver().takePersistableUriPermission(background, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (Exception ignored) {}
            getPreferences(MODE_PRIVATE).edit().putString("background_style", "image").putString("background_uri", background.toString()).apply();
            toast("Sfondo applicato"); showDrive(); return;
        }
        if (requestCode == PICK_BACKUP_FOLDER) {
            Uri tree = data.getData();
            try { getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION); }
            catch (Exception error) { toast("Impossibile conservare l’accesso alla cartella"); return; }
            android.content.SharedPreferences backupSettings = getSharedPreferences(PhotoBackupWorker.SETTINGS, MODE_PRIVATE);
            android.content.SharedPreferences.Editor backupEditor = backupSettings.edit()
                .putString("backup_tree_uri", tree.toString()).putString("backup_source_name", DocumentsContract.getTreeDocumentId(tree))
                .putBoolean("backup_enabled", true)
                .putBoolean("backup_initial_complete", false)
                .putInt("backup_initial_uploaded", 0)
                .putInt("backup_source_total", 0)
                .putInt("backup_uploaded_total", 0)
                .putString("backup_last_status", "Preparazione del backup iniziale completo");
            if (!backupSettings.contains("backup_wifi_only")) backupEditor.putBoolean("backup_wifi_only", true);
            if (!backupSettings.contains("backup_frequency_minutes")) backupEditor.putLong("backup_frequency_minutes", 360);
            if (!backupSettings.contains("backup_max_bytes")) backupEditor.putLong("backup_max_bytes", 200L * 1024 * 1024);
            backupEditor.apply();
            PhotoBackupWorker.schedule(this); PhotoBackupWorker.runNow(this);
            toast("Backup foto attivato"); showPhotoBackupSettings(); return;
        }
        if (requestCode != PICK_FILE) return;
        Uri uri = data.getData(); String[] metadata = fileMetadata(uri);
        busy("Caricamento di " + metadata[0]);
        async(() -> { if ("nas".equals(view)) api.uploadNas(getContentResolver(), uri, metadata[0], metadata[1], currentFolder == null ? null : currentFolder.id, sent -> {}); else api.upload(getContentResolver(), uri, metadata[0], metadata[1], currentFolder == null ? null : currentFolder.id, sent -> {}); return true; }, ignored -> {
            stopBusy(); recordUpload(metadata[0]); toast("File caricato"); loadEntries();
        });
    }

    private String[] fileMetadata(Uri uri) {
        String name = "documento"; String mime = getContentResolver().getType(uri);
        try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) name = cursor.getString(0);
        }
        return new String[]{name, mime == null ? "application/octet-stream" : mime};
    }

    private void folderDialog() {
        EditText name = input("Nome cartella", InputType.TYPE_CLASS_TEXT);
        new AlertDialog.Builder(this).setTitle("Nuova cartella").setView(name).setNegativeButton("Annulla", null).setPositiveButton("Crea", (d, w) -> {
            busy("Creazione…"); async(() -> { if ("nas".equals(view)) api.createNasFolder(name.getText().toString(), currentFolder == null ? null : currentFolder.id); else api.createFolder(name.getText().toString(), currentFolder == null ? null : currentFolder.id); return true; }, ok -> { stopBusy(); loadEntries(); });
        }).show();
    }

    private void entryMenu(Entry entry) {
        if (entry.system) { toast("La cartella Immagini è fissa"); return; }
        if (entry.nas || "nas".equals(view)) {
            String[] actions = entry.folder()
                ? new String[]{"Apri", "Rinomina", "Cambia colore", "Copia", "Taglia / sposta", "Elimina definitivamente"}
                : new String[]{"Apri / visualizza", "Rinomina", "Copia", "Taglia / sposta", "Elimina definitivamente"};
            new AlertDialog.Builder(this).setTitle(entry.name).setItems(actions, (d, which) -> {
                if (which == 0) openEntry(entry);
                else if (which == 1) renameDialog(entry);
                else if (entry.folder() && which == 2) folderColorDialog(entry);
                else if (which == (entry.folder() ? 3 : 2)) setClipboard(entry, false);
                else if (which == (entry.folder() ? 4 : 3)) setClipboard(entry, true);
                else confirmNasDelete(entry);
            }).show();
        } else if ("trash".equals(view)) {
            new AlertDialog.Builder(this).setTitle(entry.name).setItems(new String[]{"Ripristina", "Elimina definitivamente"}, (d, which) -> confirmTrashAction(entry, which == 0)).show();
        } else {
            String[] actions = entry.folder()
                ? new String[]{"Apri", "Rinomina", "Cambia colore", "Copia", "Taglia", "Sposta in un’altra cartella", "Sposta nel cestino"}
                : new String[]{"Apri / visualizza", "Rinomina", "Copia", "Taglia", "Sposta in un’altra cartella", "Sposta nel cestino"};
            new AlertDialog.Builder(this).setTitle(entry.name).setItems(actions, (d, which) -> {
                if (which == 0) openEntry(entry);
                else if (which == 1) renameDialog(entry);
                else if (entry.folder() && which == 2) folderColorDialog(entry);
                else if (which == (entry.folder() ? 3 : 2)) setClipboard(entry, false);
                else if (which == (entry.folder() ? 4 : 3)) setClipboard(entry, true);
                else if (which == (entry.folder() ? 5 : 4)) moveDialog(entry);
                else confirmDelete(entry);
            }).show();
        }
    }

    private void folderColorDialog(Entry entry) {
        String[] names = {"Verde acqua", "Blu cielo", "Viola", "Rosa", "Corallo", "Arancione", "Giallo", "Grigio ardesia"};
        int selected = getPreferences(MODE_PRIVATE).getInt(folderColorKey(entry), 0);
        new AlertDialog.Builder(this).setTitle("Colore di “" + entry.name + "”")
            .setSingleChoiceItems(names, selected, (dialog, which) -> {
                getPreferences(MODE_PRIVATE).edit().putInt(folderColorKey(entry), which).apply();
                dialog.dismiss(); loadEntries();
            }).setNegativeButton("Annulla", null).show();
    }

    private String folderColorKey(Entry entry) { return "folder_color_" + (entry.nas ? "nas_" : "drive_") + entry.id; }

    private int folderColor(Entry entry, boolean background) {
        int[][] colors = {
            {Color.rgb(229,248,243), Color.rgb(40,181,147)}, {Color.rgb(228,242,255), Color.rgb(48,126,199)},
            {Color.rgb(240,234,255), Color.rgb(116,86,203)}, {Color.rgb(255,234,246), Color.rgb(194,77,145)},
            {Color.rgb(255,233,230), Color.rgb(211,84,72)}, {Color.rgb(255,240,222), Color.rgb(207,119,34)},
            {Color.rgb(255,247,210), Color.rgb(181,142,25)}, {Color.rgb(234,238,245), Color.rgb(83,98,121)}
        };
        int index = Math.max(0, Math.min(colors.length - 1, getPreferences(MODE_PRIVATE).getInt(folderColorKey(entry), 0)));
        return colors[index][background ? 0 : 1];
    }

    private void renameDialog(Entry entry) {
        EditText name = input("Nuovo nome", InputType.TYPE_CLASS_TEXT); name.setText(entry.name); name.setSelection(name.length());
        new AlertDialog.Builder(this).setTitle("Rinomina").setView(name).setNegativeButton("Annulla", null).setPositiveButton("Salva", (dialog, which) -> {
            busy("Rinomina…"); async(() -> { if (entry.nas) api.renameNas(entry.id, name.getText().toString()); else api.rename(entry.id, name.getText().toString()); return true; }, ok -> { stopBusy(); toast("Elemento rinominato"); loadEntries(); });
        }).show();
    }

    private void confirmNasDelete(Entry entry) {
        new AlertDialog.Builder(this).setTitle("Elimina definitivamente dal NAS").setMessage(entry.name + "\n\nQuesta operazione non può essere annullata.").setNegativeButton("Annulla", null).setPositiveButton("Elimina", (d, w) -> {
            busy("Eliminazione…"); async(() -> { api.deleteNas(entry.id); return true; }, ok -> { stopBusy(); toast("Elemento eliminato dal NAS"); loadEntries(); });
        }).show();
    }

    private void setClipboard(Entry entry, boolean cut) {
        clipboardEntry = entry; clipboardCut = cut;
        if (pasteButton != null) pasteButton.setVisibility(View.VISIBLE);
        toast(cut ? "Elemento tagliato: apri la destinazione e premi Incolla" : "Elemento copiato: apri la destinazione e premi Incolla");
    }

    private void pasteClipboard() {
        if (clipboardEntry == null) return;
        if (clipboardEntry.nas != "nas".equals(view)) { toast("Sorgente e destinazione devono trovarsi entrambe nel NAS oppure in I miei file"); return; }
        if (!"files".equals(view) && !"nas".equals(view)) { toast("Apri la cartella di destinazione per incollare"); return; }
        String parentId = currentFolder == null ? null : currentFolder.id;
        Entry source = clipboardEntry; boolean cut = clipboardCut;
        busy(cut ? "Spostamento…" : "Copia…");
        async(() -> {
            if (source.nas) { if (cut) api.moveNas(source.id, parentId); else api.copyNas(source.id, parentId); }
            else { if (cut) api.move(source.id, parentId); else api.copy(source.id, parentId); }
            return true;
        }, ok -> {
            stopBusy();
            if (cut) { clipboardEntry = null; clipboardCut = false; pasteButton.setVisibility(View.GONE); }
            toast(cut ? "Elemento spostato" : "Copia creata"); loadEntries();
        });
    }

    private void moveDialog(Entry entry) {
        busy("Caricamento cartelle…");
        async(() -> api.folders(), folders -> {
            stopBusy();
            List<Entry> choices = new ArrayList<>();
            choices.add(null); choices.addAll(folders);
            String[] labels = new String[choices.size()]; labels[0] = "I miei file";
            for (int i = 1; i < choices.size(); i++) labels[i] = choices.get(i).name;
            new AlertDialog.Builder(this).setTitle("Sposta “" + entry.name + "”").setItems(labels, (dialog, which) -> {
                Entry destination = choices.get(which);
                if (destination != null && destination.id.equals(entry.id)) { toast("Destinazione non valida"); return; }
                busy("Spostamento…");
                async(() -> { api.move(entry.id, destination == null ? null : destination.id); return true; }, ok -> { stopBusy(); toast("Elemento spostato"); loadEntries(); });
            }).show();
        });
    }

    private void confirmDelete(Entry entry) {
        new AlertDialog.Builder(this).setTitle("Sposta nel cestino").setMessage(entry.name).setNegativeButton("Annulla", null).setPositiveButton("Sposta", (d, w) -> {
            busy("Spostamento…"); async(() -> { api.trash(entry.id); return true; }, ok -> { stopBusy(); loadEntries(); });
        }).show();
    }

    private void confirmTrashAction(Entry entry, boolean restore) {
        new AlertDialog.Builder(this).setTitle(restore ? "Ripristina" : "Elimina definitivamente").setMessage(entry.name).setNegativeButton("Annulla", null).setPositiveButton(restore ? "Ripristina" : "Elimina", (d, w) -> {
            busy("Operazione in corso…"); async(() -> { if (restore) api.restore(entry.id); else api.permanentDelete(entry.id); return true; }, ok -> { stopBusy(); loadEntries(); });
        }).show();
    }

    private void accountMenu() {
        new AlertDialog.Builder(this).setTitle("Account").setItems(new String[]{"Aggiorna", "Backup foto", "Aspetto e sfondo", "Cambia server", "Esci"}, (d, which) -> {
            if (which == 0) loadEntries();
            if (which == 1) showPhotoBackupSettings();
            if (which == 2) appearanceMenu();
            if (which == 3) { api.logout(); showServerSetup(); }
            if (which == 4) { api.logout(); showLogin(); }
        }).show();
    }

    private void showPhotoBackupSettings() {
        backupSettingsOpen = true;
        android.content.SharedPreferences settings = getSharedPreferences(PhotoBackupWorker.SETTINGS, MODE_PRIVATE);
        boolean enabled = settings.getBoolean("backup_enabled", false);
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); applyAppBackground(root);
        LinearLayout header = new LinearLayout(this); header.setGravity(Gravity.CENTER_VERTICAL); header.setPadding(dp(10), dp(10), dp(14), dp(8)); header.setBackgroundColor(NAVY);
        Button close = smallButton("←"); header.addView(close, new LinearLayout.LayoutParams(dp(48), dp(48)));
        TextView heading = text("Opzioni backup", 20); heading.setTypeface(medium); heading.setTextColor(Color.WHITE); heading.setGravity(Gravity.CENTER_VERTICAL); header.addView(heading, new LinearLayout.LayoutParams(0, dp(48), 1)); root.addView(header);
        ViewCompat.setOnApplyWindowInsetsListener(header, (view, insets) -> { Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars()); header.setPadding(dp(10), bars.top + dp(8), dp(14), dp(8)); return insets; });
        close.setOnClickListener(v -> { backupSettingsOpen = false; showDrive(); });

        ScrollView scroll = new ScrollView(this); LinearLayout body = new LinearLayout(this); body.setOrientation(LinearLayout.VERTICAL); body.setPadding(dp(18), dp(18), dp(18), dp(28)); scroll.addView(body); root.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        TextView statusTitle = text(enabled ? "Backup attivo" : "Backup non configurato", 18); statusTitle.setTypeface(medium); statusTitle.setTextColor(enabled ? Color.rgb(24, 143, 113) : Color.rgb(105, 117, 136)); body.addView(statusTitle);
        String last = settings.getString("backup_last_status", enabled ? "In attesa del primo backup" : "Scegli una cartella per iniziare"); long lastTime = settings.getLong("backup_last_time", 0);
        TextView status = text(last + (lastTime > 0 ? "\n" + new SimpleDateFormat("dd MMM yyyy · HH:mm", Locale.ITALIAN).format(new Date(lastTime)) : ""), 13); status.setTextColor(Color.rgb(91, 104, 125)); status.setPadding(0, dp(6), 0, dp(18)); body.addView(status);

        TextView counter = text("", 15); counter.setTypeface(medium); counter.setTextColor(NAVY); body.addView(counter);
        ProgressBar backupBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal); backupBar.setMax(1000); body.addView(backupBar, spaced());
        if (backupProgressUpdater != null) uiHandler.removeCallbacks(backupProgressUpdater);
        backupProgressUpdater = new Runnable() {
            @Override public void run() {
                if (!backupSettingsOpen) return;
                int total = settings.getInt("backup_source_total", 0);
                int completed = settings.getInt("backup_uploaded_total", 0);
                counter.setText(total > 0 ? "Foto caricate: " + completed + " di " + total : enabled ? "Conteggio delle foto in corso…" : "Nessuna cartella selezionata");
                backupBar.setProgress(total > 0 ? Math.min(1000, (int) ((completed * 1000L) / total)) : 0);
                uiHandler.postDelayed(this, 750);
            }
        };
        backupProgressUpdater.run();

        TextView sourceLabel = text("CARTELLA DEL TELEFONO", 11); sourceLabel.setTypeface(bold); sourceLabel.setTextColor(Color.rgb(112, 124, 143)); body.addView(sourceLabel);
        Button source = secondary(settings.getString("backup_source_name", "Scegli la cartella delle foto")); body.addView(source, spaced()); source.setOnClickListener(v -> chooseBackupFolder());

        String destination = settings.getString("backup_destination", "drive");
        TextView destinationLabel = text("DESTINAZIONE", 11); destinationLabel.setTypeface(bold); destinationLabel.setTextColor(Color.rgb(112, 124, 143)); destinationLabel.setPadding(0, dp(22), 0, 0); body.addView(destinationLabel);
        Button destinationButton = secondary("nas".equals(destination) ? "NAS / Backup telefono" : "I miei file / Backup telefono"); body.addView(destinationButton, spaced());
        destinationButton.setOnClickListener(v -> new AlertDialog.Builder(this).setTitle("Destinazione backup").setItems(new String[]{"I miei file / Backup telefono", "NAS / Backup telefono"}, (d, which) -> {
            settings.edit().putString("backup_destination", which == 1 ? "nas" : "drive").apply(); showPhotoBackupSettings();
        }).show());

        long frequency = settings.getLong("backup_frequency_minutes", 360);
        Button frequencyButton = secondary("Frequenza: " + frequencyLabel(frequency)); LinearLayout.LayoutParams frequencyParams = spaced(); frequencyParams.topMargin = dp(18); body.addView(frequencyButton, frequencyParams);
        frequencyButton.setOnClickListener(v -> new AlertDialog.Builder(this).setTitle("Frequenza backup").setItems(new String[]{"Ogni 15 minuti", "Ogni ora", "Ogni 6 ore", "Ogni 24 ore"}, (d, which) -> {
            long[] values = {15, 60, 360, 1440}; settings.edit().putLong("backup_frequency_minutes", values[which]).apply(); if (enabled) PhotoBackupWorker.schedule(this); showPhotoBackupSettings();
        }).show());

        Switch wifi = backupSwitch("Esegui solo tramite Wi-Fi", settings.getBoolean("backup_wifi_only", true)); body.addView(wifi, spaced());
        wifi.setOnCheckedChangeListener((button, checked) -> { settings.edit().putBoolean("backup_wifi_only", checked).apply(); if (enabled) PhotoBackupWorker.schedule(this); });
        Switch charging = backupSwitch("Esegui solo durante la ricarica", settings.getBoolean("backup_charging_only", false)); body.addView(charging, spaced());
        charging.setOnCheckedChangeListener((button, checked) -> { settings.edit().putBoolean("backup_charging_only", checked).apply(); if (enabled) PhotoBackupWorker.schedule(this); });
        Switch videos = backupSwitch("Includi anche i video", settings.getBoolean("backup_include_videos", false)); body.addView(videos, spaced());
        videos.setOnCheckedChangeListener((button, checked) -> settings.edit().putBoolean("backup_include_videos", checked).apply());

        long maximum = settings.getLong("backup_max_bytes", 200L * 1024 * 1024);
        Button maximumButton = secondary("Dimensione massima: " + formatSize(maximum)); body.addView(maximumButton, spaced());
        maximumButton.setOnClickListener(v -> new AlertDialog.Builder(this).setTitle("Dimensione massima per file").setItems(new String[]{"25 MB", "50 MB", "100 MB", "200 MB"}, (d, which) -> {
            long[] values = {25L * 1024 * 1024, 50L * 1024 * 1024, 100L * 1024 * 1024, 200L * 1024 * 1024}; settings.edit().putLong("backup_max_bytes", values[which]).apply(); showPhotoBackupSettings();
        }).show());

        Button run = primary(enabled ? "Avvia backup ora" : "Scegli cartella e attiva"); LinearLayout.LayoutParams runParams = spaced(); runParams.topMargin = dp(24); body.addView(run, runParams);
        run.setOnClickListener(v -> { if (enabled) { PhotoBackupWorker.runNow(this); toast("Backup avviato in background"); } else chooseBackupFolder(); });
        if (enabled) {
            Button disable = secondary("Disattiva backup"); disable.setTextColor(Color.rgb(190, 55, 70)); body.addView(disable, spaced()); disable.setOnClickListener(v -> {
                settings.edit().putBoolean("backup_enabled", false).apply(); PhotoBackupWorker.disable(this); toast("Backup foto disattivato"); showPhotoBackupSettings();
            });
        }
        setContentView(root);
    }

    private Switch backupSwitch(String label, boolean checked) { Switch control = new Switch(this); control.setText(label); control.setTextSize(15); control.setTypeface(regular); control.setTextColor(NAVY); control.setGravity(Gravity.CENTER_VERTICAL); control.setPadding(dp(12), 0, dp(8), 0); control.setBackground(rounded(Color.WHITE, LINE, 12)); control.setChecked(checked); return control; }
    private String frequencyLabel(long minutes) { return minutes <= 15 ? "15 minuti" : minutes <= 60 ? "1 ora" : minutes <= 360 ? "6 ore" : "24 ore"; }

    private String formatEntryDate(String value) {
        try {
            String[] parts = value.substring(0, 10).split("-");
            return parts[2] + "/" + parts[1] + "/" + parts[0];
        } catch (Exception ignored) { return value; }
    }

    private void appearanceMenu() {
        String[] choices = {"Originale", "Verde acqua chiaro", "Azzurro chiaro", "Grigio caldo", "Scegli una foto…"};
        new AlertDialog.Builder(this).setTitle("Aspetto e sfondo").setItems(choices, (dialog, which) -> {
            if (which == 4) { chooseBackgroundImage(); return; }
            String style = new String[]{"default", "mint", "blue", "warm"}[which];
            getPreferences(MODE_PRIVATE).edit().putString("background_style", style).remove("background_uri").apply();
            showDrive();
        }).show();
    }

    private void applyAppBackground(View target) {
        String style = getPreferences(MODE_PRIVATE).getString("background_style", "default");
        if ("image".equals(style)) {
            String value = getPreferences(MODE_PRIVATE).getString("background_uri", "");
            try {
                Bitmap bitmap = decodeBackground(Uri.parse(value));
                if (bitmap != null) { target.setBackground(new AppBackgroundDrawable(bitmap)); return; }
            } catch (Exception ignored) {}
        }
        int color = "mint".equals(style) ? Color.rgb(236, 249, 246) : "blue".equals(style) ? Color.rgb(237, 244, 252) : "warm".equals(style) ? Color.rgb(247, 243, 237) : PAGE;
        target.setBackgroundColor(color);
    }

    private Bitmap decodeBackground(Uri uri) throws Exception {
        BitmapFactory.Options bounds = new BitmapFactory.Options(); bounds.inJustDecodeBounds = true;
        try (InputStream input = getContentResolver().openInputStream(uri)) { BitmapFactory.decodeStream(input, null, bounds); }
        int maximum = Math.max(getResources().getDisplayMetrics().widthPixels, getResources().getDisplayMetrics().heightPixels) * 2;
        int sample = 1; while (Math.max(bounds.outWidth, bounds.outHeight) / sample > maximum) sample *= 2;
        BitmapFactory.Options options = new BitmapFactory.Options(); options.inSampleSize = sample;
        try (InputStream input = getContentResolver().openInputStream(uri)) { return BitmapFactory.decodeStream(input, null, options); }
    }

    private void switchView(String next) {
        view = next; currentFolder = null; folderStack.clear(); search.setText("");
        title.setText("files".equals(view) ? "I miei file" : "images".equals(view) ? "Immagini" : "nas".equals(view) ? "NAS" : "Cestino");
        back.setText("☰"); updateNavState(); loadEntries();
    }

    private void updateNavState() {
        styleNav(navFiles, "files".equals(view));
        styleNav(navImages, "images".equals(view));
        styleNav(navTrash, "trash".equals(view));
        styleDrawerNav(drawerNavFiles, "files".equals(view));
        styleDrawerNav(drawerNavImages, "images".equals(view));
        styleDrawerNav(drawerNavNas, "nas".equals(view));
        styleDrawerNav(drawerNavTrash, "trash".equals(view));
    }

    private void styleNav(Button button, boolean active) {
        if (button == null) return;
        button.setTextColor(active ? Color.rgb(32, 166, 134) : Color.rgb(105, 117, 136));
        button.setTypeface(active ? medium : regular);
        button.setBackgroundColor(Color.TRANSPARENT);
        button.setElevation(0);
    }

    private void styleDrawerNav(Button button, boolean active) {
        if (button == null) return; button.setTextColor(active ? Color.WHITE : Color.rgb(183, 193, 211));
        button.setTypeface(active ? medium : regular); button.setBackground(rounded(active ? Color.rgb(29, 42, 67) : Color.TRANSPARENT, Color.TRANSPARENT, 10));
    }

    private void goBack() {
        currentFolder = folderStack.poll();
        title.setText(currentFolder == null ? ("nas".equals(view) ? "NAS" : "I miei file") : currentFolder.name);
        back.setText(currentFolder == null ? "☰" : "←"); loadEntries();
    }

    @Override public void onBackPressed() {
        if (backupSettingsOpen) { backupSettingsOpen = false; showDrive(); } else if (drawerOpen) closeDrawer(); else if (internalViewer) showDrive(); else if (currentFolder != null) goBack(); else super.onBackPressed();
    }

    private <T> void async(Task<T> task, Success<T> success) {
        io.execute(() -> { try { T value = task.run(); runOnUiThread(() -> success.accept(value)); }
            catch (Exception error) { runOnUiThread(() -> { stopBusy(); fail(error); if (secure.get("access") == null) showLogin(); }); } });
    }

    private void busy(String message) { stopBusy(); progress = ProgressDialog.show(this, null, message, true, false); }
    private void stopBusy() { if (progress != null) { progress.dismiss(); progress = null; } }
    private void fail(Exception error) { toast(error.getMessage() == null ? "Operazione non riuscita" : error.getMessage()); }
    private void toast(String message) { Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }

    private LinearLayout page() { LinearLayout page = new LinearLayout(this); page.setOrientation(LinearLayout.VERTICAL); page.setPadding(dp(28), dp(54), dp(28), dp(24)); applyAppBackground(page); return page; }
    private TextView brand(String subtitle) { TextView text = text("A  Arca Drive\n" + subtitle, 25); text.setTextColor(NAVY); text.setTypeface(bold); return text; }
    private TextView text(String value, int size) { TextView text = new TextView(this); text.setText(value); text.setTextSize(size); text.setTypeface(regular); text.setTextColor(NAVY); return text; }
    private EditText input(String hint, int type) { EditText input = new EditText(this); input.setHint(hint); input.setTextSize(16); input.setTypeface(regular); input.setInputType(type); input.setSingleLine(); input.setPadding(dp(14), 0, dp(14), 0); input.setBackground(rounded(Color.rgb(248, 250, 252), LINE, 12)); return input; }
    private Button primary(String label) { Button b = new Button(this); b.setText(label); b.setAllCaps(false); b.setTextSize(15); b.setTypeface(bold); b.setTextColor(NAVY); b.setBackground(rounded(MINT, Color.TRANSPARENT, 12)); return b; }
    private Button secondary(String label) { Button b = new Button(this); b.setText(label); b.setAllCaps(false); b.setTextSize(14); b.setTypeface(medium); b.setTextColor(NAVY); b.setBackground(rounded(Color.rgb(235, 239, 244), Color.TRANSPARENT, 12)); return b; }
    private Button smallButton(String label) { Button b = new Button(this); b.setText(label); b.setAllCaps(false); b.setTextSize(23); b.setTypeface(regular); b.setTextColor(Color.WHITE); b.setMinWidth(0); b.setMinimumWidth(0); b.setPadding(0, 0, 0, 0); b.setBackground(rounded(Color.TRANSPARENT, Color.TRANSPARENT, 12)); return b; }
    private Button navButton(String label) { Button b = secondary(label); b.setTextSize(13); b.setPadding(dp(6), 0, dp(6), 0); b.setBackground(rounded(Color.TRANSPARENT, Color.TRANSPARENT, 12)); return b; }
    private LinearLayout.LayoutParams matchWrap() { return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52)); }
    private LinearLayout.LayoutParams spaced() { LinearLayout.LayoutParams p = matchWrap(); p.topMargin = dp(12); return p; }
    private LinearLayout.LayoutParams weighted() { LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(0, dp(50), 1); p.setMargins(dp(4), 0, dp(4), 0); return p; }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private GradientDrawable rounded(int fill, int stroke, int radius) { GradientDrawable shape = new GradientDrawable(); shape.setColor(fill); shape.setCornerRadius(dp(radius)); if (stroke != Color.TRANSPARENT) shape.setStroke(dp(1), stroke); return shape; }
    private static String icon(Entry e) { return e.mime.startsWith("image/") ? "IMG" : e.mime.contains("pdf") ? "PDF" : "DOC"; }
    private static String formatSize(long bytes) { if (bytes < 1024) return bytes + " B"; if (bytes < 1024 * 1024) return String.format("%.1f KB", bytes / 1024d); return String.format("%.1f MB", bytes / 1048576d); }

    private final class PdfPageAdapter extends BaseAdapter {
        @Override public int getCount() { return activePdfRatios.size(); }
        @Override public Object getItem(int position) { return position; }
        @Override public long getItemId(int position) { return position; }
        @Override public View getView(int position, View convertView, ViewGroup parent) {
            ZoomImageView pageView = convertView instanceof ZoomImageView ? (ZoomImageView) convertView : new ZoomImageView(MainActivity.this);
            int displayWidth = Math.max(dp(280), getResources().getDisplayMetrics().widthPixels - dp(20));
            int displayHeight = Math.max(1, Math.round(displayWidth * activePdfRatios.get(position)));
            pageView.setTag(position); pageView.setImageDrawable(null); pageView.setBackgroundColor(Color.WHITE); pageView.setContentDescription("Pagina " + (position + 1));
            pageView.setLayoutParams(new AbsListView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, displayHeight));
            Bitmap cached = pdfPageCache.get(position);
            if (cached != null) pageView.setImageBitmap(cached);
            else renderPdfPage(position, pageView, displayWidth);
            return pageView;
        }

        private void renderPdfPage(int position, ZoomImageView target, int displayWidth) {
            if (!pdfRendering.add(position)) return;
            final int generation = pdfRenderGeneration;
            pdfIo.execute(() -> {
                Bitmap bitmap = null;
                try {
                    synchronized (pdfLock) {
                        if (generation != pdfRenderGeneration || activePdfRenderer == null) return;
                        PdfRenderer.Page page = activePdfRenderer.openPage(position);
                        int renderWidth = Math.min(2400, Math.max(displayWidth, displayWidth * 2));
                        int renderHeight = Math.max(1, Math.round(renderWidth * (page.getHeight() / (float) page.getWidth())));
                        bitmap = Bitmap.createBitmap(renderWidth, renderHeight, Bitmap.Config.ARGB_8888); bitmap.eraseColor(Color.WHITE);
                        page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY); page.close();
                    }
                    if (generation != pdfRenderGeneration || bitmap == null) return;
                    pdfPageCache.put(position, bitmap);
                    Bitmap rendered = bitmap;
                    runOnUiThread(() -> {
                        if (generation == pdfRenderGeneration && Integer.valueOf(position).equals(target.getTag())) target.setImageBitmap(rendered);
                    });
                } catch (Exception ignored) {
                    if (bitmap != null && pdfPageCache.get(position) != bitmap && !bitmap.isRecycled()) bitmap.recycle();
                } finally {
                    pdfRendering.remove(position);
                }
            });
        }
    }

    private final class AppBackgroundDrawable extends Drawable {
        private final Bitmap bitmap;
        private final Paint bitmapPaint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        private final Paint veilPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        AppBackgroundDrawable(Bitmap bitmap) { this.bitmap = bitmap; veilPaint.setColor(Color.argb(210, 246, 248, 251)); }

        @Override public void draw(Canvas canvas) {
            Rect bounds = getBounds();
            float scale = Math.max(bounds.width() / (float) bitmap.getWidth(), bounds.height() / (float) bitmap.getHeight());
            float width = bitmap.getWidth() * scale; float height = bitmap.getHeight() * scale;
            RectF destination = new RectF(bounds.centerX() - width / 2f, bounds.centerY() - height / 2f, bounds.centerX() + width / 2f, bounds.centerY() + height / 2f);
            canvas.drawBitmap(bitmap, null, destination, bitmapPaint);
            canvas.drawRect(bounds, veilPaint);
        }

        @Override public void setAlpha(int alpha) { bitmapPaint.setAlpha(alpha); invalidateSelf(); }
        @Override public void setColorFilter(ColorFilter filter) { bitmapPaint.setColorFilter(filter); invalidateSelf(); }
        @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
    }

    private final class FileBadgeView extends View {
        private final Entry entry;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path path = new Path();
        FileBadgeView(Entry entry) { super(MainActivity.this); this.entry = entry; setLayerType(View.LAYER_TYPE_SOFTWARE, null); }

        @Override protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            paint.clearShadowLayer();
            String extension = entry.name.contains(".") ? entry.name.substring(entry.name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT) : "";
            boolean pdf = entry.mime.contains("pdf") || "pdf".equals(extension);
            boolean image = entry.mime.startsWith("image/");
            boolean sheet = extension.matches("xlsx?|ods|csv");
            boolean presentation = extension.matches("pptx?|odp");
            boolean archive = extension.matches("zip|rar|7z|tar|gz");
            boolean media = entry.mime.startsWith("video/") || entry.mime.startsWith("audio/");
            int background = entry.folder() ? folderColor(entry, true) : pdf ? Color.rgb(255, 232, 235) : sheet ? Color.rgb(224, 247, 239) : presentation ? Color.rgb(255, 239, 221) : image ? Color.rgb(238, 234, 255) : archive ? Color.rgb(241, 235, 255) : media ? Color.rgb(228, 241, 255) : Color.rgb(234, 238, 245);
            int foreground = entry.folder() ? folderColor(entry, false) : pdf ? Color.rgb(204, 61, 82) : sheet ? Color.rgb(20, 139, 106) : presentation ? Color.rgb(198, 104, 28) : image ? Color.rgb(105, 87, 202) : archive ? Color.rgb(118, 82, 181) : media ? Color.rgb(48, 112, 181) : Color.rgb(76, 94, 124);
            paint.setStyle(Paint.Style.FILL); paint.setColor(background);
            canvas.drawRoundRect(new RectF(0, 0, getWidth(), getHeight()), dp(11), dp(11), paint);
            paint.setColor(foreground); paint.setStrokeWidth(dp(2)); paint.setStrokeCap(Paint.Cap.ROUND); paint.setStrokeJoin(Paint.Join.ROUND);
            if (entry.folder()) drawFolder(canvas);
            else drawLabel(canvas, pdf ? "PDF" : sheet ? "XLS" : presentation ? "PPT" : image ? "IMG" : archive ? "ZIP" : media ? (entry.mime.startsWith("audio/") ? "AUD" : "VID") : extension.matches("txt|md|rtf") ? "TXT" : extension.isBlank() ? "FILE" : extension.substring(0, Math.min(4, extension.length())).toUpperCase(Locale.ROOT));
        }

        private void drawFolder(Canvas canvas) {
            paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(dp(2));
            path.reset(); path.moveTo(dp(8), dp(17)); path.quadTo(dp(8), dp(13), dp(12), dp(13));
            path.lineTo(dp(20), dp(13)); path.lineTo(dp(24), dp(17)); path.lineTo(dp(37), dp(17));
            path.quadTo(dp(40), dp(17), dp(40), dp(21)); path.lineTo(dp(40), dp(35));
            path.quadTo(dp(40), dp(39), dp(36), dp(39)); path.lineTo(dp(12), dp(39));
            path.quadTo(dp(8), dp(39), dp(8), dp(35)); path.close(); canvas.drawPath(path, paint);
        }

        private void drawLabel(Canvas canvas, String label) {
            paint.setStyle(Paint.Style.FILL); paint.setTypeface(medium); paint.setTextAlign(Paint.Align.CENTER); paint.setTextSize(dp(label.length() > 3 ? 8 : 9));
            Paint.FontMetrics metrics = paint.getFontMetrics();
            canvas.drawText(label, getWidth() / 2f, getHeight() / 2f - (metrics.ascent + metrics.descent) / 2f, paint);
        }
    }
    interface Task<T> { T run() throws Exception; }
    interface Success<T> { void accept(T value); }
}
