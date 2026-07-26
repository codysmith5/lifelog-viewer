import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://lweafdsfuptnnmgnaqlg.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_NcT6jYqiuVGBgf-l1LxQTg_hrakJcU8";
const ENTRIES_URL = `${SUPABASE_URL}/functions/v1/entries`;
const CLEANUP_URL = `${SUPABASE_URL}/functions/v1/cleanup-dictation`;
const EDIT_URL = `${SUPABASE_URL}/functions/v1/edit-entry`;

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

const DOMAIN_COLORS = {
  bowel_movement: "#8d6e63", sleep: "#5c6bc0", food: "#fb8c00", caffeine: "#6d4c41",
  alcohol: "#ab47bc", medication: "#26a69a", symptom: "#e53935", mood: "#ffca28",
  other: "#78909c", uncertain: "#bdbdbd",
};

let currentPersonId = null;
let pendingPhotos = []; // File objects staged for the entry currently being composed

const els = {
  authPanel: document.getElementById("auth-panel"),
  app: document.getElementById("app"),
  emailInput: document.getElementById("email-input"),
  sendLinkBtn: document.getElementById("send-link-btn"),
  authStatus: document.getElementById("auth-status"),
  signOutBtn: document.getElementById("sign-out-btn"),
  syncBanner: document.getElementById("sync-banner"),
  tabLog: document.getElementById("tab-log"),
  tabHistory: document.getElementById("tab-history"),
  viewLog: document.getElementById("view-log"),
  viewHistory: document.getElementById("view-history"),
  entryText: document.getElementById("entry-text"),
  cleanupBtn: document.getElementById("cleanup-btn"),
  photoBtn: document.getElementById("photo-btn"),
  photoInput: document.getElementById("photo-input"),
  photoThumbs: document.getElementById("photo-thumbs"),
  onFlightCheck: document.getElementById("on-flight-check"),
  submitBtn: document.getElementById("submit-btn"),
  logStatus: document.getElementById("log-status"),
  daysFilter: document.getElementById("days-filter"),
  historyContent: document.getElementById("history-content"),
};

// ---------- Service worker + storage persistence ----------

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js");
}
if (navigator.storage?.persist) {
  navigator.storage.persist();
}

// ---------- IndexedDB offline queue ----------

const DB_NAME = "lifelog-queue";
const STORE_NAME = "pending-entries";

function openQueueDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: "queuedAt" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function queueEntry(entry) {
  const db = await openQueueDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put({ ...entry, queuedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getQueuedEntries() {
  const db = await openQueueDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function removeQueuedEntry(queuedAt) {
  const db = await openQueueDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(queuedAt);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function updateSyncBanner() {
  const queued = await getQueuedEntries();
  if (queued.length > 0) {
    els.syncBanner.textContent = `${queued.length} ${queued.length === 1 ? "entry" : "entries"} waiting to sync`;
    els.syncBanner.classList.remove("hidden");
  } else {
    els.syncBanner.classList.add("hidden");
  }
}

async function syncQueue() {
  const queued = await getQueuedEntries();
  for (const item of queued) {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return; // not signed in, can't sync
      const res = await submitEntry(item.payload, session.access_token);
      if (res.ok) {
        if (item.photos?.length) {
          const data = await res.json();
          await uploadPhotos(data.id, item.photos);
        }
        await removeQueuedEntry(item.queuedAt);
      }
    } catch {
      // still offline or request failed -- leave queued, try again next sync
      break;
    }
  }
  await updateSyncBanner();
}

// ---------- Auth ----------

async function refreshAuthUi() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    els.authPanel.classList.add("hidden");
    els.app.classList.remove("hidden");
    const { data: person } = await supabase.from("people").select("id").eq("auth_user_id", session.user.id).single();
    currentPersonId = person?.id ?? null;
    if (Notification?.permission === "default") {
      Notification.requestPermission();
    }
    await syncQueue();
    loadHistory();
  } else {
    els.authPanel.classList.remove("hidden");
    els.app.classList.add("hidden");
  }
}

els.sendLinkBtn.addEventListener("click", async () => {
  const email = els.emailInput.value.trim();
  if (!email) return;
  els.sendLinkBtn.disabled = true;
  els.authStatus.textContent = "Sending...";
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: location.href.split("#")[0] },
  });
  els.sendLinkBtn.disabled = false;
  els.authStatus.textContent = error ? `Error: ${error.message}` : "Check your email for the sign-in link.";
});

els.signOutBtn.addEventListener("click", async () => {
  await supabase.auth.signOut();
  refreshAuthUi();
});

supabase.auth.onAuthStateChange(() => refreshAuthUi());

