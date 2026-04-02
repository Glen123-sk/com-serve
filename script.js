const STORAGE_KEY = "comServeData";
const SESSION_KEY = "comServeSession";
const THEME_KEY = "comServeTheme";
const LOGIN_GUARD_KEY = "comServeLoginGuard";
const EMAIL_SDK_SRC = "https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js";
const SESSION_TTL_MS = 20 * 60 * 1000;

const money = (v) => `R${Number(v || 0).toFixed(2)}`;
const todayISO = () => new Date().toISOString().slice(0, 10);
const toDate = (iso) => new Date(`${iso}T00:00:00`);
const uid = () => `${Date.now()}-${Math.floor(Math.random() * 100000)}`;

const state = {
  data: null,
  session: null,
  loginGuard: null,
};

let emailSdkPromise = null;
let emailJsReady = false;

function simpleHash(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function initSecurityStructures() {
  state.data.auditTrail = state.data.auditTrail || [];
  state.data.runtimeErrors = state.data.runtimeErrors || [];
  state.data.emailLog = state.data.emailLog || [];
  state.data.emailConfig = state.data.emailConfig || {
    serviceId: "",
    templateId: "",
    publicKey: "",
    senderName: "COM-SERVE",
    replyTo: "",
  };
}

function initEmailSdk() {
  if (window.emailjs) {
    return Promise.resolve(window.emailjs);
  }

  if (!emailSdkPromise) {
    emailSdkPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = EMAIL_SDK_SRC;
      script.async = true;
      script.onload = () => resolve(window.emailjs);
      script.onerror = () => reject(new Error("Unable to load email SDK."));
      document.head.appendChild(script);
    });
  }

  return emailSdkPromise;
}

function emailConfig() {
  initSecurityStructures();
  return state.data.emailConfig;
}

function updateEmailConfig(nextConfig) {
  initSecurityStructures();
  state.data.emailConfig = {
    ...emailConfig(),
    ...nextConfig,
  };
  saveData();
}

function logEmailEvent(status, details) {
  initSecurityStructures();
  state.data.emailLog.unshift({
    id: uid(),
    date: new Date().toISOString(),
    status,
    details,
  });
  state.data.emailLog = state.data.emailLog.slice(0, 60);
  saveData();
}

function emailIsConfigured() {
  const cfg = emailConfig();
  return Boolean(cfg.serviceId && cfg.templateId && cfg.publicKey);
}

function emailTargetOf(household) {
  return (household.email || "").trim();
}

function displayNameOf(household) {
  return (household && (household.displayName || household.name || household.id)) || "Household";
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function nextHouseholdId() {
  const maxNumber = state.data.households.reduce((max, household) => {
    const match = String(household.id || "").match(/^HH(\d{3})$/i);
    if (!match) {
      return max;
    }
    return Math.max(max, Number(match[1]));
  }, 0);

  return `HH${String(maxNumber + 1).padStart(3, "0")}`;
}

function findHouseholdByLoginIdentifier(identifier) {
  const value = String(identifier || "").trim();
  if (!value) {
    return null;
  }

  const email = normalizeEmail(value);
  const id = value.toUpperCase();
  return state.data.households.find((household) => household.id === id || normalizeEmail(household.email) === email);
}

async function sendEmailMessage({ toEmail, toName, subject, message, replyTo = "", meta = {} }) {
  const cfg = emailConfig();
  if (!cfg.serviceId || !cfg.templateId || !cfg.publicKey) {
    return { ok: false, skipped: true, reason: "Email not configured." };
  }

  if (!toEmail) {
    return { ok: false, skipped: true, reason: "Recipient email missing." };
  }

  try {
    const sdk = await initEmailSdk();
    if (!emailJsReady) {
      try {
        if (typeof sdk.init === "function") {
          sdk.init({ publicKey: cfg.publicKey });
        }
      } catch {
        try {
          sdk.init(cfg.publicKey);
        } catch (error) {
          throw new Error(error.message || "Failed to initialise email SDK.");
        }
      }
      emailJsReady = true;
    }

    await sdk.send(cfg.serviceId, cfg.templateId, {
      to_email: toEmail,
      to_name: toName || toEmail,
      subject,
      message,
      from_name: cfg.senderName || "COM-SERVE",
      reply_to: replyTo || cfg.replyTo || "",
      ...meta,
    });

    logEmailEvent("sent", `${toEmail} - ${subject}`);
    return { ok: true };
  } catch (error) {
    logEmailEvent("failed", `${toEmail} - ${subject}: ${error.message || error}`);
    addRuntimeError("email", error.message || String(error));
    return { ok: false, skipped: false, reason: error.message || String(error) };
  }
}

function queueEmailMessage(payload) {
  void sendEmailMessage(payload);
}

function sendBroadcastEmailToHouseholds({ subject, message, meta = {} }) {
  state.data.households.forEach((household) => {
    const recipient = emailTargetOf(household);
    if (!recipient) {
      return;
    }

    queueEmailMessage({
      toEmail: recipient,
      toName: household.id,
      subject,
      message,
      meta: { householdId: household.id, ...meta },
    });
  });
}

function addAudit(action, details = "") {
  if (!state.data) {
    return;
  }

  initSecurityStructures();
  const actor = state.session ? `${state.session.role}:${state.session.id}` : "system";
  const prevHash = state.data.auditTrail.length ? state.data.auditTrail[0].hash : "GENESIS";
  const ts = new Date().toISOString();
  const hash = simpleHash(`${prevHash}|${ts}|${actor}|${action}|${details}`);

  state.data.auditTrail.unshift({
    id: uid(),
    ts,
    actor,
    action,
    details,
    prevHash,
    hash,
  });

  state.data.auditTrail = state.data.auditTrail.slice(0, 500);
}

function verifyAuditTrail() {
  initSecurityStructures();
  const list = [...state.data.auditTrail].reverse();
  let prev = "GENESIS";

  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    const expected = simpleHash(`${prev}|${item.ts}|${item.actor}|${item.action}|${item.details}`);
    if (item.prevHash !== prev || item.hash !== expected) {
      return { ok: false, brokenAt: i + 1 };
    }
    prev = item.hash;
  }

  return { ok: true, brokenAt: null };
}

function addRuntimeError(source, message) {
  if (!state.data) {
    return;
  }

  initSecurityStructures();
  state.data.runtimeErrors.unshift({
    id: uid(),
    date: new Date().toISOString(),
    source,
    message: String(message || "Unknown error").slice(0, 280),
  });
  state.data.runtimeErrors = state.data.runtimeErrors.slice(0, 60);
  saveData();
}

function bindGlobalErrorCapture() {
  window.addEventListener("error", (e) => {
    addRuntimeError("window.error", e.message || "Unhandled error");
  });

  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason && e.reason.message ? e.reason.message : String(e.reason || "Unhandled rejection");
    addRuntimeError("unhandledrejection", reason);
  });
}

