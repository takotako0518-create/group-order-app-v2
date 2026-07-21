import { getStore } from "@netlify/blobs";

// Simple key/value store shared by everyone using the site.
// The client (src/storageClient.js) sends { op, key, value, prefix }.
//
// Written as an ES module (import/export) because the project's
// package.json declares "type": "module" — a CommonJS (require/exports)
// function here would crash with "module is not defined in ES module scope".

export default async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { op, key, value, prefix } = body;
  const store = getStore("group-order-data");

  const json = (payload, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

  try {
    if (op === "get") {
      if (!key) return json({ error: "Missing key" }, 400);
      const v = await store.get(key);
      return json({ value: v === undefined ? null : v });
    }

    if (op === "set") {
      if (!key) return json({ error: "Missing key" }, 400);
      await store.set(key, value ?? "");
      return json({ ok: true });
    }

    if (op === "delete") {
      if (!key) return json({ error: "Missing key" }, 400);
      await store.delete(key);
      return json({ ok: true });
    }

    if (op === "list") {
      const { blobs } = await store.list({ prefix: prefix || "" });
      return json({ keys: blobs.map((b) => b.key) });
    }

    return json({ error: `Unknown op: ${op}` }, 400);
  } catch (e) {
    return json({ error: e.message || "storage error" }, 500);
  }
};
