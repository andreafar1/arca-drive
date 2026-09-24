package it.arcadrive.mobile;

import org.json.JSONObject;

final class Entry {
    final String id;
    final String parentId;
    final String name;
    final String kind;
    final String mime;
    final long size;
    final boolean system;
    final boolean nas;
    final String updatedAt;

    Entry(JSONObject json) {
        id = json.optString("id");
        parentId = json.isNull("parent_id") ? null : json.optString("parent_id");
        name = json.optString("name");
        kind = json.optString("kind");
        mime = json.optString("mime_type", "application/octet-stream");
        size = json.optLong("size_bytes", 0);
        system = json.optBoolean("is_system", false);
        nas = json.optBoolean("nas", false);
        updatedAt = json.optString("updated_at", "");
    }

    boolean folder() { return "folder".equals(kind); }
}