function seedData() {
  const areas = ["Section A", "Section B", "Section C", "Section D"];
  const households = [];

  for (let i = 1; i <= 20; i += 1) {
    const id = `HH${String(i).padStart(3, "0")}`;
    households.push({
      id,
      displayName: `Household ${i}`,
      password: `pass${String(i).padStart(3, "0")}`,
      area: areas[(i - 1) % areas.length],
      active: i !== 7 && i !== 14,
      email: "",
      walletBalance: 10 + (i % 5) * 14,
      dues: {},
      paymentHistory: [],
    });
  }

  const data = {
    config: {
      contributionAmount: 10,
      fineAmount: 5,
      dueDays: 7,
    },
    admin: {
      username: "admin",
      password: "admin123",
    },
    households,
    funeralEvents: [],
    announcements: [
      {
        id: uid(),
        date: new Date().toISOString(),
        title: "Welcome Notice",
        body: "Welcome to COM-SERVE. Stay current to avoid fines.",
      },
    ],
    notifications: [],
    activity: [],
    auditTrail: [],
    runtimeErrors: [],
  };

  // Demo events and mixed payment scenarios.
  for (let n = 1; n <= 3; n += 1) {
    const eventDate = new Date(Date.now() - (18 - n * 5) * 86400000);
    const dueDate = new Date(eventDate.getTime() + data.config.dueDays * 86400000);
    const event = {
      id: `FNR${n}`,
      title: `Funeral Event ${n}`,
      date: eventDate.toISOString().slice(0, 10),
      dueDate: dueDate.toISOString().slice(0, 10),
      amount: data.config.contributionAmount,
    };
    data.funeralEvents.push(event);

    data.households.forEach((h, idx) => {
      if (!h.active) {
        return;
      }

      const due = {
        funeralId: event.id,
        amount: event.amount,
        status: "unpaid",
        method: null,
        paidDate: null,
        fineAccrued: 0,
        lastFineAppliedOn: event.dueDate,
      };

      if ((idx + n) % 4 !== 0 && h.walletBalance >= event.amount) {
        h.walletBalance -= event.amount;
        due.status = "paid";
        due.method = "Wallet";
        due.paidDate = new Date(eventDate.getTime() + 2 * 86400000).toISOString();
        h.paymentHistory.unshift({
          id: uid(),
          date: due.paidDate,
          amount: event.amount,
          method: "Wallet",
          type: "Contribution",
          note: `Auto deduction for ${event.title}`,
          funeralId: event.id,
        });
      }

      h.dues[event.id] = due;
    });
  }

  applyFines(data);
  data.notifications.unshift({
    id: uid(),
    date: new Date().toISOString(),
    target: "all",
    message: "System initialized with demo households.",
    level: "info",
  });
  return data;
}

function loadData() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    state.data = seedData();
    saveData();
    return;
  }

  try {
    state.data = JSON.parse(raw);
  } catch {
    state.data = seedData();
  }

  state.data.announcements = state.data.announcements || [];
  state.data.notifications = state.data.notifications || [];
  state.data.activity = state.data.activity || [];
  state.data.emailLog = state.data.emailLog || [];
  state.data.households = (state.data.households || []).map((household) => ({
    displayName: household.displayName || household.name || household.id,
    email: normalizeEmail(household.email),
    ...household,
  }));
  initSecurityStructures();
  applyFines(state.data);
  saveData();
}

function saveData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
}

function loadSession() {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) {
    state.session = null;
    return;
  }

  try {
    state.session = JSON.parse(raw);
  } catch {
    state.session = null;
    localStorage.removeItem(SESSION_KEY);
    return;
  }

  if (!state.session.lastSeen) {
    state.session.lastSeen = Date.now();
    saveSession();
    return;
  }

  if (Date.now() - Number(state.session.lastSeen) > SESSION_TTL_MS) {
    state.session = null;
    localStorage.removeItem(SESSION_KEY);
  }
}

function saveSession() {
  if (!state.session) {
    localStorage.removeItem(SESSION_KEY);
    return;
  }

  localStorage.setItem(SESSION_KEY, JSON.stringify(state.session));
}

function touchSession() {
  if (!state.session) {
    return;
  }

  state.session.lastSeen = Date.now();
  saveSession();
}

function bindSessionHeartbeat() {
  const bump = () => touchSession();
  ["click", "keydown", "mousemove", "touchstart"].forEach((evt) => {
    window.addEventListener(evt, bump, { passive: true });
  });
}

function loadLoginGuard() {
  const raw = localStorage.getItem(LOGIN_GUARD_KEY);
  if (!raw) {
    state.loginGuard = { household: { failed: 0, lockedUntil: 0 }, admin: { failed: 0, lockedUntil: 0 } };
    return;
  }

  try {
    state.loginGuard = JSON.parse(raw);
  } catch {
    state.loginGuard = { household: { failed: 0, lockedUntil: 0 }, admin: { failed: 0, lockedUntil: 0 } };
  }
}

function saveLoginGuard() {
  localStorage.setItem(LOGIN_GUARD_KEY, JSON.stringify(state.loginGuard));
}

function canAttemptLogin(kind) {
  const record = state.loginGuard[kind];
  if (!record || !record.lockedUntil) {
    return { ok: true, waitSec: 0 };
  }

  const remain = record.lockedUntil - Date.now();
  if (remain <= 0) {
    record.lockedUntil = 0;
    saveLoginGuard();
    return { ok: true, waitSec: 0 };
  }

  return { ok: false, waitSec: Math.ceil(remain / 1000) };
}

function recordFailedLogin(kind) {
  const record = state.loginGuard[kind];
  record.failed += 1;
  if (record.failed >= 5) {
    record.lockedUntil = Date.now() + 5 * 60 * 1000;
    record.failed = 0;
  }
  saveLoginGuard();
}

function clearFailedLogin(kind) {
  const record = state.loginGuard[kind];
  record.failed = 0;
  record.lockedUntil = 0;
  saveLoginGuard();
}

function addNotification(target, message, level = "info") {
  state.data.notifications.unshift({
    id: uid(),
    date: new Date().toISOString(),
    target,
    message,
    level,
  });
}

function addActivity(text) {
  state.data.activity.unshift({
    id: uid(),
    date: new Date().toISOString(),
    text,
  });
  state.data.activity = state.data.activity.slice(0, 80);
}

function getHouseholdById(id) {
  return state.data.households.find((h) => h.id === id);
}

function currentHousehold() {
  if (!state.session || state.session.role !== "household") {
    return null;
  }
  return getHouseholdById(state.session.id);
}

function latestEvent() {
  if (!state.data.funeralEvents.length) {
    return null;
  }
  return state.data.funeralEvents[state.data.funeralEvents.length - 1];
}

function totals(household) {
  let outstanding = 0;
  let fines = 0;
  let overdue = 0;

  Object.values(household.dues || {}).forEach((due) => {
    if (due.status !== "unpaid") {
      return;
    }

    outstanding += Number(due.amount || 0);
    fines += Number(due.fineAccrued || 0);

    const event = state.data.funeralEvents.find((f) => f.id === due.funeralId);
    if (event && toDate(todayISO()) > toDate(event.dueDate)) {
      overdue += 1;
    }
  });

  return { outstanding, fines, total: outstanding + fines, overdue };
}