// ---------- Tabs ----------

els.tabLog.addEventListener("click", () => {
  els.tabLog.classList.add("active");
  els.tabHistory.classList.remove("active");
  els.viewLog.classList.remove("hidden");
  els.viewHistory.classList.add("hidden");
});
els.tabHistory.addEventListener("click", () => {
  els.tabHistory.classList.add("active");
  els.tabLog.classList.remove("active");
  els.viewHistory.classList.remove("hidden");
  els.viewLog.classList.add("hidden");
  loadHistory();
});
els.daysFilter.addEventListener("change", loadHistory);

// ---------- Dictation cleanup ----------

els.cleanupBtn.addEventListener("click", async () => {
  const text = els.entryText.value.trim();
  if (!text) return;
  els.cleanupBtn.disabled = true;
  els.cleanupBtn.textContent = "Cleaning up...";
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(CLEANUP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ raw_text: text }),
    });
    const data = await res.json();
    if (data.cleaned_text) els.entryText.value = data.cleaned_text;
  } catch {
    els.logStatus.textContent = "Cleanup failed (still offline-safe -- your original text is untouched).";
  } finally {
    els.cleanupBtn.disabled = false;
    els.cleanupBtn.textContent = "Clean up dictation";
  }
});

// ---------- Photos ----------

els.photoBtn.addEventListener("click", () => els.photoInput.click());

els.photoInput.addEventListener("change", () => {
  for (const file of els.photoInput.files) {
    pendingPhotos.push(file);
  }
  renderPhotoThumbs();
  els.photoInput.value = "";
});

function renderPhotoThumbs() {
  els.photoThumbs.innerHTML = "";
  pendingPhotos.forEach((file, i) => {
    const div = document.createElement("div");
    div.className = "photo-thumb";
    const img = document.createElement("img");
    img.src = URL.createObjectURL(file);
    const removeBtn = document.createElement("button");
    removeBtn.className = "remove";
    removeBtn.textContent = "✕";
    removeBtn.onclick = () => {
      pendingPhotos.splice(i, 1);
      renderPhotoThumbs();
    };
    div.append(img, removeBtn);
    els.photoThumbs.appendChild(div);
  });
}

async function uploadPhotos(entryId, photos) {
  // Uses the main `supabase` client directly -- it already carries the
  // signed-in session (supabase-js persists/refreshes this internally),
  // so a second manually-authenticated client here was redundant and a
  // real bug risk (manual header injection doesn't get the same
  // session-refresh handling the SDK does automatically).
  if (!currentPersonId || !photos.length) return;
  for (const [i, file] of photos.entries()) {
    const path = `${currentPersonId}/${entryId}/${Date.now()}-${i}.jpg`;
    const { error: uploadError } = await supabase.storage.from("entry-photos").upload(path, file);
    if (uploadError) {
      console.error("photo upload failed", uploadError);
      continue;
    }
    await supabase.from("entry_photos").insert({ entry_id: entryId, storage_path: path });
  }
}

// ---------- Location / weather context ----------

function getLocalTzOffset() {
  const offsetMin = -new Date().getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

function getPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos.coords),
      () => resolve(null),
      { timeout: 8000 }
    );
  });
}

