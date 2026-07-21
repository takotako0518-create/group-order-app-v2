// Polyfills the window.storage.get/set/delete/list API (originally provided by
// the Claude.ai Artifact runtime) using a Netlify Function backed by Netlify Blobs.
// Everyone using this site shares the same data automatically (there's no
// separate "shared vs personal" concept on the real site — the `shared`
// argument is accepted for compatibility but ignored).

async function call(payload) {
  const res = await fetch("/.netlify/functions/storage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`storage request failed (${res.status})`);
  }
  return res.json();
}

const storagePolyfill = {
  async get(key) {
    const data = await call({ op: "get", key });
    if (data.value === null || data.value === undefined) {
      // Matches the original Artifact storage behaviour: missing keys throw.
      throw new Error("key not found");
    }
    return { key, value: data.value, shared: true };
  },

  async set(key, value) {
    await call({ op: "set", key, value });
    return { key, value, shared: true };
  },

  async delete(key) {
    await call({ op: "delete", key });
    return { key, deleted: true, shared: true };
  },

  async list(prefix) {
    const data = await call({ op: "list", prefix: prefix || "" });
    return { keys: data.keys || [], prefix, shared: true };
  },
};

export default storagePolyfill;
