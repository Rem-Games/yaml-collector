"use strict";

const STATUS_BANNER = document.querySelector("#status-banner");
const MAIN_VIEW = document.querySelector("#main-view");
const NAV_LINKS = Array.from(document.querySelectorAll(".nav-link"));
const UPLOAD_INPUT = document.querySelector("#upload-input");
const MODAL_ROOT = document.querySelector("#modal-root");
const MODAL_BACKDROP = document.querySelector("#modal-backdrop");
const MODAL_CLOSE = document.querySelector("#modal-close");
const MODAL_TITLE = document.querySelector("#modal-title");
const MODAL_BODY = document.querySelector("#modal-body");

const ROOM_COOKIE_PREFIX = "yamlcollector_room_admin_";
const UPLOADER_COOKIE = "yamlcollector_uploader_token";
const API_SCHEMA = "api";
const COMBINED_SEPARATOR = "\n\n---\n\n";

const state = {
  configReady: false,
  route: { name: "rooms", roomSlug: null },
  uploaderToken: null,
  uploaderTokenHash: null,
  myRooms: [],
  currentRoom: null,
  currentEntries: [],
  currentSubmissionCounts: new Map(),
  roomTable: {
    sortField: "player",
    sortDirection: "asc",
    onlyMine: false
  },
  pendingUploadRoom: null,
  renderToken: 0
};

const crcTable = buildCrcTable();

function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function toDosDateTime(dateValue) {
  const date = new Date(dateValue);
  const year = Math.max(date.getFullYear(), 1980);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  return {
    time: (hours << 11) | (minutes << 5) | seconds,
    date: ((year - 1980) << 9) | (month << 5) | day
  };
}

function concatUint8Arrays(parts) {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function createZipBlob(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const filenameBytes = encoder.encode(file.name);
    const contentBytes = encoder.encode(file.content);
    const checksum = crc32(contentBytes);
    const sizes = contentBytes.length;
    const stamp = toDosDateTime(file.modifiedAt || Date.now());

    const localHeader = new Uint8Array(30 + filenameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, stamp.time, true);
    localView.setUint16(12, stamp.date, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, sizes, true);
    localView.setUint32(22, sizes, true);
    localView.setUint16(26, filenameBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(filenameBytes, 30);

    const centralHeader = new Uint8Array(46 + filenameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, stamp.time, true);
    centralView.setUint16(14, stamp.date, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, sizes, true);
    centralView.setUint32(24, sizes, true);
    centralView.setUint16(28, filenameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(filenameBytes, 46);

    localParts.push(localHeader, contentBytes);
    centralParts.push(centralHeader);
    offset += localHeader.length + contentBytes.length;
  }

  const centralDirectory = concatUint8Arrays(centralParts);
  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralDirectory.length, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);

  const zipBytes = concatUint8Arrays([...localParts, centralDirectory, endRecord]);
  return new Blob([zipBytes], { type: "application/zip" });
}

function showBanner(element, message, isError = false) {
  element.textContent = message;
  element.classList.remove("hidden");
  element.classList.toggle("error", isError);
}

function clearBanner(element) {
  element.textContent = "";
  element.classList.add("hidden");
  element.classList.remove("error");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getConfig() {
  const config = window.APP_CONFIG || {};
  const url = typeof config.supabaseUrl === "string" ? config.supabaseUrl.trim() : "";
  const key =
    typeof config.supabaseKey === "string"
      ? config.supabaseKey.trim()
      : typeof config.supabaseAnonKey === "string"
        ? config.supabaseAnonKey.trim()
        : "";

  if (
    !url ||
    !key ||
    url.includes("YOUR-PROJECT") ||
    key.includes("YOUR-PUBLISHABLE-OR-ANON-KEY") ||
    key.includes("YOUR-ANON-KEY")
  ) {
    return null;
  }

  return {
    supabaseUrl: url.replace(/\/$/, ""),
    supabaseKey: key
  };
}

function getCookie(name) {
  const encodedName = `${encodeURIComponent(name)}=`;
  const parts = document.cookie.split(";").map((part) => part.trim());
  for (const part of parts) {
    if (part.startsWith(encodedName)) {
      return decodeURIComponent(part.slice(encodedName.length));
    }
  }
  return null;
}

function getAllCookies() {
  const cookies = new Map();
  for (const part of document.cookie.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const splitIndex = trimmed.indexOf("=");
    const name = splitIndex >= 0 ? trimmed.slice(0, splitIndex) : trimmed;
    const value = splitIndex >= 0 ? trimmed.slice(splitIndex + 1) : "";
    cookies.set(decodeURIComponent(name), decodeURIComponent(value));
  }
  return cookies;
}

function setCookie(name, value, days = 3650) {
  const maxAge = days * 24 * 60 * 60;
  document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}; SameSite=Lax`;
}

function roomAdminCookieName(roomSlug) {
  return `${ROOM_COOKIE_PREFIX}${roomSlug}`;
}

function getRoomAdminToken(roomSlug) {
  return getCookie(roomAdminCookieName(roomSlug));
}

function hasRoomAdminToken(roomSlug) {
  return Boolean(roomSlug && getRoomAdminToken(roomSlug));
}

function listCreatedRoomSlugs() {
  const slugs = [];
  for (const [name] of getAllCookies()) {
    if (name.startsWith(ROOM_COOKIE_PREFIX)) {
      slugs.push(name.slice(ROOM_COOKIE_PREFIX.length));
    }
  }
  return slugs.sort();
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createToken() {
  const bytes = new Uint8Array(24);
  window.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function generateRoomSlug() {
  const bytes = new Uint8Array(8);
  window.crypto.getRandomValues(bytes);
  return `room-${bytesToHex(bytes)}`;
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await window.crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

function sanitizeSlug(raw) {
  return raw.toLowerCase().trim().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

function sanitizeFilenamePart(value, fallback = "yaml") {
  const cleaned = String(value || "")
    .replace(/\.(ya?ml|txt)$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

function ensureUploaderToken() {
  let token = getCookie(UPLOADER_COOKIE);
  if (!token) {
    token = createToken();
    setCookie(UPLOADER_COOKIE, token);
  }
  state.uploaderToken = token;
  return token;
}

async function ensureUploaderHash() {
  const token = ensureUploaderToken();
  if (!state.uploaderTokenHash) {
    state.uploaderTokenHash = await sha256Hex(token);
  }
  return state.uploaderTokenHash;
}

async function getRoomAdminTokenHash(roomSlug) {
  const token = getRoomAdminToken(roomSlug);
  return token ? sha256Hex(token) : null;
}

async function apiFetch(path, options = {}) {
  const config = getConfig();
  if (!config) {
    throw new Error("Missing Supabase config.");
  }

  const headers = new Headers(options.headers || {});
  const method = (options.method || "GET").toUpperCase();
  headers.set("apikey", config.supabaseKey);
  headers.set("Accept-Profile", API_SCHEMA);
  if (method !== "GET" && method !== "HEAD") {
    headers.set("Content-Profile", API_SCHEMA);
  }
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${config.supabaseUrl}${path}`, {
    ...options,
    headers
  });

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      detail = payload.message || payload.error_description || payload.error || JSON.stringify(payload);
    } catch {
      const text = await response.text();
      if (text) {
        detail = text;
      }
    }
    throw new Error(detail);
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

