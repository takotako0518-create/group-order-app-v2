import React, { useState, useEffect, useRef, useCallback } from "react";
import { PDFDocument } from "pdf-lib";
import {
  Settings,
  UtensilsCrossed,
  Users,
  Receipt,
  Plus,
  Minus,
  Trash2,
  ExternalLink,
  AlertTriangle,
  X,
  Check,
  RefreshCw,
  Loader2,
  Edit2,
  ChevronRight,
  Upload,
  Sparkles,
  FileText,
  ChevronUp,
  ChevronDown,
} from "lucide-react";

/* ---------------------------------------------------------
   小聚餐 · 點餐台
   一個給每次不同餐廳的聚餐使用的共用點餐工具
--------------------------------------------------------- */

const DEFAULT_CONFIG = {
  restaurantName: "樂天皇朝 - 新莊店",
  serviceChargePercent: 10,
  minSpendPerPerson: 0,
  minSpendNote: "",
  notes: "",
  officialMenuUrl: "",
};

const DEFAULT_TABLES = [
  { id: "table_1", name: "第一桌", capacity: 4, guestNames: [] },
  { id: "table_2", name: "第二桌", capacity: 4, guestNames: [] },
  { id: "table_3", name: "第三桌", capacity: 4, guestNames: [] },
];

const SAMPLE_MENU = [
  { id: "s1", name: "小籠包（8顆）", price: 220, category: "點心" },
  { id: "s2", name: "蝦餃皇（5顆）", price: 200, category: "點心" },
  { id: "s3", name: "叉燒酥（3顆）", price: 150, category: "點心" },
  { id: "s4", name: "蘿蔔糕", price: 160, category: "點心" },
  { id: "s5", name: "揚州炒飯", price: 260, category: "主食" },
  { id: "s6", name: "干燒伊麵", price: 240, category: "主食" },
  { id: "s7", name: "escargot", price: 0, category: "刪除我" }, // placeholder removed below
  { id: "s8", name: "烏龍茶（壺）", price: 120, category: "飲料" },
  { id: "s9", name: "冬瓜茶", price: 90, category: "飲料" },
].filter((i) => i.id !== "s7");

function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeName(s) {
  return (s || "").trim().toLowerCase();
}

// Returns the subset of `candidateItems` whose name matches an item already
// present in `existingItems`.
function findDuplicateItems(candidateItems, existingItems) {
  const existingNames = new Set(existingItems.map((i) => normalizeName(i.name)));
  return candidateItems.filter((it) => existingNames.has(normalizeName(it.name)));
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Parses free text like "13-18, 25-30, 37-42" or "第13-18頁、第25頁" into
// [[13,18],[25,30],[37,42]]. Accepts English/Chinese commas, dun hao (、),
// and either "-" or "~" as a range separator. A lone number becomes a
// single-page range.
function parsePageRanges(text) {
  if (!text || !text.trim()) return [];
  const cleaned = text.replace(/第|頁|页/g, "");
  const parts = cleaned.split(/[,，、\s]+/).filter(Boolean);
  const ranges = [];
  for (const part of parts) {
    const m = part.match(/^(\d+)\s*[-~至到]\s*(\d+)$/);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = parseInt(m[2], 10);
      if (start > 0 && end >= start) ranges.push([start, end]);
      continue;
    }
    const single = part.match(/^(\d+)$/);
    if (single) {
      const p = parseInt(single[1], 10);
      if (p > 0) ranges.push([p, p]);
    }
  }
  return ranges;
}

// Builds one small single-purpose PDF (as base64) covering exactly the
// given 1-indexed inclusive page range [start, end] of `srcDoc`.
async function buildPdfChunkForRange(srcDoc, start, end) {
  const newDoc = await PDFDocument.create();
  const indices = [];
  for (let p = start - 1; p <= end - 1; p++) indices.push(p);
  const copiedPages = await newDoc.copyPages(srcDoc, indices);
  copiedPages.forEach((p) => newDoc.addPage(p));
  const bytes = await newDoc.save();
  return bytesToBase64(bytes);
}

// Splits a PDF File into several smaller single-purpose PDFs (as base64),
// each covering at most `pagesPerChunk` pages. This lets us send several
// small, fast requests instead of one big one that risks hitting size or
// execution-time limits on the backend.
async function splitPdfIntoChunks(file, pagesPerChunk) {
  const srcBytes = await file.arrayBuffer();
  const srcDoc = await PDFDocument.load(srcBytes);
  const totalPages = srcDoc.getPageCount();
  const chunks = [];
  for (let start = 1; start <= totalPages; start += pagesPerChunk) {
    const end = Math.min(start + pagesPerChunk - 1, totalPages);
    const base64 = await buildPdfChunkForRange(srcDoc, start, end);
    chunks.push({ base64, range: [start, end] });
  }
  return { chunks, totalPages, srcDoc };
}

function salvageJsonArray(text) {
  // Try a clean parse first.
  try {
    const direct = JSON.parse(text);
    return { items: direct, truncated: false };
  } catch (e) {
    // fall through to salvage
  }
  let s = text.trim();
  const start = s.indexOf("[");
  if (start === -1) throw new Error("no array found in response");
  s = s.slice(start);
  const lastBrace = s.lastIndexOf("}");
  if (lastBrace === -1) throw new Error("no complete items found in response");
  let candidate = s.slice(0, lastBrace + 1).replace(/,\s*$/, "") + "]";
  const items = JSON.parse(candidate);
  return { items, truncated: true };
}

// Sends one already-small piece of the menu (one image, or one small PDF
// chunk) to the extraction backend and parses the result.
async function extractMenuFromBase64(base64, mediaType, hint) {
  const promptText =
    "這是一份餐廳菜單（可能只是其中一部分頁面）。請找出每一道菜的品名與價格，整理成精簡的 JSON 陣列，" +
    '格式為 [{"n":"品名","p":數字,"c":"分類"}]，鍵名固定用 n/p/c，不要用完整單字當鍵名。' +
    "分類請用菜單上的分類標題（例如：點心、主食、飲料），看不出分類就填「其他」。" +
    "若同一品項有多種份量／價格（例如 5顆/8顆、小份/大份），拆成多筆，份量標註在品名後面的括號。" +
    "價格只取數字，不含貨幣符號或逗號；「時價」等非數字價格該筆省略。" +
    "只回傳 JSON 陣列本身，不要有說明文字、不要 markdown code block。" +
    (hint && hint.trim() ? `\n\n使用者補充指示（請務必遵守）：${hint.trim()}` : "");

  const response = await fetch("/.netlify/functions/extract-menu", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gemini-3.5-flash",
      contents: [
        {
          parts: [{ inline_data: { mime_type: mediaType, data: base64 } }, { text: promptText }],
        },
      ],
      generationConfig: {
        maxOutputTokens: 4096,
        responseMimeType: "application/json",
      },
    }),
  });
  const rawText = await response.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(
      `伺服器回應異常（狀態碼 ${response.status}）：${rawText.slice(0, 150) || "空白回應"}`
    );
  }
  if (data.error) {
    const status = data.error.status || "";
    const msg = data.error.message || "";
    if (response.status === 429 || status === "RESOURCE_EXHAUSTED" || /quota|rate.?limit/i.test(msg)) {
      throw new Error("已達到 Gemini API 免費額度的請求上限，請稍等 1-2 分鐘後再試一次（或明天再試）。");
    }
    throw new Error(msg || "API 回傳錯誤");
  }
  const parts = data.candidates?.[0]?.content?.parts || [];
  const textBlock = parts.map((p) => p.text || "").join("\n");
  const clean = textBlock.replace(/```json|```/g, "").trim();
  if (!clean) {
    const finishReason = data.candidates?.[0]?.finishReason;
    throw new Error(finishReason ? `empty response (${finishReason})` : "empty response");
  }
  const { items: parsed, truncated } = salvageJsonArray(clean);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("empty result");
  const items = parsed
    .filter((p) => p && (p.n || p.name) && !isNaN(Number(p.p ?? p.price)))
    .map((p) => ({
      id: uid("ai"),
      name: String(p.n ?? p.name).trim(),
      price: Number(p.p ?? p.price),
      category: (p.c ?? p.category ? String(p.c ?? p.category).trim() : "") || "其他",
    }));
  return { items, truncated };
}

const PAGES_PER_PDF_CHUNK = 6;
const DELAY_BETWEEN_CHUNKS_MS = 1300; // spread requests out to avoid free-tier rate limits

// Top-level entry point used by the UI. Automatically splits big PDFs into
// small chunks, sends them one at a time (with a short delay between each
// to avoid bursting rate limits), and merges the results — so the person
// uploading never has to manually split anything.
//
// If `forcedRanges` is given (array of [startPage, endPage], 1-indexed,
// inclusive), only those specific page ranges are processed — used to
// retry just the ranges that failed on a previous run.
async function extractMenuFromFile(file, hint, onProgress, forcedRanges) {
  const mediaType = file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg");
  const isPdf = mediaType === "application/pdf";

  if (!isPdf) {
    onProgress?.({ current: 1, total: 1 });
    const base64 = await fileToBase64(file);
    const { items, truncated } = await extractMenuFromBase64(base64, mediaType, hint);
    return { items, truncated, chunkErrors: [] };
  }

  if (forcedRanges && forcedRanges.length > 0) {
    const srcBytes = await file.arrayBuffer();
    const srcDoc = await PDFDocument.load(srcBytes);
    const allItems = [];
    const chunkErrors = [];
    let anyTruncated = false;
    for (let i = 0; i < forcedRanges.length; i++) {
      const [start, end] = forcedRanges[i];
      onProgress?.({ current: i + 1, total: forcedRanges.length, pageRange: [start, end] });
      try {
        const base64 = await buildPdfChunkForRange(srcDoc, start, end);
        const { items, truncated } = await extractMenuFromBase64(base64, "application/pdf", hint);
        allItems.push(...items);
        if (truncated) anyTruncated = true;
      } catch (e) {
        chunkErrors.push({ range: [start, end], message: e?.message || "unknown error" });
      }
      if (i < forcedRanges.length - 1) await sleep(DELAY_BETWEEN_CHUNKS_MS);
    }
    return { items: allItems, truncated: anyTruncated, chunkErrors };
  }

  let split;
  try {
    split = await splitPdfIntoChunks(file, PAGES_PER_PDF_CHUNK);
  } catch (e) {
    // Couldn't parse/split the PDF (e.g. encrypted) — fall back to sending it whole.
    split = null;
  }

  if (!split || split.chunks.length <= 1) {
    onProgress?.({ current: 1, total: 1 });
    const base64 = split ? split.chunks[0].base64 : await fileToBase64(file);
    const { items, truncated } = await extractMenuFromBase64(base64, "application/pdf", hint);
    return { items, truncated, chunkErrors: [] };
  }

  const { chunks } = split;
  const allItems = [];
  const chunkErrors = [];
  let anyTruncated = false;
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.({ current: i + 1, total: chunks.length, pageRange: chunks[i].range });
    try {
      const { items, truncated } = await extractMenuFromBase64(chunks[i].base64, "application/pdf", hint);
      allItems.push(...items);
      if (truncated) anyTruncated = true;
    } catch (e) {
      chunkErrors.push({ range: chunks[i].range, message: e?.message || "unknown error" });
    }
    if (i < chunks.length - 1) await sleep(DELAY_BETWEEN_CHUNKS_MS);
  }
  return { items: allItems, truncated: anyTruncated, chunkErrors };
}

async function safeGet(key, fallback) {
  try {
    const res = await window.storage.get(key, true);
    if (!res || res.value === undefined || res.value === null) return fallback;
    return JSON.parse(res.value);
  } catch (e) {
    return fallback;
  }
}

