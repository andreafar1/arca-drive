package it.arcadrive.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.ProgressDialog;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.InsetDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.FileProvider;
import androidx.core.content.res.ResourcesCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import org.json.JSONObject;

import java.io.File;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final int PICK_FILE = 40;
    private static final int NAVY = Color.rgb(16, 26, 48);
    private static final int MINT = Color.rgb(49, 199, 163);
    private static final int PAGE = Color.rgb(246, 248, 251);
    private static final int LINE = Color.rgb(224, 229, 237);
    private Typeface regular = Typeface.create("sans-serif", Typeface.NORMAL);
    private Typeface medium = Typeface.create("sans-serif-medium", Typeface.NORMAL);
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
    private ProgressDialog progress;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        Typeface inter = ResourcesCompat.getFont(this, R.font.inter);
        if (inter != null) {
            regular = Typeface.create(inter, Typeface.NORMAL);
            medium = Typeface.create(inter, Typeface.BOLD);
        }
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
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(PAGE);
        LinearLayout header = new LinearLayout(this); header.setGravity(Gravity.CENTER_VERTICAL); header.setPadding(dp(12), dp(10), dp(12), dp(10)); header.setBackgroundColor(NAVY);
        back = smallButton("←"); back.setVisibility(View.GONE); header.addView(back, new LinearLayout.LayoutParams(dp(48), dp(48)));
        title = text("I miei file", 21); title.setTypeface(medium); title.setGravity(Gravity.CENTER_VERTICAL); title.setSingleLine(); title.setTextColor(Color.WHITE); header.addView(title, new LinearLayout.LayoutParams(0, dp(48), 1));
        Button add = smallButton("＋"); header.addView(add, new LinearLayout.LayoutParams(dp(48), dp(48)));
        Button more = smallButton("⋮"); header.addView(more, new LinearLayout.LayoutParams(dp(48), dp(48)));
        root.addView(header);

        search = input("Cerca file e cartelle", InputType.TYPE_CLASS_TEXT); search.setSingleLine();
        search.setBackground(rounded(Color.WHITE, LINE, 12));
        LinearLayout searchRow = new LinearLayout(this); searchRow.setGravity(Gravity.CENTER_VERTICAL); searchRow.setPadding(dp(14), dp(14), dp(14), dp(8)); searchRow.addView(search, new LinearLayout.LayoutParams(0, dp(52), 1));
        Button searchButton = secondary("Cerca"); LinearLayout.LayoutParams searchButtonParams = new LinearLayout.LayoutParams(dp(92), dp(52)); searchButtonParams.leftMargin = dp(8); searchRow.addView(searchButton, searchButtonParams); root.addView(searchRow);

        list = new ListView(this); list.setDividerHeight(0); list.setPadding(dp(8), dp(4), dp(8), dp(6)); list.setClipToPadding(false); list.setBackgroundColor(PAGE); root.addView(list, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        LinearLayout nav = new LinearLayout(this); nav.setGravity(Gravity.CENTER); nav.setPadding(dp(10), dp(8), dp(10), dp(8)); nav.setBackgroundColor(Color.WHITE);
        Button files = navButton("File"); Button images = navButton("Immagini"); Button trash = navButton("Cestino");
        nav.addView(files, weighted()); nav.addView(images, weighted()); nav.addView(trash, weighted()); root.addView(nav);
        setContentView(root);
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars());
            header.setPadding(dp(12), bars.top + dp(8), dp(12), dp(8));
            nav.setPadding(dp(10), dp(8), dp(10), bars.bottom + dp(8));
            return windowInsets;
        });

        back.setOnClickListener(v -> goBack());
        add.setOnClickListener(v -> addMenu());
        more.setOnClickListener(v -> accountMenu());
        searchButton.setOnClickListener(v -> loadEntries());
        files.setOnClickListener(v -> switchView("files")); images.setOnClickListener(v -> switchView("images")); trash.setOnClickListener(v -> switchView("trash"));
        list.setOnItemClickListener((parent, row, position, id) -> openEntry(currentEntries.get(position)));
        list.setOnItemLongClickListener((parent, row, position, id) -> { entryMenu(currentEntries.get(position)); return true; });
        loadEntries();
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
                    TextView badge = text(entry.folder() ? "DIR" : icon(entry), 10); badge.setTypeface(medium); badge.setGravity(Gravity.CENTER); badge.setTextColor(entry.folder() ? Color.rgb(82, 100, 130) : entry.mime.startsWith("image/") ? Color.rgb(14, 116, 95) : entry.mime.contains("pdf") ? Color.rgb(190, 55, 70) : Color.rgb(45, 83, 150));
                    badge.setBackground(rounded(entry.folder() ? Color.rgb(234, 238, 245) : entry.mime.startsWith("image/") ? Color.rgb(220, 247, 238) : entry.mime.contains("pdf") ? Color.rgb(255, 231, 234) : Color.rgb(229, 238, 255), Color.TRANSPARENT, 9));
                    row.addView(badge, new LinearLayout.LayoutParams(dp(48), dp(40)));
                    LinearLayout labels = new LinearLayout(MainActivity.this); labels.setOrientation(LinearLayout.VERTICAL); labels.setPadding(dp(13), 0, 0, 0);
                    TextView name = text(entry.name, 15); name.setTypeface(medium); name.setMaxLines(2); labels.addView(name);
                    TextView detail = text(entry.folder() ? "Cartella" : formatSize(entry.size), 13); detail.setTextColor(Color.rgb(112, 124, 143)); detail.setPadding(0, dp(3), 0, 0); labels.addView(detail);
                    row.addView(labels, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
                    return row;
                }
            });
        });
    }

    private void openEntry(Entry entry) {
        if (entry.folder()) {
            if (currentFolder != null) folderStack.push(currentFolder);
            currentFolder = entry; title.setText(entry.name); back.setVisibility(View.VISIBLE); search.setText(""); loadEntries();
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
            try {
                Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".files", file);
                Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, entry.mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivity(Intent.createChooser(intent, "Apri con"));
            } catch (Exception error) { toast("Nessuna app disponibile per aprire questo formato"); }
        });
    }

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
            stopBusy(); toast("File caricato"); loadEntries();
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
            new AlertDialog.Builder(this).setTitle(entry.name).setItems(new String[]{entry.folder() ? "Apri" : "Apri / scarica", "Sposta in un’altra cartella", "Sposta nel cestino"}, (d, which) -> {
                if (which == 0) openEntry(entry); else if (which == 1) moveDialog(entry); else confirmDelete(entry);
            }).show();
        }
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
        back.setVisibility(View.GONE); loadEntries();
    }

    private void goBack() {
        currentFolder = folderStack.poll();
        title.setText(currentFolder == null ? "I miei file" : currentFolder.name);
        back.setVisibility(currentFolder == null ? View.GONE : View.VISIBLE); loadEntries();
    }

    @Override public void onBackPressed() {
        if (currentFolder != null) goBack(); else super.onBackPressed();
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
    private TextView brand(String subtitle) { TextView text = text("A  Arca Drive\n" + subtitle, 25); text.setTextColor(NAVY); text.setTypeface(medium); return text; }
    private TextView text(String value, int size) { TextView text = new TextView(this); text.setText(value); text.setTextSize(size); text.setTypeface(regular); text.setTextColor(NAVY); return text; }
    private EditText input(String hint, int type) { EditText input = new EditText(this); input.setHint(hint); input.setTextSize(16); input.setTypeface(regular); input.setInputType(type); input.setSingleLine(); input.setPadding(dp(14), 0, dp(14), 0); input.setBackground(rounded(Color.rgb(248, 250, 252), LINE, 12)); return input; }
    private Button primary(String label) { Button b = new Button(this); b.setText(label); b.setAllCaps(false); b.setTextSize(15); b.setTypeface(medium); b.setTextColor(NAVY); b.setBackground(rounded(MINT, Color.TRANSPARENT, 12)); return b; }
    private Button secondary(String label) { Button b = new Button(this); b.setText(label); b.setAllCaps(false); b.setTextSize(14); b.setTypeface(medium); b.setTextColor(NAVY); b.setBackground(rounded(Color.rgb(235, 239, 244), Color.TRANSPARENT, 12)); return b; }
    private Button smallButton(String label) { Button b = new Button(this); b.setText(label); b.setAllCaps(false); b.setTextSize(23); b.setTypeface(regular); b.setTextColor(Color.WHITE); b.setMinWidth(0); b.setMinimumWidth(0); b.setPadding(0, 0, 0, 0); b.setBackground(rounded(Color.TRANSPARENT, Color.TRANSPARENT, 12)); return b; }
    private Button navButton(String label) { Button b = secondary(label); b.setTextSize(13); b.setBackground(rounded(Color.rgb(242, 245, 249), Color.TRANSPARENT, 12)); return b; }
    private LinearLayout.LayoutParams matchWrap() { return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52)); }
    private LinearLayout.LayoutParams spaced() { LinearLayout.LayoutParams p = matchWrap(); p.topMargin = dp(12); return p; }
    private LinearLayout.LayoutParams weighted() { return new LinearLayout.LayoutParams(0, dp(55), 1); }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private GradientDrawable rounded(int fill, int stroke, int radius) { GradientDrawable shape = new GradientDrawable(); shape.setColor(fill); shape.setCornerRadius(dp(radius)); if (stroke != Color.TRANSPARENT) shape.setStroke(dp(1), stroke); return shape; }
    private static String icon(Entry e) { return e.mime.startsWith("image/") ? "IMG" : e.mime.contains("pdf") ? "PDF" : "DOC"; }
    private static String formatSize(long bytes) { if (bytes < 1024) return bytes + " B"; if (bytes < 1024 * 1024) return String.format("%.1f KB", bytes / 1024d); return String.format("%.1f MB", bytes / 1048576d); }
    interface Task<T> { T run() throws Exception; }
    interface Success<T> { void accept(T value); }
}