function rpc(functionName, payload) {
  return apiFetch(`/rest/v1/rpc/${functionName}`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

async function fetchRoomsBySlugs(roomSlugs) {
  if (roomSlugs.length === 0) {
    return [];
  }

  const uniqueSlugs = [...new Set(roomSlugs)].map(sanitizeSlug).filter(Boolean);
  const params = new URLSearchParams({
    select: "slug,name,description,closes_at,yaml_limit,created_at",
    order: "closes_at.asc"
  });
  params.set("slug", `in.(${uniqueSlugs.join(",")})`);
  return apiFetch(`/rest/v1/rooms?${params.toString()}`);
}

async function fetchMyUploadedRoomSlugs() {
  const uploaderHash = await ensureUploaderHash();
  const params = new URLSearchParams({
    select: "room_slug",
    uploader_token_hash: `eq.${uploaderHash}`
  });
  const rows = await apiFetch(`/rest/v1/yaml_entries?${params.toString()}`);
  return [...new Set(rows.map((row) => row.room_slug))];
}

async function fetchRoomInfo(roomSlug) {
  const params = new URLSearchParams({
    select: "slug,name,description,closes_at,yaml_limit,created_at",
    slug: `eq.${roomSlug}`
  });
  const rows = await apiFetch(`/rest/v1/rooms?${params.toString()}`);
  return rows[0] || null;
}

function extractRootScalar(content, key) {
  const normalized = content.replace(/\r\n/g, "\n");
  const pattern = new RegExp(`(?:^|\\n)${key}\\s*:\\s*(.+?)(?=\\n|$)`, "i");
  const match = normalized.match(pattern);
  if (!match) {
    return null;
  }

  let value = match[1].trim();
  if (!value || value === "|" || value === ">") {
    return null;
  }

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  } else {
    const commentIndex = value.search(/\s+#/);
    if (commentIndex >= 0) {
      value = value.slice(0, commentIndex).trim();
    }
  }

  return value || null;
}

async function fetchRoomEntries(roomSlug) {
  const params = new URLSearchParams({
    select: "id,label,original_filename,content,created_at,uploader_token_hash,submission_id,document_index,player_name,game_name",
    room_slug: `eq.${roomSlug}`
  });
  const rows = await apiFetch(`/rest/v1/yaml_entries?${params.toString()}`);
  return rows
    .map((entry) => ({
      ...entry,
      document_index: entry.document_index || 1,
      player: entry.player_name || extractRootScalar(entry.content, "name") || "Unknown Player",
      game: entry.game_name || extractRootScalar(entry.content, "game") || "Unknown Game",
      isMine: entry.uploader_token_hash === state.uploaderTokenHash
    }))
    .sort((left, right) => {
      const timeDiff = new Date(left.created_at).getTime() - new Date(right.created_at).getTime();
      if (timeDiff !== 0) {
        return timeDiff;
      }
      const docDiff = left.document_index - right.document_index;
      if (docDiff !== 0) {
        return docDiff;
      }
      return left.id.localeCompare(right.id);
    });
}

function splitYamlDocuments(content) {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const withoutLeadingMarker = normalized.replace(/^[ \t]*---[ \t]*\n(?:[ \t]*\n)?/, "");
  const sentinel = "\n__YAMLCOLLECTOR_DOC_BREAK__\n";

  return withoutLeadingMarker
    .replace(/\n(?:[ \t]*\n)?---[ \t]*\n(?:[ \t]*\n)?/g, sentinel)
    .split(sentinel)
    .map((doc) => doc.trim())
    .filter(Boolean);
}

function hasRootGameSection(content, gameValue) {
  const normalized = content.replace(/\r\n/g, "\n");
  const escapedGame = gameValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|\\n)(?:'${escapedGame}'|"${escapedGame}"|${escapedGame}):\\s*(?:#.*)?(?=\\n|$)`);
  return pattern.test(normalized);
}

function validateYamlDocumentContent(content, existingNamesLower) {
  const playerName = extractRootScalar(content, "name");
  if (!playerName) {
    throw new Error('YAML must include a root "name" field.');
  }

  const gameName = extractRootScalar(content, "game");
  if (!gameName) {
    throw new Error(`YAML for ${playerName} must include a root "game" field.`);
  }

  if (!hasRootGameSection(content, gameName)) {
    throw new Error(`YAML for ${playerName} must include a root "${gameName}" section.`);
  }

  const playerKey = playerName.toLowerCase();
  if (existingNamesLower.has(playerKey)) {
    throw new Error(`${playerName} is already present in this room.`);
  }

  existingNamesLower.add(playerKey);

  return {
    playerName,
    gameName
  };
}

function buildSubmissionCounts(entries) {
  const counts = new Map();
  for (const entry of entries) {
    counts.set(entry.submission_id, (counts.get(entry.submission_id) || 0) + 1);
  }
  return counts;
}

function groupEntriesByUploader(entries) {
  const groups = new Map();
  let uploaderIndex = 1;

  for (const entry of entries) {
    if (!groups.has(entry.uploader_token_hash)) {
      const isMine = entry.uploader_token_hash === state.uploaderTokenHash;
      groups.set(entry.uploader_token_hash, {
        uploaderTokenHash: entry.uploader_token_hash,
        displayName: isMine ? "You" : `Uploader ${uploaderIndex}`,
        entries: []
      });
      if (!isMine) {
        uploaderIndex += 1;
      }
    }
    groups.get(entry.uploader_token_hash).entries.push(entry);
  }

  return Array.from(groups.values());
}

function formatDateTime(value) {
  if (!value) {
    return "Not set";
  }
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function isoToLocalInput(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function localInputToIso(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

function defaultClosingDateInput() {
  const date = new Date();
  date.setDate(date.getDate() + 7);
  date.setHours(23, 59, 0, 0);
  return isoToLocalInput(date.toISOString());
}

function roomIsClosed(room) {
  return Date.now() >= new Date(room.closes_at).getTime();
}

function getMyYamlCount(roomEntries) {
  return roomEntries.filter((entry) => entry.isMine).length;
}

function getRemainingUploadSlots(room, roomEntries) {
  if (!Number.isInteger(room.yaml_limit) || room.yaml_limit <= 0) {
    return null;
  }
  return Math.max(room.yaml_limit - getMyYamlCount(roomEntries), 0);
}

function canUploadToRoom(room, roomEntries) {
  if (roomIsClosed(room)) {
    return false;
  }
  const remaining = getRemainingUploadSlots(room, roomEntries);
  return remaining === null || remaining > 0;
}

function canDeleteEntry(entry, room) {
  if (hasRoomAdminToken(room.slug)) {
    return true;
  }
  return entry.isMine && !roomIsClosed(room);
}

function getVisibleRoomEntries() {
  const filtered = state.roomTable.onlyMine
    ? state.currentEntries.filter((entry) => entry.isMine)
    : state.currentEntries.slice();

  const direction = state.roomTable.sortDirection === "asc" ? 1 : -1;
  const field = state.roomTable.sortField;

  filtered.sort((left, right) => {
    const compare = left[field].localeCompare(right[field], undefined, { sensitivity: "base" });
    if (compare !== 0) {
      return compare * direction;
    }
    return new Date(left.created_at).getTime() - new Date(right.created_at).getTime();
  });

  return filtered;
}

function nextSortDirection(field) {
  if (state.roomTable.sortField === field) {
    state.roomTable.sortDirection = state.roomTable.sortDirection === "asc" ? "desc" : "asc";
  } else {
    state.roomTable.sortField = field;
    state.roomTable.sortDirection = "asc";
  }
  renderRoute();
}

function combinedYaml(entries) {
  return entries.map((entry) => entry.content).join(COMBINED_SEPARATOR);
}

function entryDownloadName(entry) {
  const base = sanitizeFilenamePart(entry.original_filename || entry.player || entry.label || "yaml");
  const submissionCount = state.currentSubmissionCounts.get(entry.submission_id) || 1;
  if (submissionCount > 1) {
    return `${base}-doc-${entry.document_index}.yaml`;
  }
  return `${base}.yaml`;
}

function bundleDownloadName(group) {
  return `${sanitizeFilenamePart(state.currentRoom.slug, "room")}-${sanitizeFilenamePart(group.displayName, "uploader")}-bundle.yaml`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function downloadText(text, filename) {
  downloadBlob(new Blob([text], { type: "text/yaml;charset=utf-8" }), filename);
}

function setActiveNav(routeName) {
  for (const button of NAV_LINKS) {
    button.classList.toggle("active", button.dataset.route === routeName);
    button.classList.toggle("warning", button.dataset.route === "about" && !state.configReady);
  }
}

function getRouteFromHash() {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash || hash === "rooms") {
    return { name: "rooms", roomSlug: null };
  }
  if (hash === "create") {
    return { name: "create", roomSlug: null };
  }
  if (hash === "about") {
    return { name: "about", roomSlug: null };
  }
  if (hash.startsWith("room/")) {
    return { name: "room", roomSlug: sanitizeSlug(hash.slice("room/".length)) };
  }
  return { name: "rooms", roomSlug: null };
}

function navigateTo(routeName, roomSlug = null) {
  if (routeName === "room" && roomSlug) {
    window.location.hash = `room/${sanitizeSlug(roomSlug)}`;
    return;
  }
  window.location.hash = routeName;
}

function renderUnavailablePage(title) {
  MAIN_VIEW.innerHTML = `
    <section class="content-card hero-card">
      <h2 class="page-title">${escapeHtml(title)}</h2>
      <p class="page-copy">Supabase is not configured yet. Open About for setup details.</p>
    </section>
  `;
}

function renderLoading(title) {
  MAIN_VIEW.innerHTML = `
    <section class="content-card hero-card">
      <p class="eyebrow">Loading</p>
      <h2 class="page-title">${escapeHtml(title)}</h2>
      <p class="page-copy">Fetching the latest room data for this browser.</p>
    </section>
  `;
}

function showModal(title, content, onReady) {
  MODAL_TITLE.textContent = title;
  MODAL_BODY.innerHTML = content;
  MODAL_ROOT.classList.remove("hidden");
  MODAL_ROOT.setAttribute("aria-hidden", "false");
  if (typeof onReady === "function") {
    onReady();
  }
}

function closeModal() {
  MODAL_ROOT.classList.add("hidden");
  MODAL_ROOT.setAttribute("aria-hidden", "true");
  MODAL_BODY.innerHTML = "";
}

function showConfirmModal({ title, message, confirmLabel, confirmClass = "danger", onConfirm }) {
  showModal(
    title,
    `
      <div class="modal-stack">
        <p class="content-copy">${escapeHtml(message)}</p>
        <div class="action-row">
          <button id="modal-confirm-button" type="button" class="${escapeHtml(confirmClass)}">${escapeHtml(confirmLabel)}</button>
          <button id="modal-cancel-button" type="button" class="secondary">Cancel</button>
        </div>
      </div>
    `,
    () => {
      document.querySelector("#modal-cancel-button").addEventListener("click", closeModal);
      document.querySelector("#modal-confirm-button").addEventListener("click", async () => {
        try {
          await onConfirm();
          closeModal();
        } catch (error) {
          showBanner(STATUS_BANNER, error.message || "Action failed.", true);
        }
      });
    }
  );
}

function attachRoomsPageEvents() {
  for (const button of document.querySelectorAll("[data-open-room]")) {
    button.addEventListener("click", () => navigateTo("room", button.dataset.openRoom));
  }
}

function attachCreateRoomEvents() {
  const form = document.querySelector("#create-room-form");
  if (!form) {
    return;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearBanner(STATUS_BANNER);

    try {
      const formData = new FormData(form);
      const roomName = String(formData.get("room-name") || "").trim();
      const closingInput = String(formData.get("room-closing") || "").trim();
      const description = String(formData.get("room-description") || "").trim();
      const yamlLimitRaw = String(formData.get("yaml-limit") || "").trim();

      if (!roomName) {
        throw new Error("Room name is required.");
      }

      const closesAt = localInputToIso(closingInput);
      if (!closesAt) {
        throw new Error("Room closing date is required.");
      }

      const yamlLimit = yamlLimitRaw ? Number.parseInt(yamlLimitRaw, 10) : null;
      if (yamlLimitRaw && (!Number.isInteger(yamlLimit) || yamlLimit <= 0)) {
        throw new Error("YAML limit must be a positive whole number.");
      }

      const adminToken = createToken();
      const adminTokenHash = await sha256Hex(adminToken);
      const result = await rpc("create_room", {
        p_slug: generateRoomSlug(),
        p_name: roomName,
        p_description: description,
        p_closes_at: closesAt,
        p_yaml_limit: yamlLimit,
        p_admin_token_hash: adminTokenHash
      });

      const room = Array.isArray(result) ? result[0] : result;
      setCookie(roomAdminCookieName(room.slug), adminToken);
      await refreshMyRooms();
      showBanner(STATUS_BANNER, `Created room ${room.name}.`);
      navigateTo("room", room.slug);
    } catch (error) {
      showBanner(STATUS_BANNER, error.message || "Failed to create room.", true);
    }
  });
}

function attachRoomPageEvents() {
  const copyRoomLinkButton = document.querySelector("#copy-room-link");
  if (copyRoomLinkButton) {
    copyRoomLinkButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(window.location.href);
        showBanner(STATUS_BANNER, "Room link copied.");
      } catch (error) {
        showBanner(STATUS_BANNER, error.message || "Failed to copy room link.", true);
      }
    });
  }

  const uploadButton = document.querySelector("#room-upload-button");
  if (uploadButton) {
    uploadButton.addEventListener("click", () => {
      state.pendingUploadRoom = uploadButton.dataset.roomSlug;
      UPLOAD_INPUT.click();
    });
  }

  const editButton = document.querySelector("#edit-room-button");
  if (editButton) {
    editButton.addEventListener("click", openEditRoomModal);
  }

  const deleteRoomButton = document.querySelector("#delete-room-button");
  if (deleteRoomButton) {
    deleteRoomButton.addEventListener("click", openDeleteRoomModal);
  }

  const mineToggle = document.querySelector("#only-mine-toggle");
  if (mineToggle) {
    mineToggle.checked = state.roomTable.onlyMine;
    mineToggle.addEventListener("change", () => {
      state.roomTable.onlyMine = mineToggle.checked;
      renderRoute();
    });
  }

  for (const button of document.querySelectorAll("[data-sort-field]")) {
    button.addEventListener("click", () => nextSortDirection(button.dataset.sortField));
  }

  for (const button of document.querySelectorAll("[data-download-entry]")) {
    button.addEventListener("click", () => {
      const entry = state.currentEntries.find((item) => item.id === button.dataset.downloadEntry);
      if (!entry) {
        return;
      }
      downloadText(entry.content, entryDownloadName(entry));
      showBanner(STATUS_BANNER, "YAML download started.");
    });
  }

  for (const button of document.querySelectorAll("[data-delete-entry]")) {
    button.addEventListener("click", () => openDeleteEntryModal(button.dataset.deleteEntry));
  }

  const downloadAllButton = document.querySelector("#download-all-yamls");
  if (downloadAllButton) {
    downloadAllButton.addEventListener("click", () => {
      const files = state.currentEntries.map((entry) => ({
        name: entryDownloadName(entry),
        content: entry.content,
        modifiedAt: entry.created_at
      }));
      downloadBlob(
        createZipBlob(files),
        `${sanitizeFilenamePart(state.currentRoom.slug, "room")}-all-yamls.zip`
      );
      showBanner(STATUS_BANNER, "All YAMLs download started.");
    });
  }

  const downloadBundlesButton = document.querySelector("#download-all-bundles");
  if (downloadBundlesButton) {
    downloadBundlesButton.addEventListener("click", () => {
      const bundleFiles = groupEntriesByUploader(state.currentEntries).map((group) => ({
        name: bundleDownloadName(group),
        content: combinedYaml(group.entries),
        modifiedAt: group.entries[0]?.created_at || Date.now()
      }));
      downloadBlob(
        createZipBlob(bundleFiles),
        `${sanitizeFilenamePart(state.currentRoom.slug, "room")}-bundled-yamls.zip`
      );
      showBanner(STATUS_BANNER, "Bundled YAML download started.");
    });
  }
}

async function openEditRoomModal() {
  const room = state.currentRoom;
  if (!room) {
    return;
  }

  showModal(
    "Edit Room",
    `
      <form id="edit-room-form" class="modal-stack">
        <label class="field">
          <span>Room Name</span>
          <input name="room-name" maxlength="80" required value="${escapeHtml(room.name)}">
        </label>
        <label class="field">
          <span>Closing Date</span>
          <input name="room-closing" type="datetime-local" required value="${escapeHtml(isoToLocalInput(room.closes_at))}">
        </label>
        <div class="action-row">
          <button type="submit">Save Changes</button>
          <button id="edit-room-cancel" type="button" class="secondary">Cancel</button>
        </div>
      </form>
    `,
    () => {
      document.querySelector("#edit-room-cancel").addEventListener("click", closeModal);
      document.querySelector("#edit-room-form").addEventListener("submit", async (event) => {
        event.preventDefault();

        const formData = new FormData(event.currentTarget);
        const roomName = String(formData.get("room-name") || "").trim();
        const closesAt = localInputToIso(String(formData.get("room-closing") || "").trim());
        if (!roomName || !closesAt) {
          showBanner(STATUS_BANNER, "Room name and closing date are required.", true);
          return;
        }

        const adminTokenHash = await getRoomAdminTokenHash(room.slug);
        if (!adminTokenHash) {
          showBanner(STATUS_BANNER, "This browser does not have the room admin cookie.", true);
          return;
        }

        await rpc("update_room_meta", {
          p_room_slug: room.slug,
          p_name: roomName,
          p_closes_at: closesAt,
          p_room_admin_token_hash: adminTokenHash
        });

        await refreshMyRooms();
        await loadCurrentRoom(room.slug);
        closeModal();
        showBanner(STATUS_BANNER, "Room updated.");
        renderRoute();
      });
    }
  );
}

function openDeleteRoomModal() {
  const room = state.currentRoom;
  if (!room) {
    return;
  }

  showConfirmModal({
    title: "Delete Room",
    message: `Delete room "${room.name}" and every YAML inside it? This cannot be undone.`,
    confirmLabel: "Delete Room",
    onConfirm: async () => {
      const adminTokenHash = await getRoomAdminTokenHash(room.slug);
      if (!adminTokenHash) {
        throw new Error("This browser does not have the room admin cookie.");
      }
      await rpc("delete_room", {
        p_room_slug: room.slug,
        p_room_admin_token_hash: adminTokenHash
      });
      await refreshMyRooms();
      showBanner(STATUS_BANNER, "Room deleted.");
      navigateTo("rooms");
    }
  });
}

function openDeleteEntryModal(entryId) {
  const entry = state.currentEntries.find((item) => item.id === entryId);
  const room = state.currentRoom;
  if (!entry || !room) {
    return;
  }

  showConfirmModal({
    title: "Delete YAML",
    message: `Remove ${entry.player} from ${room.name}?`,
    confirmLabel: "Delete YAML",
    onConfirm: async () => {
      const adminTokenHash = await getRoomAdminTokenHash(room.slug);
      const requesterTokenHash = state.uploaderTokenHash;
      await rpc("delete_yaml", {
        p_entry_id: entry.id,
        p_requester_token_hash: requesterTokenHash,
        p_room_admin_token_hash: adminTokenHash
      });
      await loadCurrentRoom(room.slug);
      await refreshMyRooms();
      showBanner(STATUS_BANNER, "YAML deleted.");
      renderRoute();
    }
  });
}

async function handleUploadSelection(files) {
  if (!state.currentRoom || !state.pendingUploadRoom || state.pendingUploadRoom !== state.currentRoom.slug) {
    return;
  }

  clearBanner(STATUS_BANNER);

  try {
    const room = state.currentRoom;
    if (!canUploadToRoom(room, state.currentEntries)) {
      throw new Error("This room is closed or you have reached the YAML limit.");
    }

    const fileList = Array.from(files);
    if (fileList.length === 0) {
      return;
    }

    const preparedUploads = [];
    const reservedNames = new Set(state.currentEntries.map((entry) => entry.player.toLowerCase()));
    for (const file of fileList) {
      const content = await file.text();
      const documents = splitYamlDocuments(content);
      if (documents.length === 0) {
        throw new Error(`No YAML documents were found in ${file.name}.`);
      }
      const baseLabel = file.name.replace(/\.(ya?ml|txt)$/i, "") || "yaml";
      preparedUploads.push({
        originalFilename: file.name,
        documents: documents.map((documentContent, index) => {
          const validation = validateYamlDocumentContent(documentContent, reservedNames);
          return {
            label: documents.length > 1 ? `${baseLabel} · Doc ${index + 1}` : baseLabel,
            content: documentContent,
            document_index: index + 1,
            player_name: validation.playerName,
            game_name: validation.gameName
          };
        })
      });
    }

    const remainingSlots = getRemainingUploadSlots(room, state.currentEntries);
    const totalDocuments = preparedUploads.reduce((sum, item) => sum + item.documents.length, 0);
    if (remainingSlots !== null && totalDocuments > remainingSlots) {
      throw new Error(`This room allows ${remainingSlots} more YAML ${remainingSlots === 1 ? "entry" : "entries"} from this browser.`);
    }

    const uploaderHash = await ensureUploaderHash();
    for (const upload of preparedUploads) {
      await rpc("upload_yaml_batch", {
        p_room_slug: room.slug,
        p_original_filename: upload.originalFilename,
        p_uploader_token_hash: uploaderHash,
        p_documents: upload.documents
      });
    }

    await loadCurrentRoom(room.slug);
    await refreshMyRooms();
    showBanner(STATUS_BANNER, `Uploaded ${totalDocuments} YAML ${totalDocuments === 1 ? "document" : "documents"}.`);
    renderRoute();
  } catch (error) {
    showBanner(STATUS_BANNER, error.message || "Upload failed.", true);
  } finally {
    UPLOAD_INPUT.value = "";
    state.pendingUploadRoom = null;
  }
}

async function refreshMyRooms() {
  const [uploadedRoomSlugs] = await Promise.all([fetchMyUploadedRoomSlugs(), ensureUploaderHash()]);
  const createdRoomSlugs = listCreatedRoomSlugs();
  const rooms = await fetchRoomsBySlugs([...createdRoomSlugs, ...uploadedRoomSlugs]);

  state.myRooms = rooms
    .map((room) => ({
      ...room,
      isCreator: createdRoomSlugs.includes(room.slug),
      isContributor: uploadedRoomSlugs.includes(room.slug)
    }))
    .sort((left, right) => {
      const dateDiff = new Date(left.closes_at).getTime() - new Date(right.closes_at).getTime();
      if (dateDiff !== 0) {
        return dateDiff;
      }
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    });
}

async function loadCurrentRoom(roomSlug) {
  if (state.currentRoom?.slug !== roomSlug) {
    state.roomTable = {
      sortField: "player",
      sortDirection: "asc",
      onlyMine: false
    };
  }

  const [room, entries] = await Promise.all([fetchRoomInfo(roomSlug), fetchRoomEntries(roomSlug)]);
  state.currentRoom = room;
  state.currentEntries = entries;
  state.currentSubmissionCounts = buildSubmissionCounts(entries);
}

function renderRoomsPage() {
  const roomsMarkup = state.myRooms.length
    ? state.myRooms
        .map((room) => {
          const badges = [];
          if (room.isCreator) {
            badges.push('<span class="badge">Creator</span>');
          }
          if (room.isContributor) {
            badges.push('<span class="badge">Submitted YAML</span>');
          }
          if (roomIsClosed(room)) {
            badges.push('<span class="badge">Closed</span>');
          }

          return `
            <article class="room-list-item">
              <div class="meta-block">
                <button type="button" class="room-list-link" data-open-room="${escapeHtml(room.slug)}">${escapeHtml(room.name)}</button>
                <p class="meta-copy">Closing: ${escapeHtml(formatDateTime(room.closes_at))}</p>
              </div>
              <div class="badge-row">${badges.join("")}</div>
            </article>
          `;
        })
        .join("")
    : `
        <div class="empty-state">
          <p class="empty-copy">This browser has not created a room or uploaded a YAML yet.</p>
        </div>
      `;

  MAIN_VIEW.innerHTML = `
    <section class="content-card hero-card">
      <p class="eyebrow">Default View</p>
      <h2 class="page-title">My Rooms</h2>
      <p class="page-copy">Rooms appear here when this browser creates one or uploads at least one YAML into it.</p>
    </section>
    <section class="content-card">
      <div class="room-list">${roomsMarkup}</div>
    </section>
  `;

  attachRoomsPageEvents();
}

function renderCreateRoomPage() {
  MAIN_VIEW.innerHTML = `
    <section class="content-card hero-card">
      <p class="eyebrow">New Room</p>
      <h2 class="page-title">Create Room</h2>
      <p class="page-copy">Set the room name, the closing date, and any submission limit before sharing the room link.</p>
    </section>
    <section class="content-card">
      <form id="create-room-form" class="form-stack">
        <div class="field-grid">
          <label class="field">
            <span>Room Name</span>
            <input name="room-name" maxlength="80" required placeholder="Friday AP Multiworld">
          </label>
          <label class="field">
            <span>Room Closing Date</span>
            <input name="room-closing" type="datetime-local" required value="${escapeHtml(defaultClosingDateInput())}">
          </label>
        </div>
        <label class="field">
          <span>Room Description</span>
          <textarea name="room-description" rows="5" placeholder="Optional room description"></textarea>
        </label>
        <label class="field">
          <span>YAML Limit Per User</span>
          <input name="yaml-limit" type="number" min="1" step="1" placeholder="Leave empty for no limit">
          <p class="field-help">If set, each browser cookie can only add that many YAML documents to this room.</p>
        </label>
        <div class="action-row">
          <button type="submit">Create Room</button>
        </div>
      </form>
    </section>
  `;

  attachCreateRoomEvents();
}

function renderAboutPage() {
  const setupMarkup = state.configReady
    ? ""
    : `
        <div class="empty-state">
          <p class="empty-copy">Supabase is not configured yet. Set <code>config.js</code> locally with your project URL and publishable key, or provide the GitHub deploy secrets so the workflow can generate it at publish time.</p>
        </div>
      `;

  MAIN_VIEW.innerHTML = `
    <section class="content-card hero-card">
      <h2 class="page-title">About This Site</h2>
      <div class="about-copy content-grid">
        <p class="content-copy">Entries and room permissions are cookie bound. If you delete your cookie, you lose the ability to modify your data from that browser.</p>
        <p class="content-copy">Created by Rem.</p>
        ${setupMarkup}
      </div>
    </section>
  `;
}

function renderRoomPage() {
  const room = state.currentRoom;
  if (!room) {
    MAIN_VIEW.innerHTML = `
      <section class="content-card hero-card">
        <p class="eyebrow">Room Missing</p>
        <h2 class="page-title">Room Not Found</h2>
        <p class="page-copy">That room could not be loaded.</p>
      </section>
    `;
    return;
  }

  const isCreator = hasRoomAdminToken(room.slug);
  const closed = roomIsClosed(room);
  const remainingSlots = getRemainingUploadSlots(room, state.currentEntries);
  const visibleEntries = getVisibleRoomEntries();
  const sortMarker = state.roomTable.sortDirection === "asc" ? "↑" : "↓";

  const tableRows = visibleEntries.length
    ? visibleEntries
        .map((entry) => {
          const actions = [
            `<button type="button" class="ghost" data-download-entry="${escapeHtml(entry.id)}">Download</button>`
          ];
          if (canDeleteEntry(entry, room)) {
            actions.push(`<button type="button" class="danger" data-delete-entry="${escapeHtml(entry.id)}">Delete</button>`);
          }

          return `
            <tr>
              <td>${escapeHtml(entry.player)}</td>
              <td>${escapeHtml(entry.game)}</td>
              <td>
                <div class="inline-row">${actions.join("")}</div>
              </td>
            </tr>
          `;
        })
        .join("")
    : `
      <tr>
        <td colspan="3">No YAML entries match the current filter.</td>
      </tr>
    `;

  const uploadNote = closed
    ? "This room is closed."
    : remainingSlots === null
      ? "No per-user YAML limit."
      : `${remainingSlots} YAML ${remainingSlots === 1 ? "slot" : "slots"} remaining for this browser.`;

  MAIN_VIEW.innerHTML = `
    <section class="content-card hero-card">
      <div class="action-row">
        <div class="meta-block">
          <p class="eyebrow">Room</p>
          <h2 class="room-title">${escapeHtml(room.name)}</h2>
          <p class="meta-copy code-pill">${escapeHtml(room.slug)}</p>
        </div>
        <div class="action-row">
          <button id="copy-room-link" type="button" class="secondary">Copy Room Link</button>
          ${isCreator ? '<button id="edit-room-button" type="button" class="secondary">Edit Room</button>' : ""}
          ${isCreator ? '<button id="delete-room-button" type="button" class="danger">Delete Room</button>' : ""}
        </div>
      </div>
      <div class="stat-grid">
        <article class="stat-card">
          <p class="stat-label">Closing Time</p>
          <p class="stat-value">${escapeHtml(formatDateTime(room.closes_at))}</p>
        </article>
        <article class="stat-card">
          <p class="stat-label">Players</p>
          <p class="stat-value">${state.currentEntries.length}</p>
        </article>
        <article class="stat-card">
          <p class="stat-label">Description</p>
          <p class="stat-value">${escapeHtml(room.description || "No description")}</p>
        </article>
      </div>
      <p class="room-description">${escapeHtml(uploadNote)}</p>
      <div class="action-row">
        ${
          canUploadToRoom(room, state.currentEntries)
            ? `<button id="room-upload-button" type="button" data-room-slug="${escapeHtml(room.slug)}">Upload YAML</button>`
            : ""
        }
        ${
          Number.isInteger(room.yaml_limit) && room.yaml_limit > 0
            ? `<span class="badge">Limit: ${room.yaml_limit} per user</span>`
            : ""
        }
        ${closed ? '<span class="badge">Submissions Closed</span>' : ""}
      </div>
    </section>

    <section class="content-card">
      <div class="toolbar-row">
        <div class="meta-block">
          <h3>Room YAMLs</h3>
          <p class="table-note">Sort by player or game. Filter to only the YAMLs submitted by this browser.</p>
        </div>
        <label class="checkbox">
          <input id="only-mine-toggle" type="checkbox">
          <span>Display only my YAMLs</span>
        </label>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>
                <button type="button" class="sort-button" data-sort-field="player">
                  Player ${state.roomTable.sortField === "player" ? sortMarker : ""}
                </button>
              </th>
              <th>
                <button type="button" class="sort-button" data-sort-field="game">
                  Game ${state.roomTable.sortField === "game" ? sortMarker : ""}
                </button>
              </th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
      <div class="action-row">
        <button id="download-all-yamls" type="button" class="secondary" ${state.currentEntries.length ? "" : "disabled"}>Download All YAMLs</button>
        <button id="download-all-bundles" type="button" class="secondary" ${state.currentEntries.length ? "" : "disabled"}>Download All Bundled YAMLs</button>
      </div>
    </section>
  `;

  attachRoomPageEvents();
}

async function renderRoute() {
  const token = ++state.renderToken;
  setActiveNav(state.route.name === "room" ? "rooms" : state.route.name);

  if (!state.configReady) {
    if (state.route.name === "about") {
      renderAboutPage();
      return;
    }
    renderUnavailablePage(state.route.name === "create" ? "Create Room" : "My Rooms");
    return;
  }

  if (state.route.name === "rooms") {
    renderLoading("My Rooms");
    await refreshMyRooms();
    if (token !== state.renderToken) {
      return;
    }
    renderRoomsPage();
    return;
  }

  if (state.route.name === "create") {
    renderCreateRoomPage();
    return;
  }

  if (state.route.name === "about") {
    renderAboutPage();
    return;
  }

  if (state.route.name === "room") {
    if (!state.route.roomSlug) {
      navigateTo("rooms");
      return;
    }
    renderLoading("Room");
    await loadCurrentRoom(state.route.roomSlug);
    if (token !== state.renderToken) {
      return;
    }
    if (!state.currentRoom) {
      renderRoomPage();
      return;
    }
    renderRoomPage();
  }
}

function syncRoute() {
  state.route = getRouteFromHash();
  renderRoute().catch((error) => {
    showBanner(STATUS_BANNER, error.message || "Failed to load page.", true);
  });
}

function initNavigation() {
  for (const button of NAV_LINKS) {
    button.addEventListener("click", () => navigateTo(button.dataset.route));
  }
  window.addEventListener("hashchange", syncRoute);
}

function initModalEvents() {
  MODAL_CLOSE.addEventListener("click", closeModal);
  MODAL_BACKDROP.addEventListener("click", closeModal);
}

function initUploadEvents() {
  UPLOAD_INPUT.addEventListener("change", () => {
    handleUploadSelection(UPLOAD_INPUT.files || []).catch((error) => {
      showBanner(STATUS_BANNER, error.message || "Upload failed.", true);
    });
  });
}

async function init() {
  const config = getConfig();
  if (config) {
    state.configReady = true;
  }

  ensureUploaderToken();
  state.uploaderTokenHash = await sha256Hex(state.uploaderToken);

  initNavigation();
  initModalEvents();
  initUploadEvents();

  if (!window.location.hash) {
    navigateTo("rooms");
    return;
  }

  syncRoute();
}

init().catch((error) => {
  showBanner(STATUS_BANNER, error.message || "Unexpected startup error.", true);
});