function consistency(household) {
  const totalEvents = state.data.funeralEvents.length;
  if (!totalEvents) {
    return { paid: 0, total: 0, percent: 100 };
  }

  let paid = 0;
  state.data.funeralEvents.forEach((event) => {
    const due = household.dues[event.id];
    if (due && due.status === "paid") {
      paid += 1;
    }
  });

  return { paid, total: totalEvents, percent: Math.round((paid / totalEvents) * 100) };
}

function statusLabel(household) {
  const t = totals(household);
  if (t.overdue > 0) {
    return { text: "Overdue", cls: "overdue" };
  }
  if (t.total > 0) {
    return { text: "Pending Payment", cls: "" };
  }
  return { text: "In Good Standing", cls: "good" };
}

function nextDue(household) {
  const list = Object.values(household.dues || {})
    .filter((due) => due.status === "unpaid")
    .sort((a, b) => {
      const ea = state.data.funeralEvents.find((f) => f.id === a.funeralId);
      const eb = state.data.funeralEvents.find((f) => f.id === b.funeralId);
      return toDate(ea.dueDate) - toDate(eb.dueDate);
    });

  if (!list.length) {
    return null;
  }

  const due = list[0];
  const event = state.data.funeralEvents.find((f) => f.id === due.funeralId);
  return { due, event };
}

function applyFines(data) {
  const now = toDate(todayISO());
  const fine = Number(data.config.fineAmount || 0);
  data.notifications = data.notifications || [];

  data.households.forEach((h) => {
    Object.values(h.dues || {}).forEach((due) => {
      if (due.status === "paid") {
        return;
      }

      const event = data.funeralEvents.find((f) => f.id === due.funeralId);
      if (!event) {
        return;
      }

      const dueDate = toDate(event.dueDate);
      if (now <= dueDate) {
        return;
      }

      const lastApplied = toDate(due.lastFineAppliedOn || event.dueDate);
      const days = Math.floor((now - lastApplied) / 86400000);
      if (days <= 0) {
        return;
      }

      const added = days * fine;
      due.fineAccrued = Number(due.fineAccrued || 0) + added;
      due.lastFineAppliedOn = todayISO();
      data.notifications.unshift({
        id: uid(),
        date: new Date().toISOString(),
        target: h.id,
        message: `You missed a payment. Fine added: ${money(added)}.`,
        level: "warn",
      });
    });
  });
}

function setTheme(isDark) {
  document.body.classList.toggle("dark", Boolean(isDark));
  localStorage.setItem(THEME_KEY, isDark ? "dark" : "light");
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  setTheme(saved === "dark");
}

function bindLogout() {
  const btn = document.getElementById("logoutBtn");
  if (!btn) {
    return;
  }

  btn.addEventListener("click", () => {
    state.session = null;
    saveSession();
    window.location.href = "index.html";
  });
}

function bindThemeToggle() {
  const btn = document.getElementById("themeToggle");
  if (!btn) {
    return;
  }

  const syncLabel = () => {
    btn.textContent = document.body.classList.contains("dark") ? "Light" : "Dark";
  };

  syncLabel();
  btn.addEventListener("click", () => {
    const enableDark = !document.body.classList.contains("dark");
    setTheme(enableDark);
    syncLabel();
    showToast(`Theme changed to ${enableDark ? "dark" : "light"}.`);
  });
}

function bindMobileNav() {
  document.querySelectorAll(".nav-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = btn.dataset.navTarget;
      const nav = document.getElementById(targetId);
      if (!nav) {
        return;
      }

      nav.classList.toggle("open");
    });
  });

  document.querySelectorAll(".nav.nav-stack a").forEach((link) => {
    link.addEventListener("click", () => {
      const stack = link.closest(".nav.nav-stack");
      if (stack) {
        stack.classList.remove("open");
      }
    });
  });
}

function showToast(message, kind = "") {
  const container = document.getElementById("toastContainer");
  if (!container) {
    return;
  }

  const node = document.createElement("div");
  node.className = `toast ${kind}`.trim();
  node.textContent = message;
  container.appendChild(node);

  setTimeout(() => {
    node.remove();
  }, 2800);
}

function closeModal() {
  const root = document.getElementById("modalRoot");
  if (root) {
    root.innerHTML = "";
  }
}

function confirmModal({ title, body, confirmText = "Confirm", onConfirm }) {
  const root = document.getElementById("modalRoot");
  if (!root) {
    onConfirm();
    return;
  }

  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal">
        <h3>${title}</h3>
        <p class="muted">${body}</p>
        <div class="inline-row wrap" style="margin-top: 0.8rem;">
          <button id="modalConfirmBtn" class="btn btn-primary" type="button">${confirmText}</button>
          <button id="modalCancelBtn" class="btn btn-ghost" type="button">Cancel</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("modalCancelBtn").onclick = closeModal;
  document.getElementById("modalConfirmBtn").onclick = () => {
    closeModal();
    onConfirm();
  };
}

function markNavActive() {
  const page = window.location.pathname.split("/").pop();
  document.querySelectorAll(".nav a").forEach((a) => {
    if (a.getAttribute("href") === page) {
      a.classList.add("active");
    }
  });
}

function requireAuth(role) {
  if (!state.session) {
    window.location.href = "index.html";
    return false;
  }

  if (role && state.session.role !== role) {
    window.location.href = state.session.role === "admin" ? "admin.html" : "household.html";
    return false;
  }

  return true;
}

function payDue(household, funeralId, method) {
  const due = household.dues[funeralId];
  if (!due || due.status === "paid") {
    return { ok: false, message: "Due already paid or unavailable." };
  }

  const amount = Number(due.amount || 0) + Number(due.fineAccrued || 0);
  if (method === "Wallet" && household.walletBalance < amount) {
    return { ok: false, message: "Insufficient wallet balance." };
  }

  if (method === "Wallet") {
    household.walletBalance -= amount;
  }

  due.status = "paid";
  due.method = method;
  due.paidDate = new Date().toISOString();

  household.paymentHistory.unshift({
    id: uid(),
    date: due.paidDate,
    amount,
    method,
    type: "Contribution",
    note: `Payment for ${funeralId}`,
    funeralId,
  });

  addNotification(household.id, "Payment successful.", "info");
  addActivity(`${household.id} paid ${funeralId} via ${method}.`);
  addAudit("payment", `${household.id} -> ${funeralId} (${method})`);
  if (emailTargetOf(household)) {
    queueEmailMessage({
      toEmail: emailTargetOf(household),
      toName: household.id,
      subject: `COM-SERVE payment receipt for ${funeralId}`,
      message: `Your payment of ${money(amount)} via ${method} was successful.`,
      meta: { householdId: household.id, funeralId, method, amount: money(amount) },
    });
  }
  saveData();
  return { ok: true, message: `Payment successful via ${method}.` };
}