async function reverseGeocode(lat, lon) {
  try {
    const res = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`
    );
    const data = await res.json();
    return { city: data.city || data.locality || null, state: data.principalSubdivisionCode?.split("-")[1] || data.principalSubdivision || null };
  } catch {
    return { city: null, state: null };
  }
}

// ---------- Submit ----------

async function submitEntry(payload, accessToken) {
  return fetch(ENTRIES_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(payload),
  });
}

els.submitBtn.addEventListener("click", async () => {
  const raw_text = els.entryText.value.trim();
  if (!raw_text) return;
  els.submitBtn.disabled = true;
  els.logStatus.textContent = "Logging...";

  const onFlight = els.onFlightCheck.checked;
  let payload = {
    raw_text,
    source: "text",
    local_tz_offset: getLocalTzOffset(),
    on_flight: onFlight,
  };

  if (!onFlight) {
    const coords = await getPosition();
    if (coords) {
      payload.latitude = coords.latitude;
      payload.longitude = coords.longitude;
      const geo = await reverseGeocode(coords.latitude, coords.longitude);
      payload.city = geo.city;
      payload.state = geo.state;
    }
  }

  const photosToSend = [...pendingPhotos];

  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error("not signed in");
    const res = await submitEntry(payload, session.access_token);
    if (!res.ok) throw new Error(`server error ${res.status}`);
    const data = await res.json();
    await uploadPhotos(data.id, photosToSend);
    els.logStatus.textContent = `Logged (${data.domain_tag ?? "uncertain"}).`;
    els.entryText.value = "";
    pendingPhotos = [];
    renderPhotoThumbs();
    els.onFlightCheck.checked = false;
    loadHistory();
  } catch (err) {
    await queueEntry({ payload, photos: photosToSend });
    els.logStatus.textContent = "No connection -- saved locally, will sync automatically.";
    els.entryText.value = "";
    pendingPhotos = [];
    renderPhotoThumbs();
    await updateSyncBanner();
  } finally {
    els.submitBtn.disabled = false;
  }
});

// ---------- History + edit ----------

function localTimeString(localTime, createdAt) {
  if (localTime) {
    const m = localTime.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    if (m) {
      const [, , month, day, hour, minute] = m;
      const h = parseInt(hour);
      const ampm = h >= 12 ? "PM" : "AM";
      const displayHour = h % 12 === 0 ? 12 : h % 12;
      return `${parseInt(month)}/${parseInt(day)} ${displayHour}:${minute} ${ampm}`;
    }
  }
  const date = new Date(createdAt);
  const hours = date.getUTCHours();
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  const displayHour = hours % 12 === 0 ? 12 : hours % 12;
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()} ${displayHour}:${minutes} ${ampm} UTC`;
}

function dayKey(localTime, createdAt) {
  if (localTime) {
    const m = localTime.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  return new Date(createdAt).toISOString().slice(0, 10);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function loadHistory() {
  els.historyContent.textContent = "Loading…";
  const days = parseInt(els.daysFilter.value);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data: entries, error } = await supabase
    .from("raw_entries")
    .select("id, raw_text, source, created_at, local_time, domain_tag, city, state, on_flight, weather_temp_f, weather_condition, edited_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false });

  if (error) {
    els.historyContent.innerHTML = `<p class="empty">Error: ${escapeHtml(error.message)}</p>`;
    return;
  }
  if (!entries.length) {
    els.historyContent.innerHTML = '<p class="empty">No entries in this range.</p>';
    return;
  }

  const grouped = new Map();
  for (const e of entries) {
    const key = dayKey(e.local_time, e.created_at);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(e);
  }

  let html = "";
  for (const [day, dayEntries] of grouped) {
    html += `<h2 class="day-header">${day}</h2>`;
    for (const e of dayEntries) {
      const color = DOMAIN_COLORS[e.domain_tag] || "#bdbdbd";
      const time = localTimeString(e.local_time, e.created_at);
      const metaBits = [];
      if (e.on_flight) metaBits.push("✈️ in-flight");
      else if (e.weather_temp_f != null) metaBits.push(`${Math.round(e.weather_temp_f)}°F ${e.weather_condition || ""}`.trim());
      if (e.city) metaBits.push(`${e.city}${e.state ? ", " + e.state : ""}`);
      const meta = metaBits.length ? `<div class="meta">${escapeHtml(metaBits.join(" · "))}</div>` : "";
      const editedBadge = e.edited_at ? '<span class="edited-badge">edited</span>' : "";

      html += `
        <div class="card" data-id="${e.id}">
          <div class="card-top">
            <span><span class="tag" style="background:${color}">${escapeHtml(e.domain_tag || "uncertain")}</span>${editedBadge}</span>
            <span class="time">${time}</span>
          </div>
          <div class="text" data-view>${escapeHtml(e.raw_text)}</div>
          ${meta}
          <div class="row">
            <button class="secondary edit-btn" data-edit="${e.id}">Edit</button>
          </div>
        </div>`;
    }
  }
  els.historyContent.innerHTML = html;

  document.querySelectorAll(".edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => startEdit(btn.dataset.edit));
  });
}

function startEdit(id) {
  const card = document.querySelector(`.card[data-id="${id}"]`);
  const textDiv = card.querySelector("[data-view]");
  const currentText = textDiv.textContent;
  const editRow = card.querySelector(".row");

  const textarea = document.createElement("textarea");
  textarea.value = currentText;
  textDiv.replaceWith(textarea);

  editRow.innerHTML = "";
  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "secondary";
  cancelBtn.textContent = "Cancel";
  editRow.append(saveBtn, cancelBtn);

  cancelBtn.onclick = () => loadHistory();
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(EDIT_URL, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ id, raw_text: textarea.value.trim() }),
    });
    if (res.ok) {
      loadHistory();
    } else {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
      alert("Failed to save edit.");
    }
  };
}

// ---------- Sync on foreground ----------

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") syncQueue();
});
window.addEventListener("online", syncQueue);

// ---------- Init ----------

updateSyncBanner();
refreshAuthUi();
