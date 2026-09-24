package it.arcadrive.mobile;

import android.content.ContentResolver;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

final class ApiClient {
    static final class Response {
        final int status;
        final String body;
        Response(int status, String body) { this.status = status; this.body = body; }
        JSONObject object() throws Exception { return body.isBlank() ? new JSONObject() : new JSONObject(body); }
    }

    private final SecureStore store;
    private final boolean allowLocalHttp;
    private String baseUrl;

    ApiClient(SecureStore store, String baseUrl, boolean allowLocalHttp) {
        this.store = store;
        this.allowLocalHttp = allowLocalHttp;
        setBaseUrl(baseUrl);
    }

    void setBaseUrl(String value) {
        baseUrl = value == null ? "" : value.trim().replaceAll("/+$", "");
    }

    Response login(String email, String password) throws Exception {
        JSONObject body = new JSONObject().put("email", email).put("password", password)
            .put("deviceName", "Arca Drive Android").put("platform", "android");
        return request("POST", "/api/auth/login", body, false, false);
    }

    Response verify2fa(String challenge, String code) throws Exception {
        return request("POST", "/api/auth/2fa", new JSONObject().put("challengeToken", challenge).put("code", code), false, false);
    }

    JSONObject me() throws Exception { return request("GET", "/api/me", null, true, true).object(); }

    List<Entry> entries(String parentId, String view, String search) throws Exception {
        if ("nas".equals(view)) return nasEntries(parentId, search);
        StringBuilder path = new StringBuilder("/api/entries?");
        if (parentId != null && "files".equals(view)) path.append("parentId=").append(enc(parentId)).append('&');
        if ("images".equals(view)) path.append("images=true&");
        if ("trash".equals(view)) path.append("trash=true&");
        if (search != null && !search.isBlank()) path.append("q=").append(enc(search));
        JSONArray data = new JSONArray(request("GET", path.toString(), null, true, true).body);
        List<Entry> result = new ArrayList<>();
        for (int i = 0; i < data.length(); i++) result.add(new Entry(data.getJSONObject(i)));
        return result;
    }

    private List<Entry> nasEntries(String pathValue, String search) throws Exception {
        StringBuilder path = new StringBuilder("/api/nas?");
        if (pathValue != null) path.append("path=").append(enc(pathValue)).append('&');
        if (search != null && !search.isBlank()) path.append("q=").append(enc(search));
        JSONArray data = new JSONArray(request("GET", path.toString(), null, true, true).body);
        List<Entry> result = new ArrayList<>();
        for (int i = 0; i < data.length(); i++) result.add(new Entry(data.getJSONObject(i)));
        return result;
    }

    void createFolder(String name, String parentId) throws Exception {
        request("POST", "/api/folders", new JSONObject().put("name", name).put("parentId", parentId == null ? JSONObject.NULL : parentId), true, true);
    }

    void createNasFolder(String name, String parentPath) throws Exception {
        request("POST", "/api/nas/folders", new JSONObject().put("name", name).put("path", parentPath == null ? "" : parentPath), true, true);
    }

    List<Entry> folders() throws Exception {
        JSONArray data = new JSONArray(request("GET", "/api/folders", null, true, true).body);
        List<Entry> result = new ArrayList<>();
        for (int i = 0; i < data.length(); i++) {
            JSONObject item = data.getJSONObject(i).put("kind", "folder");
            result.add(new Entry(item));
        }
        return result;
    }

    void move(String id, String parentId) throws Exception {
        request("PATCH", "/api/entries/" + id + "/move", new JSONObject().put("parentId", parentId == null ? JSONObject.NULL : parentId), true, true);
    }

    void rename(String id, String name) throws Exception {
        request("PATCH", "/api/entries/" + id + "/rename", new JSONObject().put("name", name), true, true);
    }

    void renameNas(String path, String name) throws Exception {
        request("PATCH", "/api/nas/rename", new JSONObject().put("path", path).put("name", name), true, true);
    }

    void deleteNas(String path) throws Exception { request("DELETE", "/api/nas?path=" + enc(path), null, true, true); }

    void copy(String id, String parentId) throws Exception {
        request("POST", "/api/entries/" + id + "/copy", new JSONObject().put("parentId", parentId == null ? JSONObject.NULL : parentId), true, true);
    }

    void trash(String id) throws Exception { request("DELETE", "/api/entries/" + id, null, true, true); }
    void restore(String id) throws Exception { request("POST", "/api/entries/" + id + "/restore", new JSONObject(), true, true); }
    void permanentDelete(String id) throws Exception { request("DELETE", "/api/entries/" + id + "/permanent", null, true, true); }

    void upload(ContentResolver resolver, Uri uri, String displayName, String mime, String parentId, Progress progress) throws Exception {
        uploadToPath(resolver, uri, displayName, mime, parentId, false, progress);
    }

    void uploadNas(ContentResolver resolver, Uri uri, String displayName, String mime, String parentPath, Progress progress) throws Exception {
        uploadToPath(resolver, uri, displayName, mime, parentPath, true, progress);
    }