function topupHousehold(household, amount) {
  household.walletBalance += amount;
  household.paymentHistory.unshift({
    id: uid(),
    date: new Date().toISOString(),
    amount,
    method: "Manual",
    type: "Wallet Top Up",
    note: "Household wallet top-up",
  });
  addNotification(household.id, `Wallet credited with ${money(amount)}.`, "info");
  addAudit("wallet_topup", `${household.id} +${money(amount)}`);
  if (emailTargetOf(household)) {
    queueEmailMessage({
      toEmail: emailTargetOf(household),
      toName: household.id,
      subject: `COM-SERVE wallet top-up`,
      message: `Your wallet was credited with ${money(amount)}.`,
      meta: { householdId: household.id, amount: money(amount) },
    });
  }
  saveData();
}

function triggerFuneralEvent(title, dueDays) {
  const event = {
    id: `FNR${Date.now()}`,
    title,
    date: todayISO(),
    dueDate: new Date(Date.now() + dueDays * 86400000).toISOString().slice(0, 10),
    amount: Number(state.data.config.contributionAmount || 10),
  };

  state.data.funeralEvents.push(event);

  state.data.households.forEach((h) => {
    if (!h.active) {
      return;
    }

    const due = {
      funeralId: event.id,
      amount: event.amount,
      status: "unpaid",
      method: null,
      paidDate: null,
      fineAccrued: 0,
      lastFineAppliedOn: event.dueDate,
    };

    if (h.walletBalance >= event.amount) {
      h.walletBalance -= event.amount;
      due.status = "paid";
      due.method = "Wallet";
      due.paidDate = new Date().toISOString();
      h.paymentHistory.unshift({
        id: uid(),
        date: due.paidDate,
        amount: event.amount,
        method: "Wallet",
        type: "Contribution",
        note: `Auto deduction for ${title}`,
        funeralId: event.id,
      });
    }

    h.dues[event.id] = due;
  });

  addNotification("all", `New funeral contribution required: ${money(event.amount)}.`, "info");
  addActivity(`Admin triggered event: ${title}.`);
  addAudit("trigger_event", `${title} due ${event.dueDate}`);
  sendBroadcastEmailToHouseholds({
    subject: `COM-SERVE funeral contribution: ${title}`,
    message: `A new funeral contribution has been created. Amount: ${money(event.amount)}. Due date: ${event.dueDate}.`,
    meta: { funeralId: event.id, dueDate: event.dueDate, amount: money(event.amount) },
  });
  saveData();
}

function postAnnouncement(title, body) {
  state.data.announcements.unshift({
    id: uid(),
    date: new Date().toISOString(),
    title,
    body,
  });
  addNotification("all", `Announcement: ${title}`, "info");
  addActivity(`Admin posted announcement: ${title}.`);
  addAudit("announcement", title);
  sendBroadcastEmailToHouseholds({
    subject: `COM-SERVE announcement: ${title}`,
    message: body,
    meta: { announcementTitle: title },
  });
  saveData();
}

function exportBackupJson() {
  const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: "application/json;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `com-serve-backup-${todayISO()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  addAudit("backup_export", "Admin exported full backup");
  saveData();
}

function importBackupFromFile(file, onDone) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed || !Array.isArray(parsed.households) || !parsed.config || !parsed.admin) {
        showToast("Backup file is invalid.", "error");
        return;
      }

      state.data = parsed;
      initSecurityStructures();
      addAudit("backup_restore", `Admin restored backup from ${file.name}`);
      saveData();
      showToast("Backup restored successfully.");
      onDone();
    } catch {
      showToast("Could not read backup file.", "error");
    }
  };
  reader.readAsText(file);
}

