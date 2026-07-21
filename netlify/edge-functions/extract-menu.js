// Edge Function version of the menu-extraction proxy. Regular Netlify
// Functions (AWS Lambda under the hood) reject request bodies over ~6MB,
// which a base64-encoded multi-page PDF menu can easily exceed. Edge
// Functions run at the CDN edge (Deno) and accept much larger payloads,
// so we use one here instead.
//
// The API key (GEMINI_API_KEY) stays server-side — it's read from the
// environment and never sent to the browser.

export default async (request) => {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: { message: "Method Not Allowed" } }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error: { message: "伺服器尚未設定 GEMINI_API_KEY，請到 Netlify 後台的環境變數設定。" },
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: { message: "Invalid JSON body" } }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const model = payload.model || "gemini-3.5-flash";
  delete payload.model;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(payload),
      }
    );
    const text = await res.text();
    return new Response(text, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: { message: e.message || "request failed" } }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const config = {
  path: "/.netlify/functions/extract-menu",
};