    private void uploadToPath(ContentResolver resolver, Uri uri, String displayName, String mime, String parentId, boolean nas, Progress progress) throws Exception {
        String boundary = "ArcaDrive" + System.currentTimeMillis();
        HttpURLConnection connection = open("POST", nas ? "/api/nas/files" : "/api/files", true);
        connection.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
        connection.setChunkedStreamingMode(256 * 1024);
        connection.setDoOutput(true);
        try (OutputStream out = connection.getOutputStream(); InputStream in = resolver.openInputStream(uri)) {
            if (nas) part(out, boundary, "path", parentId == null ? "" : parentId);
            else if (parentId != null) part(out, boundary, "parentId", parentId);
            write(out, "--" + boundary + "\r\nContent-Disposition: form-data; name=\"files\"; filename=\"" + displayName.replace("\"", "") + "\"\r\nContent-Type: " + mime + "\r\n\r\n");
            byte[] buffer = new byte[128 * 1024]; int read; long sent = 0;
            while ((read = in.read(buffer)) >= 0) { out.write(buffer, 0, read); sent += read; progress.sent(sent); }
            write(out, "\r\n--" + boundary + "--\r\n");
        }
        check(connection);
    }

    File download(String id, File destination) throws Exception {
        return downloadPath("/api/entries/" + id + "/content", destination);
    }

    File downloadNas(String path, File destination) throws Exception {
        return downloadPath("/api/nas/content?path=" + enc(path), destination);
    }

    File downloadThumbnail(Entry entry, File destination) throws Exception {
        String path = entry.nas
            ? "/api/nas/thumbnail?path=" + enc(entry.id)
            : "/api/entries/" + entry.id + "/thumbnail";
        return downloadPath(path, destination);
    }

    private File downloadPath(String path, File destination) throws Exception {
        HttpURLConnection connection = open("GET", path, true);
        if (connection.getResponseCode() == 401 && refresh()) connection = open("GET", path, true);
        if (connection.getResponseCode() / 100 != 2) throw error(connection);
        try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(destination)) {
            byte[] buffer = new byte[128 * 1024]; int read;
            while ((read = in.read(buffer)) >= 0) out.write(buffer, 0, read);
        }
        return destination;
    }

    void saveSession(JSONObject result) {
        String access = result.optString("accessToken", result.optString("token"));
        store.put("access", access);
        store.put("refresh", result.optString("refreshToken"));
        store.put("user", result.optJSONObject("user") == null ? "" : result.optJSONObject("user").toString());
    }

    void logout() {
        try { request("POST", "/api/auth/logout", new JSONObject(), true, false); } catch (Exception ignored) {}
        store.clearSession();
    }

    private Response request(String method, String path, JSONObject body, boolean auth, boolean retry) throws Exception {
        HttpURLConnection connection = open(method, path, auth);
        if (body != null) {
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setDoOutput(true);
            try (OutputStream out = connection.getOutputStream()) { out.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
        }
        int status = connection.getResponseCode();
        if (status == 401 && auth && retry && refresh()) return request(method, path, body, true, false);
        String text = read(status >= 400 ? connection.getErrorStream() : connection.getInputStream());
        if (status < 200 || status >= 300) throw new Exception(errorMessage(text, status));
        return new Response(status, text);
    }

    private boolean refresh() {
        String refresh = store.get("refresh");
        if (refresh == null) return false;
        try {
            Response response = request("POST", "/api/auth/refresh", new JSONObject().put("refreshToken", refresh), false, false);
            saveSession(response.object());
            return true;
        } catch (Exception error) { store.clearSession(); return false; }
    }

    private HttpURLConnection open(String method, String path, boolean auth) throws Exception {
        if (!isAllowedServer(baseUrl)) throw new Exception("Usa HTTPS oppure un indirizzo HTTP della rete locale");
        HttpURLConnection connection = (HttpURLConnection) new URL(baseUrl + path).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(120000);
        connection.setRequestProperty("Accept", "application/json");
        if (auth && store.get("access") != null) connection.setRequestProperty("Authorization", "Bearer " + store.get("access"));
        return connection;
    }

    private void check(HttpURLConnection connection) throws Exception {
        if (connection.getResponseCode() / 100 != 2) throw error(connection);
    }

    private Exception error(HttpURLConnection connection) throws Exception {
        return new Exception(errorMessage(read(connection.getErrorStream()), connection.getResponseCode()));
    }

    private static String errorMessage(String text, int status) {
        try { return new JSONObject(text).optString("error", "Errore server " + status); }
        catch (Exception ignored) { return "Errore server " + status; }
    }

    private static String read(InputStream input) throws Exception {
        if (input == null) return "";
        try (InputStream in = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int count;
            while ((count = in.read(buffer)) >= 0) out.write(buffer, 0, count);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private static void write(OutputStream out, String value) throws Exception { out.write(value.getBytes(StandardCharsets.UTF_8)); }
    private static void part(OutputStream out, String boundary, String name, String value) throws Exception {
        write(out, "--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + name + "\"\r\n\r\n" + value + "\r\n");
    }
    private static String enc(String value) throws Exception { return URLEncoder.encode(value, StandardCharsets.UTF_8.name()); }
    static boolean isLocalHttp(String value) {
        try {
            URI uri = URI.create(value);
            if (!"http".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null) return false;
            String host = uri.getHost().toLowerCase();
            if (host.equals("localhost") || host.endsWith(".local")) return true;
            String[] parts = host.split("\\.");
            if (parts.length != 4) return false;
            int a = Integer.parseInt(parts[0]); int b = Integer.parseInt(parts[1]);
            return a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) || a == 127;
        } catch (Exception ignored) { return false; }
    }
    private boolean isAllowedServer(String value) { return value.startsWith("https://") || (allowLocalHttp && isLocalHttp(value)); }
    interface Progress { void sent(long bytes); }
}