function exportAdminCsv() {
  const rows = [["HouseholdID", "Area", "Wallet", "Outstanding", "Fines", "Status"]];
  const latest = latestEvent();

  state.data.households.forEach((h) => {
    const t = totals(h);
    const latestStatus = latest && h.dues[latest.id] ? h.dues[latest.id].status : "n/a";
    rows.push([h.id, h.area, h.walletBalance.toFixed(2), t.outstanding.toFixed(2), t.fines.toFixed(2), latestStatus]);
  });

  const csv = rows.map((r) => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `com-serve-admin-report-${todayISO()}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast("CSV report exported.");
}

function drawStatusChart(paid, unpaid) {
  const canvas = document.getElementById("chartStatus");
  if (!canvas) {
    return;
  }

  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const max = Math.max(1, paid, unpaid);
  const pad = 35;
  const barW = 110;

  ctx.fillStyle = "#555";
  ctx.font = "13px IBM Plex Sans";
  ctx.fillText("Paid vs Unpaid", 12, 18);

  const paidH = ((h - pad * 2) * paid) / max;
  const unpaidH = ((h - pad * 2) * unpaid) / max;

  ctx.fillStyle = "#1f8f4a";
  ctx.fillRect(70, h - pad - paidH, barW, paidH);
  ctx.fillStyle = "#c0392b";
  ctx.fillRect(240, h - pad - unpaidH, barW, unpaidH);

  ctx.fillStyle = "#555";
  ctx.fillText(`Paid: ${paid}`, 78, h - 10);
  ctx.fillText(`Unpaid: ${unpaid}`, 244, h - 10);
}

function drawFundsChart(series, chartId = "chartFunds", color = "#0d7a5f", label = "Collections over recent events") {
  const canvas = document.getElementById(chartId);
  if (!canvas) {
    return;
  }

  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  if (!series.length) {
    return;
  }

  const max = Math.max(1, ...series.map((s) => s.value));
  const pad = 30;

  ctx.strokeStyle = "#8ca39a";
  ctx.beginPath();
  ctx.moveTo(pad, h - pad);
  ctx.lineTo(w - pad, h - pad);
  ctx.stroke();

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();

  series.forEach((point, i) => {
    const x = pad + (i / Math.max(1, series.length - 1)) * (w - pad * 2);
    const y = h - pad - (point.value / max) * (h - pad * 2);
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });

  ctx.stroke();
  ctx.fillStyle = "#555";
  ctx.font = "13px IBM Plex Sans";
  ctx.fillText(label, 12, 18);
}

function initLoginPage() {
  if (state.session) {
    window.location.href = state.session.role === "admin" ? "admin.html" : "household.html";
    return;
  }

  const message = document.getElementById("loginMessage");
  const forgotLink = document.getElementById("forgotPasswordLink");
  const registerLink = document.getElementById("registerLink");
  const quickResetBtn = document.getElementById("quickResetBtn");
  let householdFailuresThisPage = 0;

  const syncQuickResetButton = (lastIdentifier = "") => {
    if (!quickResetBtn) {
      return;
    }

    if (householdFailuresThisPage >= 2) {
      quickResetBtn.style.display = "inline-flex";
    } else {
      quickResetBtn.style.display = "none";
    }

    quickResetBtn.onclick = () => {
      const loginIdentifier = String(lastIdentifier || document.getElementById("householdIdentifier").value || "").trim();
      const email = loginIdentifier.includes("@") ? normalizeEmail(loginIdentifier) : "";
      const target = email ? `forgot-password.html?email=${encodeURIComponent(email)}` : "forgot-password.html";
      window.location.href = target;
    };
  };

  if (forgotLink) {
    forgotLink.addEventListener("click", (e) => {
      e.preventDefault();
      window.location.href = "forgot-password.html";
    });
  }

  if (registerLink) {
    registerLink.addEventListener("click", (e) => {
      e.preventDefault();
      window.location.href = "register.html";
    });
  }

  syncQuickResetButton();

  document.getElementById("householdLoginForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const identifier = document.getElementById("householdIdentifier").value.trim();
    const password = document.getElementById("householdPassword").value;

    const h = findHouseholdByLoginIdentifier(identifier);
    if (!h || h.password !== password) {
      recordFailedLogin("household");
      householdFailuresThisPage += 1;
      message.textContent = "Invalid household credentials.";
      addAudit("login_failed", `household:${identifier || "unknown"}`);
      syncQuickResetButton(identifier);
      return;
    }

    clearFailedLogin("household");
    householdFailuresThisPage = 0;
    syncQuickResetButton();
    state.session = { role: "household", id: h.id, lastSeen: Date.now() };
    addAudit("login_success", `household:${h.id}`);
    saveSession();
    saveData();
    window.location.href = "household.html";
  });

  document.getElementById("adminLoginForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const username = document.getElementById("adminUsername").value.trim();
    const password = document.getElementById("adminPassword").value;

    if (username !== state.data.admin.username || password !== state.data.admin.password) {
      recordFailedLogin("admin");
      message.textContent = "Invalid admin credentials.";
      addAudit("login_failed", `admin:${username || "unknown"}`);
      return;
    }

    clearFailedLogin("admin");
    state.session = { role: "admin", id: "ADMIN", lastSeen: Date.now() };
    addAudit("login_success", "admin");
    saveSession();
    saveData();
    window.location.href = "admin.html";
  });
}

function registerHousehold({ name, email, area, password }) {
  const normalizedEmail = normalizeEmail(email);
  const trimmedName = String(name || "").trim();
  const trimmedArea = String(area || "").trim();
  const nextId = nextHouseholdId();

  if (!trimmedName || !trimmedArea || !normalizedEmail || !password) {
    return { ok: false, message: "Complete all registration fields." };
  }

  if (state.data.households.some((household) => normalizeEmail(household.email) === normalizedEmail)) {
    return { ok: false, message: "That email is already registered." };
  }

  state.data.households.push({
    id: nextId,
    displayName: trimmedName,
    password,
    area: trimmedArea,
    active: true,
    email: normalizedEmail,
    walletBalance: 0,
    dues: {},
    paymentHistory: [],
  });

  addAudit("register_household", `${nextId}:${normalizedEmail}`);
  addNotification(nextId, `Welcome to COM-SERVE, ${trimmedName}.`, "info");
  saveData();

  if (normalizedEmail) {
    queueEmailMessage({
      toEmail: normalizedEmail,
      toName: trimmedName,
      subject: "Welcome to COM-SERVE",
      message: `Your household account is ready. Household ID: ${nextId}. Use your email and password to log in.`,
      meta: { householdId: nextId, displayName: trimmedName, area: trimmedArea },
    });
  }

  return { ok: true, id: nextId };
}

function initForgotPasswordPage() {
  if (state.session) {
    window.location.href = state.session.role === "admin" ? "admin.html" : "household.html";
    return;
  }

  const email = document.getElementById("resetEmail");
  const form = document.getElementById("forgotPasswordForm");
  const msg = document.getElementById("forgotMessage");
  const prefillEmail = new URLSearchParams(window.location.search).get("email");
  if (prefillEmail) {
    email.value = normalizeEmail(prefillEmail);
  }

  form.onsubmit = (e) => {
    e.preventDefault();
    const requestedEmail = normalizeEmail(email.value);
    const next = document.getElementById("resetNewPassword").value;
    const confirm = document.getElementById("resetConfirmPassword").value;

    if (!requestedEmail || !/^\S+@\S+\.\S+$/.test(requestedEmail)) {
      msg.textContent = "Enter a valid registered email address.";
      msg.className = "message";
      return;
    }

    if (!next || next.length < 4) {
      msg.textContent = "New password must be at least 4 characters.";
      msg.className = "message";
      return;
    }

    if (next !== confirm) {
      msg.textContent = "Passwords do not match.";
      msg.className = "message";
      return;
    }

    const h = state.data.households.find((household) => normalizeEmail(household.email) === requestedEmail);
    if (!h) {
      msg.textContent = "No household account found for that email.";
      msg.className = "message";
      return;
    }

    h.password = next;
    addAudit("password_reset", `household:${h.id}`);
    clearFailedLogin("household");
    if (emailTargetOf(h)) {
      queueEmailMessage({
        toEmail: emailTargetOf(h),
        toName: displayNameOf(h),
        subject: "COM-SERVE password reset confirmation",
        message: "Your household password has been updated successfully.",
        meta: { householdId: h.id },
      });
    }
    saveData();
    msg.textContent = "Password reset successful. Redirecting to login...";
    msg.className = "message ok";
    showToast("Password reset successful.");
    setTimeout(() => {
      window.location.href = "index.html";
    }, 1200);
  };
}

function initRegisterPage() {
  if (state.session) {
    window.location.href = state.session.role === "admin" ? "admin.html" : "household.html";
    return;
  }

  const form = document.getElementById("registerForm");
  const message = document.getElementById("registerMessage");
  const emailInput = document.getElementById("registerEmail");
  const nameInput = document.getElementById("registerName");
  const areaInput = document.getElementById("registerArea");
  const passwordInput = document.getElementById("registerPassword");
  const confirmInput = document.getElementById("registerConfirmPassword");

  form.onsubmit = (e) => {
    e.preventDefault();

    if (passwordInput.value !== confirmInput.value) {
      message.textContent = "Passwords do not match.";
      message.className = "message";
      return;
    }

    const result = registerHousehold({
      name: nameInput.value,
      email: emailInput.value,
      area: areaInput.value,
      password: passwordInput.value,
    });

    if (!result.ok) {
      message.textContent = result.message;
      message.className = "message";
      return;
    }

    state.session = { role: "household", id: result.id, lastSeen: Date.now() };
    saveSession();
    message.textContent = "Registration successful. Redirecting to your dashboard...";
    message.className = "message ok";
    showToast("Registration successful.");
    setTimeout(() => {
      window.location.href = "household.html";
    }, 1200);
  };
}

function renderHouseholdDashboard() {
  const h = currentHousehold();
  if (!h) {
    return;
  }

  const t = totals(h);
  const c = consistency(h);
  const status = statusLabel(h);
  const dueInfo = nextDue(h);

  document.getElementById("walletBalance").textContent = money(h.walletBalance);
  document.getElementById("finesOwed").textContent = money(t.fines);
  const consistencyText = document.getElementById("consistencyText");
  if (consistencyText) {
    consistencyText.textContent = `${c.paid} of ${c.total} events paid (${c.percent}%)`;
  }

  const statusEl = document.getElementById("paymentStatus");
  statusEl.textContent = status.text;
  statusEl.className = `status-pill ${status.cls}`;

  if (!dueInfo) {
    document.getElementById("upcomingDueTitle").textContent = "No pending dues";
    document.getElementById("upcomingDueDate").textContent = "-";
    document.getElementById("upcomingDueAmount").textContent = money(0);
  } else {
    const totalDue = Number(dueInfo.due.amount || 0) + Number(dueInfo.due.fineAccrued || 0);
    document.getElementById("upcomingDueTitle").textContent = dueInfo.event.title;
    document.getElementById("upcomingDueDate").textContent = `Due: ${dueInfo.event.dueDate}`;
    document.getElementById("upcomingDueAmount").textContent = money(totalDue);
  }

  document.getElementById("householdBanner").textContent =
    t.overdue > 0
      ? `You have ${t.overdue} overdue contribution(s). Pay immediately to stop additional fines.`
      : t.total > 0
        ? "You have pending contributions due soon."
        : "Your account is in good standing.";

  document.getElementById("topupBtn").onclick = () => {
    const amount = Number(document.getElementById("topupAmount").value);
    if (!Number.isFinite(amount) || amount <= 0) {
      showToast("Enter a valid top-up amount.", "error");
      return;
    }
    confirmModal({
      title: "Confirm Top-Up",
      body: `Top up wallet by ${money(amount)}?`,
      confirmText: "Top Up",
      onConfirm: () => {
        topupHousehold(h, amount);
        document.getElementById("topupAmount").value = "";
        renderHouseholdDashboard();
        showToast(`Wallet topped up by ${money(amount)}.`);
      },
    });
  };

  document.getElementById("payNowBtn").onclick = () => {
    const next = nextDue(h);
    if (!next) {
      showToast("No unpaid dues found.");
      return;
    }

    const totalDue = Number(next.due.amount || 0) + Number(next.due.fineAccrued || 0);
    confirmModal({
      title: "Confirm Payment",
      body: `Pay ${money(totalDue)} for ${next.event.title} via Wallet?`,
      confirmText: "Pay Now",
      onConfirm: () => {
        const result = payDue(h, next.due.funeralId, "Wallet");
        if (!result.ok) {
          document.getElementById("householdBanner").textContent = result.message;
          showToast(result.message, "error");
        } else {
          showToast(result.message);
        }
        renderHouseholdDashboard();
      },
    });
  };

  const stickyPayBtn = document.getElementById("stickyPayBtn");
  if (stickyPayBtn) {
    stickyPayBtn.onclick = document.getElementById("payNowBtn").onclick;
  }

  const alerts = state.data.notifications
    .filter((n) => n.target === "all" || n.target === h.id)
    .slice(0, 10);
  const alertBox = document.getElementById("householdAlerts");
  alertBox.innerHTML = alerts.length
    ? alerts
        .map((a) => `<div class="list-item ${a.level === "warn" ? "warn" : ""}">${new Date(a.date).toLocaleString()} - ${a.message}</div>`)
        .join("")
    : '<div class="list-item">No alerts.</div>';

  const history = [...(h.paymentHistory || [])].sort((a, b) => new Date(b.date) - new Date(a.date));
  const body = document.getElementById("householdHistoryBody");
  body.innerHTML = history.length
    ? history
        .slice(0, 20)
        .map(
          (p) => `
      <tr>
        <td>${new Date(p.date).toLocaleString()}</td>
        <td>${money(p.amount)}</td>
        <td>${p.method}</td>
        <td>${p.type}</td>
        <td>${p.note || "-"}</td>
      </tr>`
        )
        .join("")
    : '<tr><td colspan="5">No payment history.</td></tr>';

  drawHouseholdProgressChart(h);
}

function drawHouseholdProgressChart(household) {
  const canvas = document.getElementById("householdProgressChart");
  if (!canvas) {
    return;
  }

  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const events = state.data.funeralEvents.slice(-8);
  const values = events.map((event) => {
    const due = household.dues[event.id];
    return due && due.status === "paid" ? 1 : 0;
  });

  const pad = 34;
  const barW = Math.max(16, (w - pad * 2) / Math.max(values.length, 1) - 14);

  ctx.fillStyle = "#5f6b62";
  ctx.font = "13px IBM Plex Sans";
  ctx.fillText("Recent contribution completion", 12, 18);

  values.forEach((v, i) => {
    const x = pad + i * (barW + 14);
    const barH = v ? h - pad * 2 : (h - pad * 2) * 0.26;
    const y = h - pad - barH;
    ctx.fillStyle = v ? "#1f8f4a" : "#c0392b";
    ctx.fillRect(x, y, barW, barH);
  });
}

function initHouseholdDashboardPage() {
  if (!requireAuth("household")) {
    return;
  }
  renderHouseholdDashboard();
}

function renderPaymentsPage() {
  const h = currentHousehold();
  if (!h) {
    return;
  }

  const dues = Object.values(h.dues || {}).filter((d) => d.status === "unpaid");
  const select = document.getElementById("paymentDueSelect");
  select.innerHTML = dues.length
    ? dues
        .map((due) => {
          const event = state.data.funeralEvents.find((f) => f.id === due.funeralId);
          const totalDue = Number(due.amount || 0) + Number(due.fineAccrued || 0);
          return `<option value="${due.funeralId}">${event ? event.title : due.funeralId} - ${money(totalDue)}</option>`;
        })
        .join("")
    : '<option value="">No unpaid dues</option>';

  const updateSummary = () => {
    const id = select.value;
    const due = h.dues[id];
    const totalDue = due ? Number(due.amount || 0) + Number(due.fineAccrued || 0) : 0;
    document.getElementById("selectedDueAmount").textContent = money(totalDue);
    document.getElementById("walletAvailable").textContent = money(h.walletBalance);
    document.getElementById("selectedDueStatus").textContent = due ? due.status : "n/a";
  };

  select.onchange = updateSummary;
  updateSummary();

  const result = document.getElementById("paymentResult");

  const handlePay = (method) => {
    if (!select.value) {
      result.textContent = "No due selected.";
      result.className = "message";
      showToast("No due selected.", "error");
      return;
    }

    const selected = h.dues[select.value];
    const totalDue = Number(selected.amount || 0) + Number(selected.fineAccrued || 0);
    confirmModal({
      title: "Confirm Payment",
      body: `Pay ${money(totalDue)} using ${method}?`,
      confirmText: "Confirm",
      onConfirm: () => {
        const response = payDue(h, select.value, method);
        result.textContent = response.message;
        result.className = `message ${response.ok ? "ok" : ""}`;
        showToast(response.message, response.ok ? "" : "error");
        renderPaymentsPage();
      },
    });
  };

  document.getElementById("payWalletBtn").onclick = () => handlePay("Wallet");
  document.getElementById("payQrBtn").onclick = () => handlePay("QR");
  document.getElementById("payCardBtn").onclick = () => handlePay("Card");

  const recentBody = document.getElementById("recentPaymentBody");
  const recent = [...(h.paymentHistory || [])].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 15);
  recentBody.innerHTML = recent.length
    ? recent
        .map(
          (p) => `
      <tr>
        <td>${new Date(p.date).toLocaleString()}</td>
        <td>${money(p.amount)}</td>
        <td>${p.method}</td>
        <td>${p.type}</td>
        <td>${p.note || "-"}</td>
      </tr>`
        )
        .join("")
    : '<tr><td colspan="5">No payment history.</td></tr>';
}

function initPaymentsPage() {
  if (!requireAuth("household")) {
    return;
  }
  renderPaymentsPage();
}

function initAnnouncementsPage() {
  if (!requireAuth("household")) {
    return;
  }

  const h = currentHousehold();
  const list = document.getElementById("announcementsList");
  list.innerHTML = state.data.announcements.length
    ? state.data.announcements
        .map((a) => `<div class="list-item"><strong>${a.title}</strong><br>${a.body}<br><small>${new Date(a.date).toLocaleString()}</small></div>`)
        .join("")
    : '<div class="list-item">No announcements available.</div>';

  const notices = state.data.notifications
    .filter((n) => n.target === "all" || n.target === h.id)
    .slice(0, 12);
  const noticeList = document.getElementById("noticesList");
  noticeList.innerHTML = notices.length
    ? notices
        .map((n) => `<div class="list-item ${n.level === "warn" ? "warn" : ""}">${new Date(n.date).toLocaleString()} - ${n.message}</div>`)
        .join("")
    : '<div class="list-item">No notifications.</div>';
}

function initSettingsPage() {
  if (!requireAuth("household")) {
    return;
  }

  const h = currentHousehold();
  const name = displayNameOf(h);
  document.getElementById("profileName").textContent = name;
  document.getElementById("profileId").textContent = h.id;
  document.getElementById("profileArea").textContent = h.area;
  const profileEmail = document.getElementById("profileEmail");
  if (profileEmail) {
    profileEmail.textContent = h.email || "Not set";
  }

  const householdEmail = document.getElementById("householdEmail");
  if (householdEmail) {
    householdEmail.value = h.email || "";
  }

  const toggle = document.getElementById("settingsDarkToggle");
  toggle.checked = document.body.classList.contains("dark");
  toggle.onchange = () => {
    setTheme(toggle.checked);
    showToast(`Theme switched to ${toggle.checked ? "dark" : "light"}.`);
  };

  const msg = document.getElementById("settingsMessage");
  document.getElementById("changePasswordForm").onsubmit = (e) => {
    e.preventDefault();
    const current = document.getElementById("currentPassword").value;
    const next = document.getElementById("newPassword").value;

    if (current !== h.password) {
      msg.textContent = "Current password is incorrect.";
      msg.className = "message";
      return;
    }

    if (!next || next.length < 4) {
      msg.textContent = "New password must be at least 4 characters.";
      msg.className = "message";
      return;
    }

    h.password = next;
    addAudit("password_change", `${h.id}`);
    saveData();
    msg.textContent = "Password updated successfully.";
    msg.className = "message ok";
    showToast("Password updated successfully.");

    document.getElementById("currentPassword").value = "";
    document.getElementById("newPassword").value = "";
  };

  const emailMsg = document.getElementById("emailSettingsMessage");
  const emailForm = document.getElementById("emailSettingsForm");
  if (emailForm) {
    emailForm.onsubmit = (e) => {
      e.preventDefault();
      const nextEmail = document.getElementById("householdEmail").value.trim();
      if (nextEmail && !/^\S+@\S+\.\S+$/.test(nextEmail)) {
        emailMsg.textContent = "Enter a valid email address.";
        emailMsg.className = "message";
        return;
      }

      h.email = nextEmail;
      addAudit("email_update", `${h.id}:${nextEmail || "cleared"}`);
      saveData();
      if (profileEmail) {
        profileEmail.textContent = h.email || "Not set";
      }
      emailMsg.textContent = h.email ? `Email saved: ${h.email}` : "Email address cleared.";
      emailMsg.className = "message ok";
      showToast("Email address saved.");
    };
  }
}

function renderAdminPage() {
  const households = state.data.households;
  const latest = latestEvent();

  let paid = 0;
  let unpaid = 0;
  let collected = 0;
  let fines = 0;
  initSecurityStructures();

  households.forEach((h) => {
    const t = totals(h);
    fines += t.fines;

    h.paymentHistory.forEach((p) => {
      if (p.type === "Contribution") {
        collected += Number(p.amount || 0);
      }
    });

    if (latest && h.active) {
      const due = h.dues[latest.id];
      if (due && due.status === "paid") {
        paid += 1;
      } else {
        unpaid += 1;
      }
    }
  });

  document.getElementById("adminMetricHouseholds").textContent = String(households.length);
  document.getElementById("adminMetricPaidUnpaid").textContent = `${paid} / ${unpaid}`;
  document.getElementById("adminMetricCollected").textContent = money(collected);
  document.getElementById("adminMetricFines").textContent = money(fines);
  const runtimeCount = state.data.runtimeErrors.length;
  const runtimeMetric = document.getElementById("adminMetricRuntime");
  if (runtimeMetric) {
    runtimeMetric.textContent = String(runtimeCount);
  }

  const auditMetric = document.getElementById("adminMetricAudit");
  if (auditMetric) {
    auditMetric.textContent = String(state.data.auditTrail.length);
  }

  drawStatusChart(paid, unpaid);

  const series = state.data.funeralEvents.slice(-8).map((event) => {
    let sum = 0;
    households.forEach((h) => {
      const due = h.dues[event.id];
      if (due && due.status === "paid") {
        sum += Number(due.amount || 0) + Number(due.fineAccrued || 0);
      }
    });
    return { label: event.title, value: sum };
  });
  drawFundsChart(series);

  const fineSeries = state.data.funeralEvents.slice(-8).map((event) => {
    let amount = 0;
    households.forEach((household) => {
      const due = household.dues[event.id];
      if (due && due.status === "unpaid") {
        amount += Number(due.fineAccrued || 0);
      }
    });
    return { label: event.title, value: amount };
  });
  drawFundsChart(fineSeries, "chartFines", "#d97706", "Fines trend");

  const query = document.getElementById("adminSearch").value.trim().toUpperCase();
  const filtered = households.filter((h) => !query || h.id.includes(query) || displayNameOf(h).toUpperCase().includes(query));

  const body = document.getElementById("adminHouseholdBody");
  body.innerHTML = filtered.length
    ? filtered
        .map((h) => {
          const t = totals(h);
          const latestStatus = latest && h.dues[latest.id] ? h.dues[latest.id].status : "n/a";
          return `
      <tr>
        <td>${h.id}</td>
        <td>${displayNameOf(h)}</td>
        <td>${h.area}</td>
        <td>${h.email || "-"}</td>
        <td>${money(h.walletBalance)}</td>
        <td>${money(t.outstanding)}</td>
        <td>${money(t.fines)}</td>
        <td><span class="tag ${latestStatus === "paid" ? "good" : "bad"}">${latestStatus}</span></td>
        <td><button class="btn btn-ghost clear-fines-btn" data-id="${h.id}" type="button">Clear Fines</button></td>
      </tr>`;
        })
        .join("")
    : '<tr><td colspan="8">No households found.</td></tr>';

  body.querySelectorAll(".clear-fines-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const h = getHouseholdById(id);
      if (!h) {
        return;
      }

      Object.values(h.dues || {}).forEach((due) => {
        if (due.status === "unpaid") {
          due.fineAccrued = 0;
          due.lastFineAppliedOn = todayISO();
        }
      });

      addNotification(id, "Admin cleared your outstanding fines.", "info");
      addActivity(`Admin cleared fines for ${id}.`);
      addAudit("clear_fines", id);
      saveData();
      renderAdminPage();
      showToast(`Fines cleared for ${id}.`);
    });
  });

  const activity = document.getElementById("adminActivity");
  activity.innerHTML = state.data.activity.length
    ? state.data.activity.slice(0, 12).map((a) => `<div class="list-item">${new Date(a.date).toLocaleString()} - ${a.text}</div>`).join("")
    : '<div class="list-item">No activity yet.</div>';

  const runtimeList = document.getElementById("adminRuntime");
  if (runtimeList) {
    runtimeList.innerHTML = state.data.runtimeErrors.length
      ? state.data.runtimeErrors
          .slice(0, 8)
          .map((e) => `<div class="list-item warn">${new Date(e.date).toLocaleString()} - ${e.source}: ${e.message}</div>`)
          .join("")
      : '<div class="list-item">No runtime errors captured.</div>';
  }
}

function initAdminPage() {
  if (!requireAuth("admin")) {
    return;
  }

  const emailConfigMsg = document.getElementById("emailConfigMessage");
  const cfg = emailConfig();
  document.getElementById("emailServiceId").value = cfg.serviceId || "";
  document.getElementById("emailTemplateId").value = cfg.templateId || "";
  document.getElementById("emailPublicKey").value = cfg.publicKey || "";
  document.getElementById("emailSenderName").value = cfg.senderName || "COM-SERVE";
  document.getElementById("emailReplyTo").value = cfg.replyTo || "";

  document.getElementById("saveEmailConfigBtn").onclick = () => {
    updateEmailConfig({
      serviceId: document.getElementById("emailServiceId").value.trim(),
      templateId: document.getElementById("emailTemplateId").value.trim(),
      publicKey: document.getElementById("emailPublicKey").value.trim(),
      senderName: document.getElementById("emailSenderName").value.trim() || "COM-SERVE",
      replyTo: document.getElementById("emailReplyTo").value.trim(),
    });
    emailConfigMsg.textContent = "Email setup saved.";
    emailConfigMsg.className = "message ok";
    showToast("Email setup saved.");
  };

  document.getElementById("sendTestEmailBtn").onclick = async () => {
    const recipient = document.getElementById("emailTestRecipient").value.trim();
    const subject = document.getElementById("emailTestSubject").value.trim() || "COM-SERVE email test";
    const message = document.getElementById("emailTestMessage").value.trim() || "This is a test message from COM-SERVE.";

    if (!recipient) {
      emailConfigMsg.textContent = "Enter a test recipient email first.";
      emailConfigMsg.className = "message";
      return;
    }

    emailConfigMsg.textContent = "Sending test email...";
    emailConfigMsg.className = "message";
    const response = await sendEmailMessage({
      toEmail: recipient,
      toName: recipient,
      subject,
      message,
      meta: { type: "test" },
    });

    if (response.ok) {
      emailConfigMsg.textContent = "Test email sent successfully.";
      emailConfigMsg.className = "message ok";
      showToast("Test email sent.");
    } else if (response.skipped) {
      emailConfigMsg.textContent = response.reason || "Email is not configured yet.";
      emailConfigMsg.className = "message";
    } else {
      emailConfigMsg.textContent = `Email failed: ${response.reason}`;
      emailConfigMsg.className = "message";
      showToast("Test email failed.", "error");
    }
  };

  document.getElementById("triggerFuneralBtn").onclick = () => {
    const title = document.getElementById("funeralTitle").value.trim() || `Funeral Event ${state.data.funeralEvents.length + 1}`;
    const dueDays = Math.max(1, Number(document.getElementById("funeralDueDays").value) || 7);
    confirmModal({
      title: "Trigger Funeral Event",
      body: `Create ${title} and charge all active households ${money(state.data.config.contributionAmount)}?`,
      confirmText: "Trigger",
      onConfirm: () => {
        triggerFuneralEvent(title, dueDays);
        document.getElementById("funeralTitle").value = "";
        renderAdminPage();
        showToast("Funeral event triggered successfully.");
      },
    });
  };

  document.getElementById("postAnnouncementBtn").onclick = () => {
    const title = document.getElementById("adminAnnouncementTitle").value.trim();
    const body = document.getElementById("adminAnnouncementBody").value.trim();
    if (!title || !body) {
      return;
    }
    postAnnouncement(title, body);
    document.getElementById("adminAnnouncementTitle").value = "";
    document.getElementById("adminAnnouncementBody").value = "";
    renderAdminPage();
    showToast("Announcement posted.");
  };

  document.getElementById("adminExportCsv").onclick = exportAdminCsv;
  const backupBtn = document.getElementById("adminExportBackup");
  if (backupBtn) {
    backupBtn.onclick = () => {
      exportBackupJson();
      showToast("Backup exported.");
    };
  }

  const verifyAuditBtn = document.getElementById("adminVerifyAudit");
  if (verifyAuditBtn) {
    verifyAuditBtn.onclick = () => {
      const result = verifyAuditTrail();
      if (result.ok) {
        showToast("Audit chain is valid.");
      } else {
        showToast(`Audit chain broken at entry ${result.brokenAt}.`, "error");
      }
    };
  }

  const restoreInput = document.getElementById("adminRestoreBackupFile");
  const restoreBtn = document.getElementById("adminRestoreBackup");
  if (restoreBtn && restoreInput) {
    restoreBtn.onclick = () => {
      const file = restoreInput.files && restoreInput.files[0];
      if (!file) {
        showToast("Select a backup file first.", "error");
        return;
      }

      confirmModal({
        title: "Restore Backup",
        body: "This will replace all current data. Continue?",
        confirmText: "Restore",
        onConfirm: () => importBackupFromFile(file, renderAdminPage),
      });
    };
  }

  document.getElementById("adminSearch").oninput = renderAdminPage;

  renderAdminPage();
}

function initPage() {
  loadData();
  loadLoginGuard();
  loadSession();
  initTheme();
  bindGlobalErrorCapture();
  bindSessionHeartbeat();
  bindLogout();
  bindThemeToggle();
  bindMobileNav();
  markNavActive();

  const page = document.body.dataset.page;

  if (page === "login") {
    initLoginPage();
    return;
  }

  if (page === "register") {
    initRegisterPage();
    return;
  }

  if (page === "forgot-password") {
    initForgotPasswordPage();
    return;
  }

  if (page === "household-dashboard") {
    initHouseholdDashboardPage();
    return;
  }

  if (page === "payments") {
    initPaymentsPage();
    return;
  }

  if (page === "announcements") {
    initAnnouncementsPage();
    return;
  }

  if (page === "settings") {
    initSettingsPage();
    return;
  }

  if (page === "admin-dashboard") {
    initAdminPage();
  }
}

document.addEventListener("DOMContentLoaded", initPage);
