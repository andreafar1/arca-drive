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
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.InsetDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.graphics.pdf.PdfRenderer;
import android.provider.OpenableColumns;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ArrayAdapter;
import android.widget.BaseAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.ImageView;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.FileProvider;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import org.json.JSONObject;
import org.json.JSONArray;

import java.io.File;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Date;
import java.util.Locale;
import java.text.SimpleDateFormat;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final int PICK_FILE = 40;
    private static final int NAVY = Color.rgb(16, 26, 48);
    private static final int MINT = Color.rgb(49, 199, 163);
    private static final int PAGE = Color.rgb(246, 248, 251);
    private static final int LINE = Color.rgb(224, 229, 237);
    private final Typeface regular = Typeface.create("sans-serif", Typeface.NORMAL);
    private final Typeface medium = Typeface.create("sans-serif-medium", Typeface.NORMAL);
    private final Typeface bold = Typeface.create("sans-serif", Typeface.BOLD);
    private final ExecutorService io = Executors.newSingleThreadExecutor();
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
    private Button drawerNavTrash;
    private ProgressDialog progress;
    private boolean internalViewer;
    private PdfRenderer activePdfRenderer;
    private ParcelFileDescriptor activePdfDescriptor;
    private List<Entry> galleryEntries = new ArrayList<>();
    private int galleryIndex;
    private int galleryRequestId;
    private FrameLayout drawerOverlay;
    private LinearLayout uploadHistoryContainer;
    private boolean drawerOpen;
    private Entry clipboardEntry;
    private boolean clipboardCut;
    private Button pasteButton;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        secure = new SecureStore(this);
        server = getPreferences(MODE_PRIVATE).getString("server", "");
        api = new ApiClient(secure, server, BuildConfig.ALLOW_LOCAL_HTTP);
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
        closeInternalViewer();
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(PAGE);
        LinearLayout header = new LinearLayout(this); header.setGravity(Gravity.CENTER_VERTICAL); header.setPadding(dp(12), dp(10), dp(12), dp(10)); header.setBackgroundColor(NAVY);
        back = smallButton(currentFolder == null ? "☰" : "←"); header.addView(back, new LinearLayout.LayoutParams(dp(48), dp(48)));
        title = text("I miei file", 21); title.setTypeface(bold); title.setGravity(Gravity.CENTER_VERTICAL); title.setSingleLine(); title.setTextColor(Color.WHITE); header.addView(title, new LinearLayout.LayoutParams(0, dp(48), 1));
        Button add = smallButton("＋"); header.addView(add, new LinearLayout.LayoutParams(dp(48), dp(48)));
        pasteButton = smallButton("⎘"); pasteButton.setContentDescription("Incolla"); pasteButton.setVisibility(clipboardEntry == null ? View.GONE : View.VISIBLE); header.addView(pasteButton, new LinearLayout.LayoutParams(dp(48), dp(48)));
        Button more = smallButton("⋮"); header.addView(more, new LinearLayout.LayoutParams(dp(48), dp(48)));
        root.addView(header);

        search = input("Cerca file e cartelle", InputType.TYPE_CLASS_TEXT); search.setSingleLine();
        search.setBackground(rounded(Color.WHITE, LINE, 12));
        LinearLayout searchRow = new LinearLayout(this); searchRow.setGravity(Gravity.CENTER_VERTICAL); searchRow.setPadding(dp(14), dp(14), dp(14), dp(8)); searchRow.addView(search, new LinearLayout.LayoutParams(0, dp(52), 1));
        Button searchButton = secondary("Cerca"); LinearLayout.LayoutParams searchButtonParams = new LinearLayout.LayoutParams(dp(92), dp(52)); searchButtonParams.leftMargin = dp(8); searchRow.addView(searchButton, searchButtonParams); root.addView(searchRow);

        list = new ListView(this); list.setDividerHeight(0); list.setPadding(dp(8), dp(4), dp(8), dp(6)); list.setClipToPadding(false); list.setBackgroundColor(PAGE); root.addView(list, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        LinearLayout nav = new LinearLayout(this); nav.setGravity(Gravity.CENTER); nav.setPadding(dp(10), dp(8), dp(10), dp(8)); nav.setBackgroundColor(Color.WHITE);
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
        searchButton.setOnClickListener(v -> loadEntries());
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
        drawerNavFiles = drawerButton("▦   I miei file"); drawerNavImages = drawerButton("▧   Immagini"); drawerNavTrash = drawerButton("♲   Cestino");
        panel.addView(drawerNavFiles, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52))); panel.addView(drawerNavImages, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52))); panel.addView(drawerNavTrash, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52)));
        drawerNavFiles.setOnClickListener(v -> { closeDrawer(); switchView("files"); }); drawerNavImages.setOnClickListener(v -> { closeDrawer(); switchView("images"); }); drawerNavTrash.setOnClickListener(v -> { closeDrawer(); switchView("trash"); });

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
                    LinearLayout row = new LinearLayout(MainActivity.this); row.setOrientation(LinearLayout.HORIZONTAL); row.setGravity(Gravity.CENTER_VERTICAL); row.setPadding(dp(16), dp(13), dp(16), dp(13));
                    row.setBackground(new InsetDrawable(rounded(Color.WHITE, LINE, 13), 0, dp(4), 0, dp(4)));
                    FileBadgeView badge = new FileBadgeView(entry);
                    badge.setElevation(dp(1));
                    row.addView(badge, new LinearLayout.LayoutParams(dp(48), dp(48)));
                    LinearLayout labels = new LinearLayout(MainActivity.this); labels.setOrientation(LinearLayout.VERTICAL); labels.setPadding(dp(13), 0, 0, 0);
                    TextView name = text(entry.name, 15); name.setTypeface(medium); name.setMaxLines(2); labels.addView(name);
                    TextView detail = text(entry.folder() ? "Cartella" : formatSize(entry.size), 13); detail.setTextColor(Color.rgb(112, 124, 143)); detail.setPadding(0, dp(3), 0, 0); labels.addView(detail);
                    row.addView(labels, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
                    Button actions = new Button(MainActivity.this); actions.setText("⋮"); actions.setTextSize(21); actions.setTextColor(Color.rgb(91, 104, 125)); actions.setMinWidth(0); actions.setMinimumWidth(0); actions.setPadding(0, 0, 0, 0); actions.setBackground(rounded(Color.TRANSPARENT, Color.TRANSPARENT, 10)); actions.setContentDescription("Azioni per " + entry.name); actions.setOnClickListener(v -> entryMenu(entry));
                    row.addView(actions, new LinearLayout.LayoutParams(dp(42), dp(42)));
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

    private void preview(Entry entry) {
        busy("Apertura…");
        async(() -> {
            File directory = new File(getCacheDir(), "previews"); directory.mkdirs();
            String safe = entry.name.replaceAll("[^A-Za-z0-9._ -]", "_");
            return api.download(entry.id, new File(directory, safe));
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
            LinearLayout root = viewerPage(); root.addView(viewerHeader(entry.name));
            ListView pages = new ListView(this); pages.setDividerHeight(dp(10)); pages.setDivider(new android.graphics.drawable.ColorDrawable(PAGE)); pages.setPadding(dp(10), dp(10), dp(10), dp(10)); pages.setClipToPadding(false); pages.setBackgroundColor(Color.rgb(225, 230, 237));
            pages.setAdapter(new PdfPageAdapter());
            root.addView(pages, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1)); setContentView(root);
        } catch (Exception error) { closeInternalViewer(); fail(error); showDrive(); }
    }

    private void showImageGallery() {
        closePdf(); internalViewer = true;
        if (galleryEntries.isEmpty()) { showDrive(); return; }
        Entry entry = galleryEntries.get(galleryIndex);
        LinearLayout root = viewerPage(); root.addView(viewerHeader(entry.name));
        ImageView image = new ImageView(this); image.setScaleType(ImageView.ScaleType.FIT_CENTER); image.setBackgroundColor(Color.rgb(238, 241, 245)); image.setContentDescription("Anteprima " + entry.name);
        root.addView(image, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        LinearLayout controls = new LinearLayout(this); controls.setGravity(Gravity.CENTER); controls.setPadding(dp(14), dp(10), dp(14), dp(10)); controls.setBackgroundColor(Color.WHITE);
        Button previous = secondary("←  Precedente"); Button next = secondary("Successiva  →");
        TextView counter = text((galleryIndex + 1) + " di " + galleryEntries.size(), 13); counter.setGravity(Gravity.CENTER); counter.setTextColor(Color.rgb(91, 104, 125));
        controls.addView(previous, new LinearLayout.LayoutParams(0, dp(48), 1)); controls.addView(counter, new LinearLayout.LayoutParams(dp(80), dp(48))); controls.addView(next, new LinearLayout.LayoutParams(0, dp(48), 1)); root.addView(controls); setContentView(root);
        previous.setEnabled(galleryIndex > 0); next.setEnabled(galleryIndex < galleryEntries.size() - 1);
        previous.setOnClickListener(v -> navigateGallery(-1)); next.setOnClickListener(v -> navigateGallery(1));
        final float[] touchX = new float[1];
        image.setOnTouchListener((v, event) -> {
            if (event.getAction() == android.view.MotionEvent.ACTION_DOWN) { touchX[0] = event.getX(); return true; }
            if (event.getAction() == android.view.MotionEvent.ACTION_UP) { float distance = event.getX() - touchX[0]; if (Math.abs(distance) > dp(55)) navigateGallery(distance < 0 ? 1 : -1); else v.performClick(); return true; }
            return true;
        });
        int requestId = ++galleryRequestId; busy("Caricamento immagine…");
        async(() -> {
            File directory = new File(getCacheDir(), "previews"); directory.mkdirs(); File destination = new File(directory, "image-" + entry.id);
            api.download(entry.id, destination); return decodeSampled(destination, getResources().getDisplayMetrics().widthPixels * 2);
        }, bitmap -> { stopBusy(); if (requestId == galleryRequestId && internalViewer) image.setImageBitmap(bitmap); });
    }

    private void navigateGallery(int direction) { int next = galleryIndex + direction; if (next < 0 || next >= galleryEntries.size()) return; galleryIndex = next; showImageGallery(); }

    private LinearLayout viewerPage() { LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(PAGE); return root; }

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
    private void closePdf() { if (activePdfRenderer != null) { activePdfRenderer.close(); activePdfRenderer = null; } if (activePdfDescriptor != null) { try { activePdfDescriptor.close(); } catch (Exception ignored) {} activePdfDescriptor = null; } }

    private void addMenu() {
        if (!"files".equals(view)) { chooseFile(); return; }
        new AlertDialog.Builder(this).setTitle("Aggiungi").setItems(new String[]{"Carica file", "Nuova cartella"}, (dialog, which) -> {
            if (which == 0) chooseFile(); else folderDialog();
        }).show();
    }

    private void chooseFile() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE);
        startActivityForResult(intent, PICK_FILE);
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_FILE || resultCode != RESULT_OK || data == null || data.getData() == null) return;
        Uri uri = data.getData(); String[] metadata = fileMetadata(uri);
        busy("Caricamento di " + metadata[0]);
        async(() -> { api.upload(getContentResolver(), uri, metadata[0], metadata[1], currentFolder == null ? null : currentFolder.id, sent -> {}); return true; }, ignored -> {
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
            busy("Creazione…"); async(() -> { api.createFolder(name.getText().toString(), currentFolder == null ? null : currentFolder.id); return true; }, ok -> { stopBusy(); loadEntries(); });
        }).show();
    }

    private void entryMenu(Entry entry) {
        if (entry.system) { toast("La cartella Immagini è fissa"); return; }
        if ("trash".equals(view)) {
            new AlertDialog.Builder(this).setTitle(entry.name).setItems(new String[]{"Ripristina", "Elimina definitivamente"}, (d, which) -> confirmTrashAction(entry, which == 0)).show();
        } else {
            new AlertDialog.Builder(this).setTitle(entry.name).setItems(new String[]{entry.folder() ? "Apri" : "Apri / visualizza", "Rinomina", "Copia", "Taglia", "Sposta in un’altra cartella", "Sposta nel cestino"}, (d, which) -> {
                if (which == 0) openEntry(entry);
                else if (which == 1) renameDialog(entry);
                else if (which == 2) setClipboard(entry, false);
                else if (which == 3) setClipboard(entry, true);
                else if (which == 4) moveDialog(entry);
                else confirmDelete(entry);
            }).show();
        }
    }

    private void renameDialog(Entry entry) {
        EditText name = input("Nuovo nome", InputType.TYPE_CLASS_TEXT); name.setText(entry.name); name.setSelection(name.length());
        new AlertDialog.Builder(this).setTitle("Rinomina").setView(name).setNegativeButton("Annulla", null).setPositiveButton("Salva", (dialog, which) -> {
            busy("Rinomina…"); async(() -> { api.rename(entry.id, name.getText().toString()); return true; }, ok -> { stopBusy(); toast("Elemento rinominato"); loadEntries(); });
        }).show();
    }

    private void setClipboard(Entry entry, boolean cut) {
        clipboardEntry = entry; clipboardCut = cut;
        if (pasteButton != null) pasteButton.setVisibility(View.VISIBLE);
        toast(cut ? "Elemento tagliato: apri la destinazione e premi Incolla" : "Elemento copiato: apri la destinazione e premi Incolla");
    }

    private void pasteClipboard() {
        if (clipboardEntry == null) return;
        if (!"files".equals(view)) { toast("Apri una cartella in I miei file per incollare"); return; }
        String parentId = currentFolder == null ? null : currentFolder.id;
        Entry source = clipboardEntry; boolean cut = clipboardCut;
        busy(cut ? "Spostamento…" : "Copia…");
        async(() -> { if (cut) api.move(source.id, parentId); else api.copy(source.id, parentId); return true; }, ok -> {
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
        new AlertDialog.Builder(this).setTitle("Account").setItems(new String[]{"Aggiorna", "Cambia server", "Esci"}, (d, which) -> {
            if (which == 0) loadEntries();
            if (which == 1) { api.logout(); showServerSetup(); }
            if (which == 2) { api.logout(); showLogin(); }
        }).show();
    }

    private void switchView(String next) {
        view = next; currentFolder = null; folderStack.clear(); search.setText("");
        title.setText("files".equals(view) ? "I miei file" : "images".equals(view) ? "Immagini" : "Cestino");
        back.setText("☰"); updateNavState(); loadEntries();
    }

    private void updateNavState() {
        styleNav(navFiles, "files".equals(view));
        styleNav(navImages, "images".equals(view));
        styleNav(navTrash, "trash".equals(view));
        styleDrawerNav(drawerNavFiles, "files".equals(view));
        styleDrawerNav(drawerNavImages, "images".equals(view));
        styleDrawerNav(drawerNavTrash, "trash".equals(view));
    }

    private void styleNav(Button button, boolean active) {
        if (button == null) return;
        button.setTextColor(active ? Color.WHITE : Color.rgb(91, 104, 125));
        button.setBackground(rounded(active ? NAVY : Color.TRANSPARENT, Color.TRANSPARENT, 12));
        button.setElevation(active ? dp(2) : 0);
    }

    private void styleDrawerNav(Button button, boolean active) {
        if (button == null) return; button.setTextColor(active ? Color.WHITE : Color.rgb(183, 193, 211));
        button.setTypeface(active ? medium : regular); button.setBackground(rounded(active ? Color.rgb(29, 42, 67) : Color.TRANSPARENT, Color.TRANSPARENT, 10));
    }

    private void goBack() {
        currentFolder = folderStack.poll();
        title.setText(currentFolder == null ? "I miei file" : currentFolder.name);
        back.setText(currentFolder == null ? "☰" : "←"); loadEntries();
    }

    @Override public void onBackPressed() {
        if (drawerOpen) closeDrawer(); else if (internalViewer) showDrive(); else if (currentFolder != null) goBack(); else super.onBackPressed();
    }

    private <T> void async(Task<T> task, Success<T> success) {
        io.execute(() -> { try { T value = task.run(); runOnUiThread(() -> success.accept(value)); }
            catch (Exception error) { runOnUiThread(() -> { stopBusy(); fail(error); if (secure.get("access") == null) showLogin(); }); } });
    }

    private void busy(String message) { stopBusy(); progress = ProgressDialog.show(this, null, message, true, false); }
    private void stopBusy() { if (progress != null) { progress.dismiss(); progress = null; } }
    private void fail(Exception error) { toast(error.getMessage() == null ? "Operazione non riuscita" : error.getMessage()); }
    private void toast(String message) { Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }

    private LinearLayout page() { LinearLayout page = new LinearLayout(this); page.setOrientation(LinearLayout.VERTICAL); page.setPadding(dp(28), dp(54), dp(28), dp(24)); page.setBackgroundColor(Color.WHITE); return page; }
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
        @Override public int getCount() { return activePdfRenderer == null ? 0 : activePdfRenderer.getPageCount(); }
        @Override public Object getItem(int position) { return position; }
        @Override public long getItemId(int position) { return position; }
        @Override public View getView(int position, View convertView, ViewGroup parent) {
            ImageView pageView = convertView instanceof ImageView ? (ImageView) convertView : new ImageView(MainActivity.this);
            if (pageView.getDrawable() instanceof android.graphics.drawable.BitmapDrawable) {
                Bitmap previous = ((android.graphics.drawable.BitmapDrawable) pageView.getDrawable()).getBitmap(); if (previous != null && !previous.isRecycled()) previous.recycle();
            }
            PdfRenderer.Page page = activePdfRenderer.openPage(position);
            int width = Math.max(dp(280), getResources().getDisplayMetrics().widthPixels - dp(20));
            int height = Math.max(1, Math.round(width * (page.getHeight() / (float) page.getWidth())));
            Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888); bitmap.eraseColor(Color.WHITE);
            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY); page.close();
            pageView.setImageBitmap(bitmap); pageView.setAdjustViewBounds(true); pageView.setScaleType(ImageView.ScaleType.FIT_CENTER); pageView.setBackgroundColor(Color.WHITE); pageView.setContentDescription("Pagina " + (position + 1)); return pageView;
        }
    }

    private final class FileBadgeView extends View {
        private final Entry entry;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path path = new Path();
        FileBadgeView(Entry entry) { super(MainActivity.this); this.entry = entry; setLayerType(View.LAYER_TYPE_SOFTWARE, null); }

        @Override protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            paint.clearShadowLayer();
            boolean pdf = entry.mime.contains("pdf");
            boolean image = entry.mime.startsWith("image/");
            boolean sheet = entry.name.matches("(?i).*\\.(xlsx?|ods|csv)$");
            int background = entry.folder() ? Color.rgb(230, 250, 244) : pdf ? Color.rgb(255, 232, 235) : image ? Color.rgb(238, 234, 255) : sheet ? Color.rgb(220, 247, 238) : Color.rgb(234, 238, 245);
            int foreground = entry.folder() ? Color.rgb(49, 199, 163) : pdf ? Color.rgb(214, 78, 94) : image ? Color.rgb(109, 95, 208) : sheet ? Color.rgb(18, 139, 108) : Color.rgb(82, 100, 130);
            paint.setStyle(Paint.Style.FILL); paint.setColor(background);
            canvas.drawRoundRect(new RectF(0, 0, getWidth(), getHeight()), dp(11), dp(11), paint);
            paint.setColor(foreground); paint.setStrokeWidth(dp(2)); paint.setStrokeCap(Paint.Cap.ROUND); paint.setStrokeJoin(Paint.Join.ROUND);
            if (entry.folder()) drawFolder(canvas);
            else if (image) drawImage(canvas);
            else if (sheet) drawSheet(canvas);
            else drawDocument(canvas, pdf ? "PDF" : "DOC");
        }

        private void drawFolder(Canvas canvas) {
            // Parte posteriore con linguetta, come una cartella aperta.
            paint.setStyle(Paint.Style.FILL); paint.setColor(Color.rgb(22, 142, 117));
            path.reset(); path.moveTo(dp(8), dp(17)); path.quadTo(dp(8), dp(13), dp(12), dp(13));
            path.lineTo(dp(20), dp(13)); path.quadTo(dp(22), dp(13), dp(23), dp(10));
            path.quadTo(dp(24), dp(8), dp(27), dp(8)); path.lineTo(dp(37), dp(8));
            path.quadTo(dp(40), dp(8), dp(40), dp(12)); path.lineTo(dp(40), dp(33)); path.lineTo(dp(8), dp(33)); path.close(); canvas.drawPath(path, paint);

            // Fogli visibili all'interno.
            paint.setColor(Color.WHITE); canvas.drawRoundRect(new RectF(dp(11), dp(17), dp(37), dp(29)), dp(2), dp(2), paint);
            paint.setColor(Color.rgb(177, 198, 195)); paint.setStrokeWidth(dp(1));
            canvas.drawLine(dp(13), dp(20), dp(35), dp(20), paint); canvas.drawLine(dp(13), dp(23), dp(35), dp(23), paint); canvas.drawLine(dp(13), dp(26), dp(31), dp(26), paint);

            // Pannello frontale rialzato con rientro superiore.
            paint.setColor(Color.rgb(49, 199, 163)); paint.setShadowLayer(dp(2), 0, dp(1), Color.argb(70, 8, 66, 55));
            path.reset(); path.moveTo(dp(7), dp(23)); path.quadTo(dp(7), dp(20), dp(11), dp(20));
            path.lineTo(dp(29), dp(20)); path.quadTo(dp(32), dp(20), dp(34), dp(16));
            path.quadTo(dp(35), dp(14), dp(38), dp(14)); path.lineTo(dp(41), dp(14));
            path.quadTo(dp(43), dp(14), dp(42), dp(18)); path.lineTo(dp(40), dp(36));
            path.quadTo(dp(40), dp(39), dp(37), dp(39)); path.lineTo(dp(10), dp(39));
            path.quadTo(dp(7), dp(39), dp(7), dp(36)); path.close(); canvas.drawPath(path, paint); paint.clearShadowLayer();
        }

        private void drawDocument(Canvas canvas, String label) {
            paint.setStyle(Paint.Style.STROKE); canvas.drawRoundRect(new RectF(dp(13), dp(8), dp(35), dp(40)), dp(3), dp(3), paint);
            paint.setStyle(Paint.Style.FILL); paint.setTypeface(bold); paint.setTextAlign(Paint.Align.CENTER); paint.setTextSize(dp(label.length() > 3 ? 7 : 8));
            canvas.drawText(label, dp(24), dp(28), paint);
        }

        private void drawImage(Canvas canvas) {
            paint.setStyle(Paint.Style.STROKE); canvas.drawRoundRect(new RectF(dp(9), dp(10), dp(39), dp(38)), dp(4), dp(4), paint);
            paint.setStyle(Paint.Style.FILL); canvas.drawCircle(dp(31), dp(18), dp(3), paint);
            path.reset(); path.moveTo(dp(12), dp(34)); path.lineTo(dp(21), dp(24)); path.lineTo(dp(27), dp(30)); path.lineTo(dp(31), dp(26)); path.lineTo(dp(37), dp(34)); path.close(); canvas.drawPath(path, paint);
        }

        private void drawSheet(Canvas canvas) {
            paint.setStyle(Paint.Style.STROKE); canvas.drawRoundRect(new RectF(dp(10), dp(9), dp(38), dp(39)), dp(3), dp(3), paint);
            canvas.drawLine(dp(19), dp(10), dp(19), dp(38), paint); canvas.drawLine(dp(29), dp(10), dp(29), dp(38), paint);
            canvas.drawLine(dp(11), dp(19), dp(37), dp(19), paint); canvas.drawLine(dp(11), dp(29), dp(37), dp(29), paint);
        }
    }
    interface Task<T> { T run() throws Exception; }
    interface Success<T> { void accept(T value); }
}