async function safeSet(key, value) {
  try {
    await window.storage.set(key, JSON.stringify(value), true);
    return true;
  } catch (e) {
    console.error("storage set failed", key, e);
    return false;
  }
}

function money(n) {
  const v = Math.round((n + Number.EPSILON) * 100) / 100;
  return `$${v.toLocaleString("zh-TW")}`;
}

function parseMenuText(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  let currentCategory = "其他";
  const items = [];
  for (const line of lines) {
    if (line.startsWith("#")) {
      currentCategory = line.replace(/^#+/, "").trim() || "其他";
      continue;
    }
    // Find the price as whatever number sits at the very end of the line —
    // optionally preceded by a currency symbol and/or followed by "元" —
    // regardless of what separator (space, |, tab, comma...) came before it.
    // Everything else on the line becomes the item name.
    const priceMatch = line.match(/(?:NT\$|NT|\$|¥|￥)?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:元)?\s*$/);
    if (!priceMatch) continue;
    const price = parseFloat(priceMatch[1]);
    if (isNaN(price)) continue;
    let name = line.slice(0, priceMatch.index);
    name = name.replace(/[\s,，、|｜:：\-－─—/]+$/, "").trim();
    if (!name) continue;
    items.push({
      id: uid("item"),
      name,
      price,
      category: currentCategory,
    });
  }
  return items;
}

const NAV = [
  { id: "order", label: "我要點餐", icon: UtensilsCrossed },
  { id: "tables", label: "桌次總覽", icon: Users },
  { id: "summary", label: "結算總表", icon: Receipt },
  { id: "setup", label: "聚餐設定", icon: Settings },
];

export default function GroupOrderApp() {
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [menuItems, setMenuItems] = useState([]);
  const [tables, setTables] = useState(DEFAULT_TABLES);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("order");
  const [guestName, setGuestName] = useState("");
  const [nicknameInput, setNicknameInput] = useState("");
  const [selectedTableId, setSelectedTableId] = useState(null);
  const [lastSync, setLastSync] = useState(null);
  const [syncError, setSyncError] = useState("");
  const firstLoad = useRef(true);
  const configDraftTouched = useRef(false);
  const recentWriteRef = useRef(0);

  const trackedSafeSet = async (key, value) => {
    recentWriteRef.current = Date.now();
    const ok = await safeSet(key, value);
    if (!ok) {
      setSyncError(`「${key}」儲存失敗，可能是網路問題或後端設定有誤，請檢查 Netlify 的 Functions/Blobs 設定。`);
    } else if (syncError) {
      setSyncError("");
    }
    return ok;
  };

  const loadAll = useCallback(async (isInitial) => {
    if (!isInitial && Date.now() - recentWriteRef.current < 9000) {
      // Skip this poll cycle so we don't clobber a change that was just
      // made locally — the backend can take a few seconds to become
      // consistent, and re-fetching too soon can briefly show stale data.
      return;
    }
    const [c, m, t, o] = await Promise.all([
      safeGet("event-config", DEFAULT_CONFIG),
      safeGet("menu-items", []),
      safeGet("tables", DEFAULT_TABLES),
      safeGet("orders", []),
    ]);
    setMenuItems(m);
    setTables(t.length ? t : DEFAULT_TABLES);
    setOrders(o);
    if (isInitial || !configDraftTouched.current) {
      setConfig({ ...DEFAULT_CONFIG, ...c });
    }
    setLastSync(new Date());
    setLoading(false);
  }, []);

  useEffect(() => {
    loadAll(true).then(() => {
      firstLoad.current = false;
    });
    const interval = setInterval(() => loadAll(false), 6000);
    return () => clearInterval(interval);
  }, [loadAll]);

  useEffect(() => {
    if (tables.length && !selectedTableId) {
      setSelectedTableId(tables[0].id);
    } else if (selectedTableId && !tables.find((t) => t.id === selectedTableId)) {
      setSelectedTableId(tables[0]?.id || null);
    }
  }, [tables, selectedTableId]);

  /* ---------------- config ---------------- */
  const saveConfig = async (next) => {
    setConfig(next);
    await trackedSafeSet("event-config", next);
  };

  /* ---------------- menu ---------------- */
  const persistMenu = async (next) => {
    setMenuItems(next);
    await trackedSafeSet("menu-items", next);
  };
  const addMenuItem = (item) => persistMenu([...menuItems, { ...item, id: uid("item") }]);
  const addMenuItemsBulk = (items) =>
    persistMenu([...menuItems, ...items.map((it) => ({ ...it, id: uid("item") }))]);
  const updateMenuItem = (id, patch) =>
    persistMenu(menuItems.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  const deleteMenuItem = (id) => persistMenu(menuItems.filter((i) => i.id !== id));
  const deleteMenuItems = (ids) => persistMenu(menuItems.filter((i) => !ids.includes(i.id)));
  const moveMenuItem = (id, direction) => {
    const idx = menuItems.findIndex((i) => i.id === id);
    if (idx === -1) return;
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= menuItems.length) return;
    const next = [...menuItems];
    [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
    persistMenu(next);
  };
  const loadSampleMenu = () => persistMenu([...menuItems, ...SAMPLE_MENU.map((i) => ({ ...i, id: uid("item") }))]);

  /* ---------------- tables ---------------- */
  const persistTables = async (next) => {
    setTables(next);
    await trackedSafeSet("tables", next);
  };
  const addTable = () =>
    persistTables([...tables, { id: uid("table"), name: `第${tables.length + 1}桌`, capacity: 4, guestNames: [] }]);
  const removeTable = (id) => {
    if (orders.some((o) => o.tableId === id)) return false;
    persistTables(tables.filter((t) => t.id !== id));
    return true;
  };
  const updateTableCapacity = (id, delta) =>
    persistTables(tables.map((t) => (t.id === id ? { ...t, capacity: Math.max(1, t.capacity + delta) } : t)));
  const renameTable = (id, name) => persistTables(tables.map((t) => (t.id === id ? { ...t, name } : t)));
  const addGuestNameToTable = (tableId, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    persistTables(
      tables.map((t) => {
        if (t.id !== tableId) return t;
        const existing = t.guestNames || [];
        if (existing.some((n) => normalizeName(n) === normalizeName(trimmed))) return t;
        return { ...t, guestNames: [...existing, trimmed] };
      })
    );
  };
  const removeGuestNameFromTable = (tableId, name) =>
    persistTables(
      tables.map((t) => (t.id === tableId ? { ...t, guestNames: (t.guestNames || []).filter((n) => n !== name) } : t))
    );

  /* ---------------- orders ---------------- */
  const persistOrders = async (next) => {
    setOrders(next);
    await trackedSafeSet("orders", next);
  };
  const addOrder = (item) => {
    if (!guestName || !selectedTableId) return;
    const existing = orders.find(
      (o) => o.guestName === guestName && o.tableId === selectedTableId && o.itemId === item.id
    );
    if (existing) {
      persistOrders(
        orders.map((o) => (o.id === existing.id ? { ...o, qty: o.qty + 1 } : o))
      );
    } else {
      persistOrders([
        ...orders,
        {
          id: uid("order"),
          guestName,
          tableId: selectedTableId,
          itemId: item.id,
          itemName: item.name,
          price: item.price,
          qty: 1,
          ts: Date.now(),
        },
      ]);
    }
  };
  const changeOrderQty = (orderId, delta) => {
    const next = orders
      .map((o) => (o.id === orderId ? { ...o, qty: o.qty + delta } : o))
      .filter((o) => o.qty > 0);
    persistOrders(next);
  };
  const removeOrder = (orderId) => persistOrders(orders.filter((o) => o.id !== orderId));
  const removeGuestOrders = (tableId, guestName) =>
    persistOrders(orders.filter((o) => !(o.tableId === tableId && o.guestName === guestName)));

  /* ---------------- derived ---------------- */
  const tableOrders = (tableId) => orders.filter((o) => o.tableId === tableId);
  const tableSubtotal = (tableId) =>
    tableOrders(tableId).reduce((s, o) => s + o.price * o.qty, 0);
  const tableGuests = (tableId) => [...new Set(tableOrders(tableId).map((o) => o.guestName))];

  const perPersonTotals = {};
  orders.forEach((o) => {
    perPersonTotals[o.guestName] = (perPersonTotals[o.guestName] || 0) + o.price * o.qty;
  });

  const grandSubtotal = orders.reduce((s, o) => s + o.price * o.qty, 0);
  const serviceFee = grandSubtotal * (config.serviceChargePercent / 100);
  const grandTotal = grandSubtotal + serviceFee;

  const myOrders = orders.filter((o) => o.guestName === guestName);

  const categories = [...new Set(menuItems.map((i) => i.category || "其他"))];

  if (loading) {
    return (
      <div style={styles.loadingWrap}>
        <Loader2 className="spin" size={28} />
        <span style={{ marginTop: 10, fontFamily: FONT.body }}>載入聚餐資料中…</span>
        <FontStyles />
      </div>
    );
  }

  return (
    <div style={styles.shell} className="goa-shell">
      <FontStyles />

      {/* ---------- Sidebar / bottom nav ---------- */}
      <nav className="goa-sidebar" style={styles.sidebar}>
        <div className="goa-brand" style={styles.brand}>
          <div style={styles.brandStamp}>合</div>
          <div className="goa-brand-text">
            <div style={styles.brandTitle}>小聚餐</div>
            <div style={styles.brandSub}>點餐台</div>
          </div>
        </div>
        <div className="goa-navlist" style={styles.navList}>
          {NAV.map((n) => {
            const Icon = n.icon;
            const active = activeTab === n.id;
            return (
              <button
                key={n.id}
                onClick={() => setActiveTab(n.id)}
                className={active ? "goa-navbtn goa-navbtn-active" : "goa-navbtn"}
                style={{
                  ...styles.navBtn,
                  ...(active ? styles.navBtnActive : {}),
                }}
              >
                <Icon size={18} />
                <span className="goa-navlabel">{n.label}</span>
              </button>
            );
          })}
        </div>
        <div className="goa-sync" style={styles.syncRow}>
          <RefreshCw size={12} />
          <span>
            {lastSync
              ? `已同步 ${lastSync.toLocaleTimeString("zh-TW", { hour12: false })}`
              : ""}
          </span>
        </div>
      </nav>

      {/* ---------- Main ---------- */}
      <div style={styles.mainArea}>
        <header style={styles.header}>
          <div>
            <div style={styles.headerEyebrow}>本次聚餐</div>
            <h1 style={styles.headerTitle}>{config.restaurantName || "尚未設定餐廳名稱"}</h1>
          </div>
          {(config.serviceChargePercent > 0 || config.minSpendPerPerson > 0) && (
            <div style={styles.feeBadgeWrap}>
              {config.serviceChargePercent > 0 && (
                <div style={styles.feeStamp}>
                  <div style={styles.feeStampPercent}>+{config.serviceChargePercent}%</div>
                  <div style={styles.feeStampLabel}>服務費</div>
                </div>
              )}
              {config.minSpendPerPerson > 0 && (
                <div style={styles.minSpendTag}>
                  低消 {money(config.minSpendPerPerson)}／人
                </div>
              )}
            </div>
          )}
        </header>
        {syncError && (
          <div style={styles.syncErrorBar}>
            <AlertTriangle size={14} style={{ marginRight: 6, flexShrink: 0 }} />
            {syncError}
          </div>
        )}

        <main style={styles.content}>
          {activeTab === "order" && (
            <OrderTab
              config={config}
              guestName={guestName}
              setGuestName={setGuestName}
              nicknameInput={nicknameInput}
              setNicknameInput={setNicknameInput}
              tables={tables}
              selectedTableId={selectedTableId}
              setSelectedTableId={setSelectedTableId}
              menuItems={menuItems}
              categories={categories}
              addOrder={addOrder}
              myOrders={myOrders}
              orders={orders}
              changeOrderQty={changeOrderQty}
              removeOrder={removeOrder}
            />
          )}
          {activeTab === "tables" && (
            <TablesTab
              tables={tables}
              tableOrders={tableOrders}
              tableSubtotal={tableSubtotal}
              tableGuests={tableGuests}
              config={config}
              perPersonTotals={perPersonTotals}
              addTable={addTable}
              removeTable={removeTable}
              updateTableCapacity={updateTableCapacity}
              renameTable={renameTable}
              changeOrderQty={changeOrderQty}
              removeOrder={removeOrder}
              removeGuestOrders={removeGuestOrders}
            />
          )}
          {activeTab === "summary" && (
            <SummaryTab
              tables={tables}
              tableOrders={tableOrders}
              tableSubtotal={tableSubtotal}
              config={config}
              grandSubtotal={grandSubtotal}
              serviceFee={serviceFee}
              grandTotal={grandTotal}
              perPersonTotals={perPersonTotals}
            />
          )}
          {activeTab === "setup" && (
            <SetupTab
              config={config}
              saveConfig={saveConfig}
              onTouch={() => (configDraftTouched.current = true)}
              menuItems={menuItems}
              addMenuItem={addMenuItem}
              addMenuItemsBulk={addMenuItemsBulk}
              updateMenuItem={updateMenuItem}
              deleteMenuItem={deleteMenuItem}
              deleteMenuItems={deleteMenuItems}
              moveMenuItem={moveMenuItem}
              loadSampleMenu={loadSampleMenu}
              tables={tables}
              addTable={addTable}
              removeTable={removeTable}
              updateTableCapacity={updateTableCapacity}
              renameTable={renameTable}
              addGuestNameToTable={addGuestNameToTable}
              removeGuestNameFromTable={removeGuestNameFromTable}
            />
          )}
        </main>
      </div>
    </div>
  );
}

/* =================== ORDER TAB =================== */
function OrderTab({
  config,
  guestName,
  setGuestName,
  nicknameInput,
  setNicknameInput,
  tables,
  selectedTableId,
  setSelectedTableId,
  menuItems,
  categories,
  addOrder,
  myOrders,
  orders,
  changeOrderQty,
  removeOrder,
}) {
  const [toast, setToast] = useState("");
  const toastTimerRef = useRef(null);
  const [pendingDupItem, setPendingDupItem] = useState(null); // item pending confirmation
  const [tableFullWarning, setTableFullWarning] = useState("");
  const [loginError, setLoginError] = useState("");

  const showToast = (text) => {
    setToast(text);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(""), 1600);
  };

  const tableGuestNames = (tableId) => [
    ...new Set(orders.filter((o) => o.tableId === tableId).map((o) => o.guestName)),
  ];

  // A table counts as full when it already has `capacity` distinct guests
  // and the current guest isn't one of them yet.
  const isTableFullForGuest = (tableId, name) => {
    const table = tables.find((t) => t.id === tableId);
    if (!table) return false;
    const guests = tableGuestNames(tableId);
    return guests.length >= table.capacity && !guests.includes(name);
  };

  const confirmAndAdd = (item) => {
    addOrder(item);
    showToast(`已加入「${item.name}」`);
  };

  const handleDishClick = (item) => {
    if (isTableFullForGuest(selectedTableId, guestName)) {
      setTableFullWarning(`${selectedTableName(tables, selectedTableId)}已經滿了，請選其他桌次，或請主辦人調整這桌的人數上限。`);
      return;
    }
    const otherGuestHasIt = orders.some(
      (o) => o.tableId === selectedTableId && o.itemId === item.id && o.guestName !== guestName
    );
    if (otherGuestHasIt) {
      setPendingDupItem(item);
      return;
    }
    confirmAndAdd(item);
  };

  if (!guestName) {
    const startOrdering = (name, tableIdOverride) => {
      const tableId = tableIdOverride || selectedTableId;
      const trimmed = name.trim();
      const table = tables.find((t) => t.id === tableId);
      if (!trimmed) {
        setLoginError("請輸入暱稱");
        return;
      }
      const roster = table?.guestNames || [];
      if (roster.length > 0 && !roster.some((n) => normalizeName(n) === normalizeName(trimmed))) {
        setLoginError(`「${table?.name}」需要使用下列其中一個指定暱稱才能點餐：${roster.join("、")}`);
        return;
      }
      if (isTableFullForGuest(tableId, trimmed)) {
        setLoginError(`「${table?.name}」已經滿了，請選其他桌次，或請主辦人調整這桌的人數上限。`);
        return;
      }
      setLoginError("");
      setSelectedTableId(tableId);
      setGuestName(trimmed);
      const hasHistory = orders.some((o) => o.guestName === trimmed && o.tableId === tableId);
      if (hasHistory) {
        showToast(`歡迎回來！已接續你在「${table?.name}」的點餐紀錄`);
      }
    };

    return (
      <div>
        <h2 style={styles.sectionTitle}>請選擇您的桌次</h2>
        <p style={styles.mutedText}>
          目前共有 {tables.length} 桌；如果桌次已經指定人員名單，點下方暱稱即可直接開始點餐。
        </p>
        <div style={styles.rosterGrid}>
          {tables.map((t) => {
            const guests = tableGuestNames(t.id);
            const roster = t.guestNames || [];
            const active = selectedTableId === t.id;
            return (
              <div
                key={t.id}
                style={active ? styles.tablePickCardActive : styles.tablePickCard}
                onClick={() => {
                  setSelectedTableId(t.id);
                  setLoginError("");
                }}
              >
                <div style={styles.rosterCardHeader}>
                  <span>{t.name}</span>
                  <span style={styles.mutedTextSmall}>
                    {guests.length}/{t.capacity} 人
                  </span>
                </div>
                {roster.length === 0 ? (
                  <span style={styles.mutedTextSmall}>未指定人員名單，可自由輸入暱稱</span>
                ) : (
                  <div style={styles.rosterChips}>
                    {roster.map((n) => (
                      <button
                        key={n}
                        style={guests.includes(n) ? styles.rosterChipMe : styles.rosterChip}
                        onClick={(e) => {
                          e.stopPropagation();
                          startOrdering(n, t.id);
                        }}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div style={styles.inlineForm}>
          <input
            style={styles.input}
            placeholder="輸入暱稱（有指定名單的桌次需完全相符）"
            value={nicknameInput}
            onChange={(e) => setNicknameInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") startOrdering(nicknameInput);
            }}
          />
          <button style={styles.primaryBtn} onClick={() => startOrdering(nicknameInput)}>
            開始點餐
          </button>
        </div>
        {loginError && (
          <p style={styles.warnText}>
            <AlertTriangle size={13} style={{ marginRight: 4 }} /> {loginError}
          </p>
        )}
      </div>
    );
  }

  if (menuItems.length === 0) {
    return (
      <div style={styles.emptyState}>
        <UtensilsCrossed size={28} />
        <p style={styles.mutedText}>尚未設定菜單，請切換到「聚餐設定」新增菜色。</p>
      </div>
    );
  }

  return (
    <div>
      <div style={styles.guestBar}>
        <div>
          您好，<b>{guestName}</b>
          <button style={styles.linkBtn} onClick={() => setGuestName("")}>
            （更換暱稱）
          </button>
        </div>
        <div style={styles.tableSelectWrap}>
          <span style={styles.mutedTextSmall}>我在：</span>
          <select
            style={styles.select}
            value={selectedTableId || ""}
            onChange={(e) => {
              const nextId = e.target.value;
              if (isTableFullForGuest(nextId, guestName)) {
                setTableFullWarning(`${selectedTableName(tables, nextId)}已經滿了，請選其他桌次，或請主辦人調整這桌的人數上限。`);
                return;
              }
              setSelectedTableId(nextId);
            }}
          >
            {tables.map((t) => {
              const guestCount = tableGuestNames(t.id).length;
              const full = isTableFullForGuest(t.id, guestName);
              return (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {full ? `（已滿 ${guestCount}/${t.capacity}）` : ""}
                </option>
              );
            })}
          </select>
        </div>
      </div>

      {tableFullWarning && (
        <div style={styles.inlineWarnBar}>
          <AlertTriangle size={14} style={{ marginRight: 6, flexShrink: 0 }} />
          {tableFullWarning}
          <button style={styles.linkBtn} onClick={() => setTableFullWarning("")}>
            知道了
          </button>
        </div>
      )}

      <details style={styles.rosterDetails}>
        <summary style={styles.rosterSummary}>
          <Users size={13} /> 查看各桌目前狀況
        </summary>
        <div style={styles.rosterGrid}>
          {tables.map((t) => {
            const guests = tableGuestNames(t.id);
            return (
              <div key={t.id} style={styles.rosterCard}>
                <div style={styles.rosterCardHeader}>
                  <span>{t.name}</span>
                  <span style={styles.mutedTextSmall}>
                    {guests.length}/{t.capacity} 人
                  </span>
                </div>
                {guests.length === 0 ? (
                  <span style={styles.mutedTextSmall}>尚無人點餐</span>
                ) : (
                  <div style={styles.rosterChips}>
                    {guests.map((g) => (
                      <span
                        key={g}
                        style={g === guestName && t.id === selectedTableId ? styles.rosterChipMe : styles.rosterChip}
                      >
                        {g}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </details>

      {config.officialMenuUrl && (
        <a
          href={config.officialMenuUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={styles.menuLinkChip}
        >
          <ExternalLink size={13} /> 查看官方菜單原頁面
        </a>
      )}

      {categories.map((cat) => (
        <div key={cat} style={{ marginBottom: 22 }}>
          <div style={styles.categoryLabel}>{cat}</div>
          <div style={styles.dishGrid}>
            {menuItems
              .filter((i) => (i.category || "其他") === cat)
              .map((item) => (
                <button key={item.id} style={styles.dishCard} onClick={() => handleDishClick(item)}>
                  <span style={styles.dishName}>{item.name}</span>
                  <span style={styles.dishPrice}>{money(item.price)}</span>
                  <span style={styles.dishAdd}>
                    <Plus size={14} />
                  </span>
                </button>
              ))}
          </div>
        </div>
      ))}

      <div style={styles.myOrderCard}>
        <div style={styles.myOrderTitle}>我的點餐（{selectedTableName(tables, selectedTableId)}）</div>
        {myOrders.filter((o) => o.tableId === selectedTableId).length === 0 ? (
          <p style={styles.mutedTextSmall}>還沒有點餐，點上方菜色即可加入。</p>
        ) : (
          <div>
            {myOrders
              .filter((o) => o.tableId === selectedTableId)
              .map((o) => (
                <div key={o.id} style={styles.myOrderRow}>
                  <span style={{ flex: 1 }}>{o.itemName}</span>
                  <span style={styles.qtyStepper}>
                    <button style={styles.stepBtnMinus} onClick={() => changeOrderQty(o.id, -1)}>
                      <Minus size={12} />
                    </button>
                    <span style={styles.qtyNum}>{o.qty}</span>
                    <button style={styles.stepBtnPlus} onClick={() => changeOrderQty(o.id, 1)}>
                      <Plus size={12} />
                    </button>
                  </span>
                  <span style={styles.myOrderPrice}>{money(o.price * o.qty)}</span>
                  <button style={styles.iconBtn} onClick={() => removeOrder(o.id)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            <div style={styles.myOrderTotal}>
              小計{" "}
              {money(
                myOrders
                  .filter((o) => o.tableId === selectedTableId)
                  .reduce((s, o) => s + o.price * o.qty, 0)
              )}
            </div>
          </div>
        )}
      </div>

      {toast && <div style={styles.toast}>{toast}</div>}

      {pendingDupItem && (
        <div style={styles.modalOverlay}>
          <div style={styles.modalCard}>
            <div style={styles.modalTitle}>這桌已經有人點過了</div>
            <p style={styles.mutedText}>
              {selectedTableName(tables, selectedTableId)}已經有其他人點了「{pendingDupItem.name}
              」，要一起再加一份嗎？
            </p>
            <div style={styles.modalBtnRow}>
              <button
                style={styles.secondaryBtn}
                onClick={() => setPendingDupItem(null)}
              >
                取消
              </button>
              <button
                style={styles.primaryBtn}
                onClick={() => {
                  confirmAndAdd(pendingDupItem);
                  setPendingDupItem(null);
                }}
              >
                確認加入
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function selectedTableName(tables, id) {
  return tables.find((t) => t.id === id)?.name || "";
}

/* =================== TABLES TAB =================== */
function TablesTab({
  tables,
  tableOrders,
  tableSubtotal,
  tableGuests,
  config,
  perPersonTotals,
  addTable,
  removeTable,
  updateTableCapacity,
  renameTable,
  changeOrderQty,
  removeOrder,
  removeGuestOrders,
}) {
  const [editingId, setEditingId] = useState(null);
  const [nameDraft, setNameDraft] = useState("");
  const [warnId, setWarnId] = useState(null);
  const [confirmDeleteGuest, setConfirmDeleteGuest] = useState(null); // { tableId, guestName }

  return (
    <div>
      <div style={styles.rowBetween}>
        <h2 style={styles.sectionTitle}>桌次總覽</h2>
        <button style={styles.secondaryBtn} onClick={addTable}>
          <Plus size={14} /> 新增桌次
        </button>
      </div>
      {config.notes && <div style={styles.notesBar}>{config.notes}</div>}
      {config.officialMenuUrl && (
        <a
          href={config.officialMenuUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={styles.menuLinkBar}
        >
          <ExternalLink size={14} />
          <span>官方菜單頁面：{config.officialMenuUrl}</span>
        </a>
      )}
      <div style={styles.ticketGrid}>
        {tables.map((t) => {
          const tOrders = tableOrders(t.id);
          const guests = tableGuests(t.id);
          const sub = tableSubtotal(t.id);
          const fee = sub * (config.serviceChargePercent / 100);
          return (
            <div key={t.id} style={styles.ticket}>
              <div style={styles.ticketHeader}>
                <div style={styles.ticketBadge}>{guests.length}/{t.capacity}人</div>
                {editingId === t.id ? (
                  <input
                    autoFocus
                    style={styles.ticketNameInput}
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onBlur={() => {
                      if (nameDraft.trim()) renameTable(t.id, nameDraft.trim());
                      setEditingId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                    }}
                  />
                ) : (
                  <div
                    style={styles.ticketName}
                    onClick={() => {
                      setEditingId(t.id);
                      setNameDraft(t.name);
                    }}
                  >
                    {t.name} <Edit2 size={11} />
                  </div>
                )}
                <div style={styles.capacityStepper}>
                  <button style={styles.stepBtnSmMinus} onClick={() => updateTableCapacity(t.id, -1)}>
                    <Minus size={11} />
                  </button>
                  <span style={styles.mutedTextSmall}>{t.capacity}位</span>
                  <button style={styles.stepBtnSmPlus} onClick={() => updateTableCapacity(t.id, 1)}>
                    <Plus size={11} />
                  </button>
                </div>
              </div>

              {tOrders.length === 0 ? (
                <p style={styles.mutedTextSmall}>尚無人點餐</p>
              ) : (
                guests.map((g) => {
                  const gOrders = tOrders.filter((o) => o.guestName === g);
                  const gTotal = gOrders.reduce((s, o) => s + o.price * o.qty, 0);
                  const belowMin = config.minSpendPerPerson > 0 && (perPersonTotals[g] || 0) < config.minSpendPerPerson;
                  return (
                    <div key={g} style={styles.guestBlock}>
                      <div style={styles.guestBlockHeader}>
                        <span>{g}</span>
                        <span style={styles.guestBlockRight}>
                          <span style={belowMin ? styles.warnText : styles.mutedTextSmall}>
                            {belowMin && <AlertTriangle size={11} style={{ marginRight: 3 }} />}
                            {money(gTotal)}
                          </span>
                          <button
                            style={styles.iconBtnSm}
                            title={`刪除「${g}」在這桌的所有點餐`}
                            onClick={() => setConfirmDeleteGuest({ tableId: t.id, guestName: g })}
                          >
                            <Trash2 size={12} />
                          </button>
                        </span>
                      </div>
                      {confirmDeleteGuest &&
                        confirmDeleteGuest.tableId === t.id &&
                        confirmDeleteGuest.guestName === g && (
                          <div style={styles.confirmRow}>
                            <span style={styles.warnTextSmall}>
                              <AlertTriangle size={11} /> 確定要刪除「{g}」在這桌的所有點餐嗎？
                            </span>
                            <span style={{ display: "flex", gap: 8 }}>
                              <button
                                style={styles.dangerLinkBtn}
                                onClick={() => {
                                  removeGuestOrders(t.id, g);
                                  setConfirmDeleteGuest(null);
                                }}
                              >
                                確定刪除
                              </button>
                              <button style={styles.linkBtn} onClick={() => setConfirmDeleteGuest(null)}>
                                取消
                              </button>
                            </span>
                          </div>
                        )}
                      {gOrders.map((o) => (
                        <div key={o.id} style={styles.ticketRow}>
                          <span style={{ flex: 1 }}>{o.itemName}</span>
                          <span style={styles.qtyStepper}>
                            <button style={styles.stepBtnSmMinus} onClick={() => changeOrderQty(o.id, -1)}>
                              <Minus size={10} />
                            </button>
                            <span style={styles.qtyNum}>{o.qty}</span>
                            <button style={styles.stepBtnSmPlus} onClick={() => changeOrderQty(o.id, 1)}>
                              <Plus size={10} />
                            </button>
                          </span>
                          <span style={styles.ticketPrice}>{money(o.price * o.qty)}</span>
                          <button style={styles.iconBtnSm} onClick={() => removeOrder(o.id)}>
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  );
                })
              )}

              <div style={styles.ticketDivider} />
              <div style={styles.ticketTotalRow}>
                <span>小計</span>
                <span>{money(sub)}</span>
              </div>
              {config.serviceChargePercent > 0 && (
                <div style={styles.ticketTotalRow}>
                  <span>服務費 {config.serviceChargePercent}%</span>
                  <span>{money(fee)}</span>
                </div>
              )}
              <div style={styles.ticketGrandRow}>
                <span>本桌合計</span>
                <span>{money(sub + fee)}</span>
              </div>

              <div style={styles.ticketFooter}>
                {warnId === t.id ? (
                  <div style={styles.confirmRow}>
                    <span style={styles.mutedTextSmall}>此桌尚有點餐紀錄，無法刪除</span>
                    <button style={styles.linkBtn} onClick={() => setWarnId(null)}>
                      知道了
                    </button>
                  </div>
                ) : (
                  <button
                    style={styles.dangerLinkBtn}
                    onClick={() => {
                      const ok = removeTable(t.id);
                      if (!ok) setWarnId(t.id);
                    }}
                  >
                    <Trash2 size={12} /> 移除桌次
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* =================== SUMMARY TAB =================== */
function SummaryTab({
  tables,
  tableOrders,
  tableSubtotal,
  config,
  grandSubtotal,
  serviceFee,
  grandTotal,
  perPersonTotals,
}) {
  const people = Object.keys(perPersonTotals).sort();
  return (
    <div>
      <h2 style={styles.sectionTitle}>結算總表</h2>

      <div style={styles.grandCard}>
        <div style={styles.grandRow}>
          <span>餐點小計</span>
          <span>{money(grandSubtotal)}</span>
        </div>
        {config.serviceChargePercent > 0 && (
          <div style={styles.grandRow}>
            <span>服務費（{config.serviceChargePercent}%）</span>
            <span>{money(serviceFee)}</span>
          </div>
        )}
        <div style={styles.grandDivider} />
        <div style={styles.grandTotalRow}>
          <span>總金額</span>
          <span>{money(grandTotal)}</span>
        </div>
        {config.minSpendPerPerson > 0 && (
          <div style={styles.minSpendNoteRow}>
            低消每人 {money(config.minSpendPerPerson)}
            {config.minSpendNote ? `・${config.minSpendNote}` : ""}
          </div>
        )}
      </div>

      <h3 style={styles.subTitle}>各桌小計</h3>
      <div style={styles.summaryTable}>
        {tables.map((t) => {
          const sub = tableSubtotal(t.id);
          const fee = sub * (config.serviceChargePercent / 100);
          const count = tableOrders(t.id).reduce((s, o) => s + o.qty, 0);
          return (
            <div key={t.id} style={styles.summaryTableRow}>
              <span style={{ flex: 1 }}>{t.name}</span>
              <span style={styles.mutedTextSmall}>{count} 品項</span>
              <span style={styles.summaryTableAmt}>{money(sub + fee)}</span>
            </div>
          );
        })}
      </div>

      <h3 style={styles.subTitle}>各人小計</h3>
      {people.length === 0 ? (
        <p style={styles.mutedTextSmall}>尚無點餐紀錄</p>
      ) : (
        <div style={styles.summaryTable}>
          {people.map((p) => {
            const belowMin = config.minSpendPerPerson > 0 && perPersonTotals[p] < config.minSpendPerPerson;
            return (
              <div key={p} style={styles.summaryTableRow}>
                <span style={{ flex: 1 }}>{p}</span>
                {belowMin && (
                  <span style={styles.warnTextSmall}>
                    <AlertTriangle size={11} /> 未達低消
                  </span>
                )}
                <span style={styles.summaryTableAmt}>{money(perPersonTotals[p])}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* =================== SETUP TAB =================== */
function SetupTab({
  config,
  saveConfig,
  onTouch,
  menuItems,
  addMenuItem,
  addMenuItemsBulk,
  updateMenuItem,
  deleteMenuItem,
  deleteMenuItems,
  moveMenuItem,
  loadSampleMenu,
  tables,
  addTable,
  removeTable,
  updateTableCapacity,
  renameTable,
  addGuestNameToTable,
  removeGuestNameFromTable,
}) {
  const [draft, setDraft] = useState(config);
  const [savedFlash, setSavedFlash] = useState(false);
  const [newItem, setNewItem] = useState({ name: "", price: "", category: "" });
  const [bulkText, setBulkText] = useState("");
  const [bulkMsg, setBulkMsg] = useState("");
  const [newTableGuestName, setNewTableGuestName] = useState({});
  const [aiFile, setAiFile] = useState(null);
  const [aiExtracting, setAiExtracting] = useState(false);
  const [aiError, setAiError] = useState("");
  const [aiNotice, setAiNotice] = useState("");
  const [aiHint, setAiHint] = useState("");
  const [aiPageRangeInput, setAiPageRangeInput] = useState("");
  const [aiProgress, setAiProgress] = useState(null);
  const [aiResults, setAiResults] = useState(null);
  const [aiFailedRanges, setAiFailedRanges] = useState([]);
  const [selectedMenuIds, setSelectedMenuIds] = useState([]);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [dupWarning, setDupWarning] = useState(null); // { names: string[], onConfirm, onCleanAdd }

  const runAiExtract = async () => {
    if (!aiFile) return;
    setAiExtracting(true);
    setAiError("");
    setAiNotice("");
    setAiProgress(null);
    setAiResults(null);
    setAiFailedRanges([]);
    const manualRanges = parsePageRanges(aiPageRangeInput);
    try {
      const { items, truncated, chunkErrors } = await extractMenuFromFile(
        aiFile,
        aiHint,
        (p) => setAiProgress(p),
        manualRanges.length > 0 ? manualRanges : undefined
      );
      setAiResults(items);
      setAiFailedRanges((chunkErrors || []).map((c) => c.range));
      const notices = [];
      if (manualRanges.length > 0) {
        notices.push(
          `只處理了你指定的頁面（第 ${manualRanges.map((r) => `${r[0]}-${r[1]}`).join("、第")} 頁）。`
        );
      }
      if (items.length > 0) {
        notices.push(`已辨識出 ${items.length} 項，請往下預覽確認。`);
      }
      if (chunkErrors && chunkErrors.length > 0) {
        const rangesText = chunkErrors.map((c) => `第 ${c.range[0]}-${c.range[1]} 頁`).join("、");
        notices.push(`${rangesText} 辨識失敗（${chunkErrors[0].message}），可以按下方「重試失敗的頁面」再試一次。`);
      }
      if (truncated) {
        const lastName = items[items.length - 1]?.name || "";
        notices.push(
          `其中有一份內容較多被截斷；若要繼續，可重新上傳同一份檔案，下方「補充指示」已幫你填好接續辨識的提示。`
        );
        setAiHint(
          `請跳過「${lastName}」（含）之前已辨識過的品項，直接從它後面的下一項開始辨識到底。`
        );
      } else if (!chunkErrors || chunkErrors.length === 0) {
        setAiHint("");
      }
      if (items.length === 0 && (!chunkErrors || chunkErrors.length === 0)) {
        setAiError("沒有辨識出任何品項，可以換一張更清楚的圖片，或改用下方「批次貼上菜單」手動輸入。");
      } else {
        setAiNotice(notices.join(" "));
      }
    } catch (e) {
      setAiError(
        `辨識失敗：${e?.message || "未知錯誤"}。可以換一張更清楚的圖片再試一次，或改用下方「批次貼上菜單」手動輸入。`
      );
    } finally {
      setAiExtracting(false);
      setAiProgress(null);
    }
  };

  const retryFailedRanges = async () => {
    if (!aiFile || aiFailedRanges.length === 0) return;
    setAiExtracting(true);
    setAiError("");
    setAiProgress(null);
    try {
      const { items, chunkErrors } = await extractMenuFromFile(aiFile, aiHint, (p) => setAiProgress(p), aiFailedRanges);
      setAiResults((prev) => [...(prev || []), ...items]);
      setAiFailedRanges((chunkErrors || []).map((c) => c.range));
      if (chunkErrors && chunkErrors.length > 0) {
        const rangesText = chunkErrors.map((c) => `第 ${c.range[0]}-${c.range[1]} 頁`).join("、");
        setAiNotice(
          `重試後新增了 ${items.length} 項；${rangesText} 仍然失敗（${chunkErrors[0].message}），可以再試一次或改用截圖上傳那幾頁。`
        );
      } else {
        setAiNotice(`重試成功，新增了 ${items.length} 項，剛才失敗的頁面都補上了。`);
      }
    } catch (e) {
      setAiError(`重試失敗：${e?.message || "未知錯誤"}`);
    } finally {
      setAiExtracting(false);
      setAiProgress(null);
    }
  };

  const commitAiResults = (items) => {
    addMenuItemsBulk(items.map((it) => ({ name: it.name, price: it.price, category: it.category })));
    setAiResults(null);
    setAiFile(null);
    setAiNotice("");
    setAiFailedRanges([]);
  };

  const confirmAiResults = () => {
    if (!aiResults?.length) return;
    const dups = findDuplicateItems(aiResults, menuItems);
    if (dups.length > 0) {
      setDupWarning({
        names: dups.map((d) => d.name),
        onClean: () => {
          const dupNameSet = new Set(dups.map((d) => normalizeName(d.name)));
          commitAiResults(aiResults.filter((it) => !dupNameSet.has(normalizeName(it.name))));
          setDupWarning(null);
        },
        onConfirm: () => {
          commitAiResults(aiResults);
          setDupWarning(null);
        },
      });
      return;
    }
    commitAiResults(aiResults);
  };

  useEffect(() => setDraft(config), [config]);

  const handleField = (field, value) => {
    onTouch();
    setDraft((d) => ({ ...d, [field]: value }));
  };

  const handleSave = async () => {
    await saveConfig(draft);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1600);
  };

  return (
    <div>
      <section style={styles.setupSection}>
        <h2 style={styles.sectionTitle}>活動資訊</h2>
        <div style={styles.formGrid}>
          <label style={styles.formLabel}>
            餐廳名稱
            <input
              style={styles.input}
              value={draft.restaurantName}
              onChange={(e) => handleField("restaurantName", e.target.value)}
              placeholder="例如：樂天皇朝 - 新莊店"
            />
          </label>
          <label style={styles.formLabel}>
            服務費（%）
            <input
              type="number"
              style={styles.input}
              value={draft.serviceChargePercent}
              onChange={(e) => handleField("serviceChargePercent", Number(e.target.value) || 0)}
              placeholder="0"
            />
          </label>
          <label style={styles.formLabel}>
            低消（每人，NT$）
            <input
              type="number"
              style={styles.input}
              value={draft.minSpendPerPerson}
              onChange={(e) => handleField("minSpendPerPerson", Number(e.target.value) || 0)}
              placeholder="0 表示無低消"
            />
          </label>
          <label style={styles.formLabel}>
            低消補充說明
            <input
              style={styles.input}
              value={draft.minSpendNote}
              onChange={(e) => handleField("minSpendNote", e.target.value)}
              placeholder="例如：可用飲品折抵"
            />
          </label>
        </div>
        <label style={styles.formLabel}>
          公告備註（顯示在頁面上方）
          <textarea
            style={styles.textarea}
            value={draft.notes}
            onChange={(e) => handleField("notes", e.target.value)}
            placeholder="例如：6/20 (五) 19:00 入座，遲到超過15分鐘視同棄權"
          />
        </label>

        <label style={styles.formLabel}>
          官方菜單網址（會顯示在「桌次總覽」上方，方便大家點擊查看）
          <input
            style={styles.input}
            value={draft.officialMenuUrl}
            onChange={(e) => handleField("officialMenuUrl", e.target.value)}
            placeholder="https://..."
          />
        </label>

        <button style={styles.primaryBtn} onClick={handleSave}>
          {savedFlash ? (
            <>
              <Check size={14} /> 已儲存
            </>
          ) : (
            "儲存活動設定"
          )}
        </button>
      </section>

      <section style={styles.setupSection}>
        <div style={styles.rowBetween}>
          <h2 style={styles.sectionTitle}>菜單管理</h2>
          <button style={styles.secondaryBtn} onClick={loadSampleMenu}>
            載入範例菜色
          </button>
        </div>

        <div style={styles.aiBox}>
          <div style={styles.aiBoxHeader}>
            <Sparkles size={15} />
            <span>AI 智慧讀取菜單（上傳 PDF 或照片）</span>
          </div>
          <p style={styles.mutedTextSmall}>
            上傳菜單的 PDF 檔或拍照／截圖，AI 會自動辨識品名與價格；頁數較多的 PDF 會自動拆成小份分批處理再合併結果，讀取完成後可先預覽再決定要不要加入菜單。
          </p>
          <div style={styles.aiUploadRow}>
            <label style={styles.uploadLabel}>
              <Upload size={14} />
              {aiFile ? aiFile.name : "選擇檔案"}
              <input
                type="file"
                accept="application/pdf,image/*"
                style={{ display: "none" }}
                onChange={(e) => {
                  setAiFile(e.target.files?.[0] || null);
                  setAiResults(null);
                  setAiError("");
                  setAiNotice("");
                  setAiFailedRanges([]);
                }}
              />
            </label>
            <button style={styles.primaryBtn} disabled={!aiFile || aiExtracting} onClick={runAiExtract}>
              {aiExtracting ? (
                <>
                  <Loader2 size={14} className="spin" />
                  {aiProgress && aiProgress.total > 1
                    ? `辨識中…（第 ${aiProgress.current}/${aiProgress.total} 批${
                        aiProgress.pageRange ? `，第 ${aiProgress.pageRange[0]}-${aiProgress.pageRange[1]} 頁` : ""
                      }）`
                    : "辨識中…"}
                </>
              ) : (
                "開始辨識"
              )}
            </button>
          </div>
          {aiProgress && aiProgress.total > 1 && (
            <p style={styles.mutedTextSmall}>
              頁數較多的 PDF 會自動拆成 {aiProgress.total} 批分別辨識，完成後自動合併結果，稍等一下。
            </p>
          )}
          <label style={styles.formLabel}>
            指定要辨識的頁碼範圍（選填，例如：13-18, 25-30, 37-42；留空 = 辨識全部頁面）
            <input
              style={styles.input}
              value={aiPageRangeInput}
              onChange={(e) => setAiPageRangeInput(e.target.value)}
              placeholder="例如：13-18, 25-30, 37-42"
            />
          </label>
          <label style={styles.formLabel}>
            補充指示（選填，額外的辨識提示，不會限制頁碼，例如：「跳過飲料類」）
            <input
              style={styles.input}
              value={aiHint}
              onChange={(e) => setAiHint(e.target.value)}
              placeholder="例如：跳過飲料類"
            />
          </label>
          {aiError && (
            <p style={styles.warnText}>
              <AlertTriangle size={13} style={{ marginRight: 4 }} /> {aiError}
            </p>
          )}
          {aiNotice && (
            <p style={styles.noticeText}>
              <AlertTriangle size={13} style={{ marginRight: 4 }} /> {aiNotice}
            </p>
          )}
          {aiFailedRanges.length > 0 && (
            <div style={styles.inlineForm}>
              <button style={styles.secondaryBtn} disabled={aiExtracting} onClick={retryFailedRanges}>
                {aiExtracting ? (
                  <>
                    <Loader2 size={14} className="spin" /> 重試中…
                  </>
                ) : (
                  <>
                    <RefreshCw size={13} /> 重試失敗的頁面（
                    {aiFailedRanges.map((r) => `${r[0]}-${r[1]}`).join("、")}）
                  </>
                )}
              </button>
            </div>
          )}
          {aiResults?.length > 0 && (
            <div style={styles.aiPreview}>
              <div style={styles.mutedTextSmall}>
                <FileText size={12} style={{ verticalAlign: "-2px" }} /> 辨識到 {aiResults.length} 項，確認無誤後再加入：
              </div>
              <div style={styles.menuListWrap}>
                {aiResults.map((item) => (
                  <div key={item.id} style={styles.menuListRow}>
                    <input
                      style={styles.menuListInput}
                      value={item.name}
                      onChange={(e) =>
                        setAiResults((list) =>
                          list.map((r) => (r.id === item.id ? { ...r, name: e.target.value } : r))
                        )
                      }
                    />
                    <input
                      style={styles.menuListInputSm}
                      type="number"
                      value={item.price}
                      onChange={(e) =>
                        setAiResults((list) =>
                          list.map((r) => (r.id === item.id ? { ...r, price: Number(e.target.value) || 0 } : r))
                        )
                      }
                    />
                    <input
                      style={styles.menuListInputSm}
                      value={item.category}
                      onChange={(e) =>
                        setAiResults((list) =>
                          list.map((r) => (r.id === item.id ? { ...r, category: e.target.value } : r))
                        )
                      }
                    />
                    <button
                      style={styles.iconBtn}
                      onClick={() => setAiResults((list) => list.filter((r) => r.id !== item.id))}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <div style={styles.inlineForm}>
                <button style={styles.primaryBtn} onClick={confirmAiResults}>
                  <Check size={14} /> 加入這 {aiResults.length} 項到菜單
                </button>
                <button
                  style={styles.secondaryBtn}
                  onClick={() => {
                    setAiResults(null);
                    setAiFile(null);
                    setAiFailedRanges([]);
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          )}
          <p style={styles.mutedTextSmall}>
            小提醒：若是網路上的菜單網址而不是檔案，先把網頁另存或截圖下來再上傳；若辨識效果不理想，也可以直接把菜單網址貼給 Claude 聊天視窗，請它幫你整理成「批次貼上菜單」的格式。
          </p>
        </div>

        <div style={styles.formGridThree}>
          <input
            style={styles.input}
            placeholder="品名"
            value={newItem.name}
            onChange={(e) => setNewItem((v) => ({ ...v, name: e.target.value }))}
          />
          <input
            style={styles.input}
            placeholder="價格"
            type="number"
            value={newItem.price}
            onChange={(e) => setNewItem((v) => ({ ...v, price: e.target.value }))}
          />
          <input
            style={styles.input}
            placeholder="分類（例如：點心）"
            value={newItem.category}
            onChange={(e) => setNewItem((v) => ({ ...v, category: e.target.value }))}
          />
        </div>
        <button
          style={styles.secondaryBtn}
          onClick={() => {
            if (!newItem.name.trim() || !newItem.price) return;
            const candidate = {
              name: newItem.name.trim(),
              price: Number(newItem.price),
              category: newItem.category.trim() || "其他",
            };
            const dups = findDuplicateItems([candidate], menuItems);
            if (dups.length > 0) {
              setDupWarning({
                names: [candidate.name],
                cleanLabel: "取消新增",
                confirmLabel: "仍要新增",
                onConfirm: () => {
                  addMenuItem(candidate);
                  setNewItem({ name: "", price: "", category: "" });
                  setDupWarning(null);
                },
                onClean: () => {
                  // "clean" for a single item just means don't add it
                  setNewItem({ name: "", price: "", category: "" });
                  setDupWarning(null);
                },
              });
              return;
            }
            addMenuItem(candidate);
            setNewItem({ name: "", price: "", category: "" });
          }}
        >
          <Plus size={14} /> 新增菜色
        </button>

        <div style={styles.menuListWrap}>
          {menuItems.length === 0 ? (
            <p style={styles.mutedTextSmall}>尚未新增任何菜色</p>
          ) : (
            <>
              <div style={styles.bulkToolbar}>
                <label style={styles.bulkSelectAll}>
                  <input
                    type="checkbox"
                    checked={selectedMenuIds.length > 0 && selectedMenuIds.length === menuItems.length}
                    onChange={(e) => {
                      setSelectedMenuIds(e.target.checked ? menuItems.map((i) => i.id) : []);
                      setConfirmBulkDelete(false);
                    }}
                  />
                  <span style={styles.mutedTextSmall}>
                    {selectedMenuIds.length > 0 ? `已選 ${selectedMenuIds.length} 項` : "全選"}
                  </span>
                </label>
                {selectedMenuIds.length > 0 &&
                  (confirmBulkDelete ? (
                    <span style={styles.confirmRow}>
                      <span style={styles.warnTextSmall}>
                        <AlertTriangle size={11} /> 確定刪除這 {selectedMenuIds.length} 項？
                      </span>
                      <button
                        style={styles.dangerLinkBtn}
                        onClick={() => {
                          deleteMenuItems(selectedMenuIds);
                          setSelectedMenuIds([]);
                          setConfirmBulkDelete(false);
                        }}
                      >
                        確定刪除
                      </button>
                      <button style={styles.linkBtn} onClick={() => setConfirmBulkDelete(false)}>
                        取消
                      </button>
                    </span>
                  ) : (
                    <button style={styles.dangerLinkBtn} onClick={() => setConfirmBulkDelete(true)}>
                      <Trash2 size={12} /> 刪除已選項目
                    </button>
                  ))}
              </div>
              {menuItems.map((item, idx) => (
                <div key={item.id} style={styles.menuListRow}>
                  <input
                    type="checkbox"
                    checked={selectedMenuIds.includes(item.id)}
                    onChange={(e) => {
                      setConfirmBulkDelete(false);
                      setSelectedMenuIds((ids) =>
                        e.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id)
                      );
                    }}
                  />
                  <span style={styles.reorderBtns}>
                    <button
                      style={styles.stepBtnSmPlus}
                      disabled={idx === 0}
                      onClick={() => moveMenuItem(item.id, "up")}
                      title="上移"
                    >
                      <ChevronUp size={12} />
                    </button>
                    <button
                      style={styles.stepBtnSmMinus}
                      disabled={idx === menuItems.length - 1}
                      onClick={() => moveMenuItem(item.id, "down")}
                      title="下移"
                    >
                      <ChevronDown size={12} />
                    </button>
                  </span>
                  <input
                    style={styles.menuListInput}
                    value={item.name}
                    onChange={(e) => updateMenuItem(item.id, { name: e.target.value })}
                  />
                  <input
                    style={styles.menuListInputSm}
                    type="number"
                    value={item.price}
                    onChange={(e) => updateMenuItem(item.id, { price: Number(e.target.value) || 0 })}
                  />
                  <input
                    style={styles.menuListInputSm}
                    value={item.category}
                    onChange={(e) => updateMenuItem(item.id, { category: e.target.value })}
                  />
                  <button
                    style={styles.iconBtn}
                    onClick={() => {
                      deleteMenuItem(item.id);
                      setSelectedMenuIds((ids) => ids.filter((id) => id !== item.id));
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </>
          )}
        </div>

        <label style={styles.formLabel}>
          批次貼上菜單（每行只要「品名」加「金額」即可，中間格式不拘：空格、$、|、逗號都可以；用 # 開頭可切分類）
          <textarea
            style={styles.textarea}
            rows={5}
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            placeholder={"#點心\n小籠包 220\n蝦餃皇 (5PC) $200\n#飲料\n烏龍茶 |120"}
          />
        </label>
        <button
          style={styles.secondaryBtn}
          onClick={() => {
            const parsed = parseMenuText(bulkText);
            if (parsed.length === 0) {
              setBulkMsg("沒有偵測到可用的資料格式");
              setTimeout(() => setBulkMsg(""), 3000);
              return;
            }
            const dups = findDuplicateItems(parsed, menuItems);
            const commit = (items) => {
              addMenuItemsBulk(items);
              setBulkMsg(`已新增 ${items.length} 項菜色`);
              setBulkText("");
              setTimeout(() => setBulkMsg(""), 3000);
            };
            if (dups.length > 0) {
              setDupWarning({
                names: dups.map((d) => d.name),
                onClean: () => {
                  const dupNameSet = new Set(dups.map((d) => normalizeName(d.name)));
                  commit(parsed.filter((it) => !dupNameSet.has(normalizeName(it.name))));
                  setDupWarning(null);
                },
                onConfirm: () => {
                  commit(parsed);
                  setDupWarning(null);
                },
              });
              return;
            }
            commit(parsed);
          }}
        >
          批次加入
        </button>
        {bulkMsg && <span style={styles.mutedTextSmall}> {bulkMsg}</span>}
      </section>

      <section style={styles.setupSection}>
        <div style={styles.rowBetween}>
          <h2 style={styles.sectionTitle}>桌次設定</h2>
          <button style={styles.secondaryBtn} onClick={addTable}>
            <Plus size={14} /> 新增桌次
          </button>
        </div>
        <div style={styles.menuListWrap}>
          {tables.map((t) => (
            <div key={t.id} style={styles.tableSetupBlock}>
              <div style={styles.menuListRow}>
                <input
                  style={styles.menuListInput}
                  value={t.name}
                  onChange={(e) => renameTable(t.id, e.target.value)}
                />
                <span style={styles.capacityStepper}>
                  <button style={styles.stepBtnSmMinus} onClick={() => updateTableCapacity(t.id, -1)}>
                    <Minus size={11} />
                  </button>
                  <span style={styles.mutedTextSmall}>{t.capacity}位</span>
                  <button style={styles.stepBtnSmPlus} onClick={() => updateTableCapacity(t.id, 1)}>
                    <Plus size={11} />
                  </button>
                </span>
                <button style={styles.iconBtn} onClick={() => removeTable(t.id)}>
                  <Trash2 size={14} />
                </button>
              </div>
              <div style={styles.tableRosterRow}>
                <span style={styles.mutedTextSmall}>指定人員：</span>
                {(t.guestNames || []).length === 0 ? (
                  <span style={styles.mutedTextSmall}>尚未指定，點餐時可自由輸入暱稱</span>
                ) : (
                  <div style={styles.rosterChips}>
                    {(t.guestNames || []).map((n) => (
                      <span key={n} style={styles.rosterChip}>
                        {n}
                        <button
                          style={styles.rosterChipRemove}
                          onClick={() => removeGuestNameFromTable(t.id, n)}
                        >
                          <X size={10} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <input
                  style={styles.tableRosterInput}
                  placeholder="新增人員暱稱"
                  value={newTableGuestName[t.id] || ""}
                  onChange={(e) => setNewTableGuestName((v) => ({ ...v, [t.id]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newTableGuestName[t.id]?.trim()) {
                      addGuestNameToTable(t.id, newTableGuestName[t.id]);
                      setNewTableGuestName((v) => ({ ...v, [t.id]: "" }));
                    }
                  }}
                />
                <button
                  style={styles.iconBtn}
                  onClick={() => {
                    if (newTableGuestName[t.id]?.trim()) {
                      addGuestNameToTable(t.id, newTableGuestName[t.id]);
                      setNewTableGuestName((v) => ({ ...v, [t.id]: "" }));
                    }
                  }}
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
        <p style={styles.mutedTextSmall}>
          有指定人員名單的桌次，點餐時暱稱必須跟名單裡的其中一個完全相同才能點餐；沒有指定名單的桌次可以自由輸入暱稱。
        </p>
      </section>

      <p style={styles.mutedTextSmall}>
        <ChevronRight size={12} style={{ verticalAlign: "-1px" }} /> 這裡的資料所有使用同一個網址的人都能看到，換下一場聚餐時直接覆寫餐廳名稱、服務費與菜單即可重複使用。
      </p>

      {dupWarning && (
        <div style={styles.modalOverlay}>
          <div style={styles.modalCard}>
            <div style={styles.modalTitle}>
              {dupWarning.names.length === 1 ? "菜單裡已經有這道菜了" : `菜單裡已經有 ${dupWarning.names.length} 道相同名稱的菜`}
            </div>
            <div style={styles.modalDupList}>
              {dupWarning.names.map((n, i) => (
                <div key={i}>{n}</div>
              ))}
            </div>
            <p style={styles.mutedTextSmall}>要跳過重複的，還是不管重複、照樣加入？</p>
            <div style={styles.modalBtnRow}>
              <button style={styles.secondaryBtn} onClick={dupWarning.onClean}>
                {dupWarning.cleanLabel || "刪除重複後加入"}
              </button>
              <button style={styles.primaryBtn} onClick={dupWarning.onConfirm}>
                {dupWarning.confirmLabel || "確認加入"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* =================== styles & fonts =================== */

const FONT = {
  display: "'Noto Serif TC', serif",
  body: "'Noto Sans TC', sans-serif",
  mono: "'Roboto Mono', monospace",
};

const COLORS = {
  paper: "#FAF3EF",
  paperDeep: "#F1E1DC",
  ink: "#3B322F",
  inkSoft: "#8C7B76",
  jade: "#B76E7A",
  jadeDeep: "#8E4E5A",
  accent: "#B76E7A",
  accentDeep: "#8E4E5A",
  red: "#A6525F",
  redSoft: "#E7D3CE",
  line: "#E6D6CD",
  blue: "#7C9CB8",
  blueSoft: "#DCE7F0",
};

function FontStyles() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@500;700;900&family=Noto+Sans+TC:wght@400;500;700&family=Roboto+Mono:wght@400;500;700&display=swap');
      html, body { min-height: 100%; background: ${COLORS.paper}; margin: 0; }
      * { -webkit-tap-highlight-color: transparent; }
      .spin { animation: goa-spin 1s linear infinite; color: ${COLORS.jade}; }
      @keyframes goa-spin { to { transform: rotate(360deg); } }
      .goa-navbtn { -webkit-tap-highlight-color: transparent; -webkit-user-select: none; user-select: none; touch-action: manipulation; outline: none; }
      .goa-navbtn:not(.goa-navbtn-active):hover { background: ${COLORS.paperDeep} !important; }
      .goa-navbtn:not(.goa-navbtn-active):active { background: ${COLORS.paperDeep} !important; }
      .goa-navbtn-active:active { background: ${COLORS.jadeDeep} !important; }
      .goa-navbtn:focus-visible { outline: 2px solid ${COLORS.jade}; outline-offset: -2px; }
      .goa-shell button, .goa-shell a { -webkit-tap-highlight-color: transparent; outline: none; }
      .goa-shell button:focus-visible, .goa-shell a:focus-visible { outline: 2px solid ${COLORS.jade}; outline-offset: 2px; }
      .goa-shell input, .goa-shell textarea, .goa-shell select { font-family: ${FONT.body}; }
      .goa-shell ::placeholder { color: #9C9483; }
      .goa-shell button { font-family: ${FONT.body}; cursor: pointer; }
      .goa-shell button:disabled { opacity: 0.4; cursor: not-allowed; }
      details > summary { cursor: pointer; }
      details > summary::-webkit-details-marker { display: none; }
      @media (max-width: 820px) {
        .goa-shell { flex-direction: column; }
        .goa-sidebar {
          position: fixed !important; bottom: 0; left: 0; right: 0; top: auto !important;
          width: 100% !important; height: auto !important; flex-direction: row !important;
          padding: 8px 10px !important; border-right: none !important;
          border-top: 1px solid ${COLORS.line} !important; z-index: 30;
        }
        .goa-brand { display: none !important; }
        .goa-navlist { flex-direction: row !important; flex: 1; gap: 4px !important; }
        .goa-navbtn { flex-direction: column !important; flex: 1; padding: 6px 2px !important; font-size: 12.5px !important; gap: 2px !important; }
        .goa-sync { display: none !important; }
        .goa-mainarea { padding-bottom: 78px !important; }
      }
    `}</style>
  );
}

const styles = {
  loadingWrap: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 320,
    color: COLORS.inkSoft,
    fontFamily: FONT.body,
  },
  shell: {
    display: "flex",
    minHeight: "100vh",
    background: COLORS.paper,
    color: COLORS.ink,
    fontFamily: FONT.body,
  },
  sidebar: {
    width: 208,
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    background: COLORS.paperDeep,
    borderRight: `1px solid ${COLORS.line}`,
    padding: "18px 14px",
    gap: 22,
  },
  brand: { display: "flex", alignItems: "center", justifyContent: "center", gap: 10 },
  brandStamp: {
    width: 34,
    height: 34,
    borderRadius: "50%",
    background: COLORS.red,
    color: "#FBF3EF",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: FONT.display,
    fontWeight: 900,
    fontSize: 16.5,
    flexShrink: 0,
  },
  brandTitle: { fontFamily: FONT.display, fontWeight: 700, fontSize: 15.5, lineHeight: 1.2 },
  brandSub: { fontSize: 12, color: COLORS.inkSoft, letterSpacing: 1 },
  navList: { display: "flex", flexDirection: "column", gap: 4, flex: 1 },
  navBtn: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "9px 10px",
    borderRadius: 8,
    border: "none",
    background: "transparent",
    color: COLORS.inkSoft,
    fontSize: 14.5,
    fontWeight: 500,
    textAlign: "left",
  },
  navBtnActive: { background: COLORS.jade, color: "#FBF3EF" },
  syncRow: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    fontSize: 11.5,
    color: "#9C9483",
    fontFamily: FONT.mono,
  },
  mainArea: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column" },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    padding: "22px 28px 14px",
    gap: 12,
    flexWrap: "wrap",
  },
  headerEyebrow: {
    fontSize: 12,
    letterSpacing: 2,
    color: COLORS.jade,
    fontWeight: 700,
    marginBottom: 2,
  },
  headerTitle: { fontFamily: FONT.display, fontWeight: 700, fontSize: 26, margin: 0, color: COLORS.ink },
  feeBadgeWrap: { display: "flex", alignItems: "center", gap: 10 },
  feeStamp: {
    width: 62,
    height: 62,
    borderRadius: "50%",
    border: `2.5px solid ${COLORS.red}`,
    color: COLORS.red,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    transform: "rotate(-8deg)",
    background: "rgba(166,82,95,0.07)",
  },
  feeStampPercent: { fontFamily: FONT.mono, fontWeight: 700, fontSize: 15.5, lineHeight: 1 },
  feeStampLabel: { fontSize: 10, marginTop: 2 },
  minSpendTag: {
    fontSize: 12.5,
    background: COLORS.ink,
    color: COLORS.paper,
    padding: "6px 10px",
    borderRadius: 20,
    fontFamily: FONT.mono,
  },
  notesBar: {
    margin: "0 0 16px",
    padding: "10px 14px",
    background: "rgba(183,110,122,0.10)",
    borderLeft: `3px solid ${COLORS.jade}`,
    fontSize: 13.5,
    color: COLORS.jadeDeep,
    borderRadius: 4,
    whiteSpace: "pre-line",
    lineHeight: 1.6,
  },
  syncErrorBar: {
    margin: "0 28px 10px",
    padding: "8px 14px",
    display: "flex",
    alignItems: "center",
    background: "rgba(166,82,95,0.12)",
    borderLeft: `3px solid ${COLORS.red}`,
    fontSize: 13.5,
    color: COLORS.red,
    borderRadius: 4,
  },
  inlineWarnBar: {
    margin: "0 0 16px",
    padding: "10px 14px",
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
    background: "rgba(166,82,95,0.12)",
    borderLeft: `3px solid ${COLORS.red}`,
    fontSize: 13.5,
    color: COLORS.red,
    borderRadius: 4,
  },
  content: { padding: "6px 28px 40px", flex: 1 },
  sectionTitle: { fontFamily: FONT.display, fontWeight: 700, fontSize: 19.5, margin: "6px 0 14px", color: COLORS.ink },
  subTitle: { fontFamily: FONT.display, fontWeight: 700, fontSize: 15.5, margin: "22px 0 8px", color: COLORS.ink },
  mutedText: { color: COLORS.inkSoft, fontSize: 14.5, lineHeight: 1.6 },
  mutedTextSmall: { color: COLORS.inkSoft, fontSize: 13 },
  warnText: { color: COLORS.red, fontSize: 13, display: "flex", alignItems: "center" },
  noticeText: { color: COLORS.accentDeep, fontSize: 13, display: "flex", alignItems: "center" },
  warnTextSmall: { color: COLORS.red, fontSize: 12, display: "flex", alignItems: "center", gap: 3 },

  loginCard: {
    maxWidth: 380,
    margin: "40px auto",
    textAlign: "center",
    background: "#fff",
    border: `1px solid ${COLORS.line}`,
    borderRadius: 14,
    padding: "30px 24px",
  },
  loginStamp: {
    width: 46,
    height: 46,
    margin: "0 auto 14px",
    borderRadius: "50%",
    background: COLORS.jade,
    color: "#FBF3EF",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: FONT.display,
    fontWeight: 700,
    fontSize: 18.5,
  },
  inlineForm: { display: "flex", gap: 8, marginTop: 14 },
  input: {
    flex: 1,
    padding: "9px 11px",
    borderRadius: 8,
    border: `1px solid ${COLORS.line}`,
    fontSize: 14.5,
    background: "#fff",
    color: COLORS.ink,
    outline: "none",
  },
  select: {
    padding: "7px 9px",
    borderRadius: 8,
    border: `1px solid ${COLORS.line}`,
    fontSize: 14,
    background: "#fff",
    color: COLORS.ink,
  },
  primaryBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "10px 18px",
    borderRadius: 8,
    border: "none",
    background: COLORS.jade,
    color: "#FBF3EF",
    fontSize: 14.5,
    fontWeight: 600,
    marginTop: 10,
  },
  secondaryBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "8px 13px",
    borderRadius: 8,
    border: `1px solid ${COLORS.jade}`,
    background: "transparent",
    color: COLORS.jadeDeep,
    fontSize: 13.5,
    fontWeight: 600,
    marginTop: 8,
  },
  linkBtn: {
    border: "none",
    background: "none",
    color: COLORS.jade,
    fontSize: 13,
    textDecoration: "underline",
    padding: 0,
  },
  dangerLinkBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    border: "none",
    background: "none",
    color: COLORS.red,
    fontSize: 12.5,
    padding: 0,
  },
  iconBtn: {
    border: "none",
    background: "transparent",
    color: COLORS.inkSoft,
    padding: 4,
    display: "flex",
  },
  iconBtnSm: {
    border: "none",
    background: "transparent",
    color: "#B0A98F",
    padding: 2,
    display: "flex",
  },
  emptyState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 10,
    padding: "50px 0",
    color: COLORS.inkSoft,
  },
  guestBar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 10,
    padding: "10px 14px",
    background: "#fff",
    border: `1px solid ${COLORS.line}`,
    borderRadius: 10,
    marginBottom: 18,
    fontSize: 14.5,
  },
  tableSelectWrap: { display: "flex", alignItems: "center", gap: 6 },
  menuLinkChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 13.5,
    color: COLORS.accentDeep,
    background: "#fff",
    border: `1px solid ${COLORS.line}`,
    borderRadius: 20,
    padding: "6px 12px",
    marginBottom: 18,
    textDecoration: "none",
  },
  rosterDetails: {
    marginBottom: 18,
    background: "#fff",
    border: `1px solid ${COLORS.line}`,
    borderRadius: 10,
    padding: "10px 14px",
  },
  rosterSummary: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 13,
    color: COLORS.accentDeep,
    fontWeight: 600,
  },
  rosterGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
    gap: 10,
    marginTop: 12,
  },
  rosterCard: {
    background: COLORS.paper,
    border: `1px solid ${COLORS.paperDeep}`,
    borderRadius: 8,
    padding: "8px 10px",
  },
  tablePickCard: {
    background: "#fff",
    border: `1px solid ${COLORS.line}`,
    borderRadius: 10,
    padding: "10px 12px",
    cursor: "pointer",
  },
  tablePickCardActive: {
    background: "#fff",
    border: `2px solid ${COLORS.accent}`,
    borderRadius: 10,
    padding: "9px 11px",
    cursor: "pointer",
    boxShadow: "0 2px 8px rgba(183,110,122,0.15)",
  },
  rosterCardHeader: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: 12.5,
    fontWeight: 700,
    color: COLORS.ink,
    marginBottom: 6,
  },
  rosterChips: { display: "flex", flexWrap: "wrap", gap: 5 },
  rosterChip: {
    fontSize: 11.5,
    background: "#fff",
    border: `1px solid ${COLORS.line}`,
    borderRadius: 12,
    padding: "2px 8px",
    color: COLORS.inkSoft,
  },
  rosterChipRemove: {
    border: "none",
    background: "none",
    padding: 0,
    marginLeft: 5,
    color: COLORS.inkSoft,
    display: "inline-flex",
    verticalAlign: "-1px",
  },
  tableSetupBlock: {
    border: `1px solid ${COLORS.paperDeep}`,
    borderRadius: 8,
    padding: "10px 10px 12px",
  },
  tableRosterRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
    marginTop: 8,
    paddingTop: 8,
    borderTop: `1px dashed ${COLORS.paperDeep}`,
  },
  tableRosterInput: {
    flex: 1,
    minWidth: 100,
    padding: "5px 9px",
    borderRadius: 6,
    border: `1px solid ${COLORS.line}`,
    fontSize: 12.5,
  },
  rosterChipMe: {
    fontSize: 11.5,
    background: COLORS.accent,
    border: `1px solid ${COLORS.accentDeep}`,
    borderRadius: 12,
    padding: "2px 8px",
    color: "#fff",
    fontWeight: 600,
  },
  menuLinkBar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13.5,
    color: COLORS.accentDeep,
    background: "#fff",
    border: `1px solid ${COLORS.line}`,
    borderRadius: 8,
    padding: "10px 14px",
    marginTop: 10,
    marginBottom: 4,
    textDecoration: "none",
    overflowWrap: "anywhere",
  },
  categoryLabel: {
    fontFamily: FONT.display,
    fontWeight: 700,
    fontSize: 14.5,
    color: COLORS.jadeDeep,
    marginBottom: 8,
    paddingBottom: 4,
    borderBottom: `1.5px dashed ${COLORS.line}`,
  },
  dishGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 10 },
  dishCard: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 4,
    padding: "12px 14px",
    background: "#fff",
    border: `1px solid ${COLORS.line}`,
    borderRadius: 10,
    textAlign: "left",
    position: "relative",
  },
  dishName: { fontSize: 14.5, fontWeight: 500, color: COLORS.ink },
  dishPrice: { fontSize: 13.5, fontFamily: FONT.mono, color: COLORS.inkSoft },
  dishAdd: {
    position: "absolute",
    top: 10,
    right: 10,
    width: 22,
    height: 22,
    borderRadius: "50%",
    background: COLORS.jade,
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  myOrderCard: {
    marginTop: 26,
    background: "#fff",
    border: `1.5px dashed ${COLORS.jade}`,
    borderRadius: 12,
    padding: "16px 18px",
  },
  myOrderTitle: { fontFamily: FONT.display, fontWeight: 700, fontSize: 15, marginBottom: 10, color: COLORS.jadeDeep },
  myOrderRow: { display: "flex", alignItems: "center", gap: 10, padding: "6px 0", fontSize: 14, borderBottom: `1px solid ${COLORS.paperDeep}` },
  myOrderPrice: { fontFamily: FONT.mono, fontSize: 13.5, width: 64, textAlign: "right" },
  myOrderTotal: { textAlign: "right", fontFamily: FONT.mono, fontWeight: 700, fontSize: 14.5, marginTop: 8, color: COLORS.jadeDeep },
  qtyStepper: { display: "flex", alignItems: "center", gap: 6 },
  stepBtn: { width: 22, height: 22, borderRadius: 6, border: `1px solid ${COLORS.line}`, background: "#fff", display: "flex", alignItems: "center", justifyContent: "center" },
  stepBtnSm: { width: 18, height: 18, borderRadius: 5, border: `1px solid ${COLORS.line}`, background: "#fff", display: "flex", alignItems: "center", justifyContent: "center" },
  stepBtnPlus: { width: 22, height: 22, borderRadius: 6, border: `1px solid ${COLORS.redSoft}`, background: COLORS.redSoft, color: COLORS.accentDeep, display: "flex", alignItems: "center", justifyContent: "center" },
  stepBtnMinus: { width: 22, height: 22, borderRadius: 6, border: `1px solid ${COLORS.blueSoft}`, background: COLORS.blueSoft, color: "#4E7290", display: "flex", alignItems: "center", justifyContent: "center" },
  stepBtnSmPlus: { width: 18, height: 18, borderRadius: 5, border: `1px solid ${COLORS.redSoft}`, background: COLORS.redSoft, color: COLORS.accentDeep, display: "flex", alignItems: "center", justifyContent: "center" },
  stepBtnSmMinus: { width: 18, height: 18, borderRadius: 5, border: `1px solid ${COLORS.blueSoft}`, background: COLORS.blueSoft, color: "#4E7290", display: "flex", alignItems: "center", justifyContent: "center" },
  qtyNum: { fontFamily: FONT.mono, fontSize: 13.5, minWidth: 14, textAlign: "center" },

  rowBetween: { display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 },
  ticketGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: 20, marginTop: 10 },
  ticket: {
    background: "#fff",
    border: `1px solid ${COLORS.line}`,
    borderRadius: 10,
    padding: "16px 18px 12px",
    boxShadow: "0 1px 0 rgba(0,0,0,0.02)",
  },
  ticketHeader: { display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" },
  ticketBadge: {
    fontFamily: FONT.mono,
    fontSize: 11.5,
    background: COLORS.paperDeep,
    color: COLORS.inkSoft,
    padding: "3px 7px",
    borderRadius: 20,
  },
  ticketName: { fontFamily: FONT.display, fontWeight: 700, fontSize: 16, flex: 1, cursor: "pointer", display: "flex", alignItems: "center", gap: 5 },
  ticketNameInput: { fontFamily: FONT.display, fontWeight: 700, fontSize: 16, flex: 1, border: `1px solid ${COLORS.jade}`, borderRadius: 5, padding: "2px 6px" },
  capacityStepper: { display: "flex", alignItems: "center", gap: 5 },
  guestBlock: { marginBottom: 8, paddingTop: 6, borderTop: `1px dashed ${COLORS.paperDeep}` },
  guestBlockHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13.5, fontWeight: 600, color: COLORS.jadeDeep, marginBottom: 3 },
  guestBlockRight: { display: "flex", alignItems: "center", gap: 6 },
  ticketRow: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, padding: "3px 0", color: COLORS.ink },
  ticketPrice: { fontFamily: FONT.mono, fontSize: 12.5, width: 54, textAlign: "right" },
  ticketDivider: { borderTop: `1.5px dashed ${COLORS.line}`, margin: "10px 0 6px" },
  ticketTotalRow: { display: "flex", justifyContent: "space-between", fontSize: 13, color: COLORS.inkSoft, fontFamily: FONT.mono, padding: "2px 0" },
  ticketGrandRow: { display: "flex", justifyContent: "space-between", fontSize: 15, fontWeight: 700, fontFamily: FONT.mono, color: COLORS.jadeDeep, padding: "6px 0 4px" },
  ticketFooter: { marginTop: 6, borderTop: `1px solid ${COLORS.paperDeep}`, paddingTop: 8 },
  confirmRow: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 },

  grandCard: {
    background: COLORS.ink,
    color: COLORS.paper,
    borderRadius: 14,
    padding: "22px 26px",
    maxWidth: 420,
  },
  grandRow: { display: "flex", justifyContent: "space-between", fontSize: 14.5, fontFamily: FONT.mono, padding: "4px 0", opacity: 0.85 },
  grandDivider: { borderTop: "1px solid rgba(246,238,221,0.25)", margin: "10px 0" },
  grandTotalRow: { display: "flex", justifyContent: "space-between", fontSize: 21, fontWeight: 700, fontFamily: FONT.mono, color: "#E7B4A8" },
  minSpendNoteRow: { marginTop: 10, fontSize: 12.5, opacity: 0.7 },

  summaryTable: { background: "#fff", border: `1px solid ${COLORS.line}`, borderRadius: 10, overflow: "hidden" },
  summaryTableRow: { display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", fontSize: 14, borderBottom: `1px solid ${COLORS.paperDeep}` },
  summaryTableAmt: { fontFamily: FONT.mono, fontWeight: 600 },

  setupSection: { background: "#fff", border: `1px solid ${COLORS.line}`, borderRadius: 12, padding: "20px 22px", marginBottom: 20 },
  formGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginBottom: 12 },
  formGridThree: { display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 8, marginBottom: 8 },
  formLabel: { display: "flex", flexDirection: "column", gap: 5, fontSize: 13, color: COLORS.inkSoft, marginBottom: 12 },
  textarea: {
    padding: "9px 11px",
    borderRadius: 8,
    border: `1px solid ${COLORS.line}`,
    fontSize: 14,
    background: "#fff",
    color: COLORS.ink,
    resize: "vertical",
    minHeight: 60,
    outline: "none",
  },
  aiBox: {
    background: COLORS.paper,
    border: `1px solid ${COLORS.line}`,
    borderRadius: 10,
    padding: "14px 16px",
    marginBottom: 16,
  },
  aiBoxHeader: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    fontFamily: FONT.display,
    fontWeight: 700,
    fontSize: 14.5,
    color: COLORS.accentDeep,
    marginBottom: 4,
  },
  aiUploadRow: { display: "flex", alignItems: "center", gap: 10, marginTop: 8, flexWrap: "wrap" },
  uploadLabel: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "9px 13px",
    borderRadius: 8,
    border: `1px dashed ${COLORS.accent}`,
    fontSize: 13.5,
    color: COLORS.accentDeep,
    background: "#fff",
    cursor: "pointer",
  },
  aiPreview: { marginTop: 14, paddingTop: 12, borderTop: `1px dashed ${COLORS.line}` },
  menuListWrap: { display: "flex", flexDirection: "column", gap: 6, margin: "12px 0" },
  bulkToolbar: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    flexWrap: "wrap",
    padding: "6px 2px 10px",
    borderBottom: `1px solid ${COLORS.paperDeep}`,
    marginBottom: 4,
  },
  bulkSelectAll: { display: "flex", alignItems: "center", gap: 6, cursor: "pointer" },
  menuListRow: { display: "flex", alignItems: "center", gap: 8 },
  reorderBtns: { display: "flex", flexDirection: "column", gap: 2 },
  menuListInput: { flex: 2, padding: "7px 9px", borderRadius: 6, border: `1px solid ${COLORS.line}`, fontSize: 14 },
  menuListInputSm: { flex: 1, padding: "7px 9px", borderRadius: 6, border: `1px solid ${COLORS.line}`, fontSize: 14 },
  toast: {
    position: "fixed",
    left: "50%",
    bottom: 90,
    transform: "translateX(-50%)",
    background: COLORS.ink,
    color: COLORS.paper,
    padding: "10px 20px",
    borderRadius: 30,
    fontSize: 13.5,
    fontWeight: 600,
    boxShadow: "0 6px 18px rgba(0,0,0,0.18)",
    zIndex: 60,
    whiteSpace: "nowrap",
  },
  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(38,30,28,0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 70,
    padding: 20,
  },
  modalCard: {
    background: "#fff",
    borderRadius: 14,
    padding: "22px 24px",
    maxWidth: 380,
    width: "100%",
    boxShadow: "0 12px 30px rgba(0,0,0,0.2)",
  },
  modalTitle: { fontFamily: FONT.display, fontWeight: 700, fontSize: 16.5, marginBottom: 8, color: COLORS.ink },
  modalBtnRow: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 },
  modalDupList: {
    maxHeight: 160,
    overflowY: "auto",
    margin: "10px 0",
    padding: "8px 12px",
    background: COLORS.paper,
    borderRadius: 8,
    fontSize: 13,
  },
};
