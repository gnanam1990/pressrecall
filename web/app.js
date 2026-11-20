/* PressRecall operator console — zero-dependency SPA.
   Session = scoped bearer token minted via /api/auth/token.
   Field evidence supports an offline queue that survives reloads and
   retries with the ORIGINAL client key (server dedupes by clientKey). */

// ---------- tiny dom ----------
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "disabled") el.disabled = true;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
};
const $ = (sel, root = document) => root.querySelector(sel);
const main = () => $("#main");
const esc = (s) => String(s ?? "");

const toast = (msg) => {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 3200);
};

// ---------- session ----------
const SESSION_KEY = "pr_session";
const session = {
  get() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); }
    catch { return null; }
  },
  set(s) { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); },
  clear() { localStorage.removeItem(SESSION_KEY); },
};

async function api(path, { method = "GET", body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  const s = session.get();
  if (auth && s?.token) headers["authorization"] = `Bearer ${s.token}`;
  const res = await fetch(path, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && auth) {
    session.clear();
    location.hash = "#/signin";
    throw new Error(data?.error?.message || "sign-in required");
  }
  if (!res.ok) {
    const err = new Error(data?.error?.message || `request failed (${res.status})`);
    err.status = res.status;
    err.code = data?.error?.code;
    throw err;
  }
  return data;
}

// ---------- demo actors (local credentials, documented in README) ----------
const DEMO_ACTORS = [
  { id: "act_buyer", role: "buyer", secret: "sec_buyer", label: "Buyer — approves quotes, releases export" },
  { id: "act_agent", role: "agent", secret: "sec_agent", label: "Agent — runs plan, intents, settlement" },
  { id: "act_coord", role: "coordinator", secret: "sec_coord", label: "Coordinator — field scans & evidence" },
  { id: "act_ops", role: "operator", secret: "sec_ops", label: "Operator — registers deployed redirects" },
  { id: "act_printer_a", role: "printer", secret: "sec_printer_a", label: "Printer A — quotes, proofs, jobs" },
  { id: "act_printer_b", role: "printer", secret: "sec_printer_b", label: "Printer B — competing quotes" },
];

async function actAs(actorId) {
  const a = DEMO_ACTORS.find((x) => x.id === actorId);
  const res = await api("/api/auth/token", {
    method: "POST", auth: false,
    body: { actorId: a.id, secret: a.secret },
  });
  session.set({ token: res.token, actor: res.actor });
  renderActorChip();
  // Leaving the printer role sends the actor back to the last campaign.
  const last = sessionStorage.getItem("pr_last_campaign");
  if (res.actor.role !== "printer" && location.hash === "#/shop" && last) {
    location.hash = last;
  }
  toast(`acting as ${res.actor.role} (${res.actor.id})`);
}

function renderActorChip() {
  const s = session.get();
  $("#actor-chip").innerHTML = s
    ? `acting as <b>${esc(s.actor.role)}</b> · <span class="mono">${esc(s.actor.id)}</span>`
    : "";
  $("#switch-btn").hidden = !s;
}

function renderActorPanel() {
  const panel = $("#actor-panel");
  panel.hidden = !panel.hidden;
  if (panel.hidden) return;
  panel.innerHTML = "";
  panel.append(
    h("span", { class: "muted" }, "Demo sign-in — pick a role. Local credentials are listed in the README."),
    h("div", { class: "who" },
      DEMO_ACTORS.map((a) =>
        h("button", {
          class: "ghost small", type: "button",
          onclick: async () => {
            try { await actAs(a.id); panel.hidden = true; route(); }
            catch (e) { toast(e.message); }
          },
        }, a.id.endsWith("_a") ? `${a.role} A` : a.id.endsWith("_b") ? `${a.role} B` : a.role))
    )
  );
}

// ---------- offline evidence queue ----------
const QUEUE_KEY = "pr_queue";
const queue = {
  all() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); }
    catch { return []; }
  },
  save(items) { localStorage.setItem(QUEUE_KEY, JSON.stringify(items)); renderQueueBadge(); },
  add(item) { const q = queue.all(); q.push(item); queue.save(q); },
  remove(clientKey) { queue.save(queue.all().filter((q) => q.clientKey !== clientKey)); },
};

async function flushQueue() {
  const items = queue.all();
  if (!items.length) return;
  let sent = 0;
  for (const item of items) {
    try {
      await api(
        `/api/campaigns/${item.campaignId}/placements/${item.placementId}/evidence`,
        { method: "POST", body: {
          clientKey: item.clientKey,
          assetText: item.assetText,
          assetBase64: item.assetBase64,
          revisionDigestSeen: item.revisionDigestSeen,
          note: item.note,
        } }
      );
      queue.remove(item.clientKey);
      sent++;
    } catch (e) {
      if (e.status && e.status < 500 && e.code !== "conflict") {
        // authoritative rejection — keep the row but flag it
        const q = queue.all();
        const it = q.find((x) => x.clientKey === item.clientKey);
        if (it) { it.error = e.message; queue.save(q); }
      }
    }
  }
  if (sent) toast(`${sent} queued upload(s) delivered`);
  renderQueueBadge();
}

function renderQueueBadge() {
  const n = queue.all().length;
  const badge = $("#queue-badge");
  badge.hidden = n === 0;
  badge.textContent = n ? `${n} queued offline` : "";
}

window.addEventListener("online", flushQueue);

// ---------- formatting ----------
const short = (s, n = 12) => (s && s.length > n ? `${s.slice(0, n)}…` : s || "—");
const atoms = (n, token = "") => `${Number(n).toLocaleString()} ${token}`.trim();

const STATE_CHIP = {
  VERIFIED: "ok", CURRENT: "ok", CONFIRMED: "ok", DELIVERED: "ok",
  REPRINT: "warn", REDIRECT_CHECK: "warn", OBSERVED: "warn", REQUESTED: "warn",
  RESERVED: "warn", OPEN: "warn", SUBMITTED: "warn", PENDING: "warn", AMBIGUOUS: "warn",
  UNKNOWN: "info", MISMATCH: "bad", DISPUTED: "bad", DEFINITIVELY_FAILED: "bad",
  CLOSED_WITH_EXCEPTIONS: "warn",
};
const chip = (state, extra) =>
  h("span", { class: `chip ${STATE_CHIP[state] || ""} ${extra || ""}`, "data-state": state }, state || "—");
const sandboxChip = (ledger) =>
  ledger && ledger.startsWith("SANDBOX")
    ? h("span", { class: "chip sandbox" }, `sandbox · ${ledger}`)
    : chip(ledger, "info");

const NEEDS = { // which roles can press each button (diagnostic only)
  buyer: ["buyer"], agent: ["agent"], coord: ["coordinator"],
  buyerAgent: ["buyer", "agent"], fieldOps: ["buyer", "coordinator", "agent"],
  printer: ["printer"], ops: ["operator"],
};
function actionButton(label, roles, onclick, cls = "") {
  const s = session.get();
  const ok = s && roles.includes(s.actor.role);
  const btn = h("button", {
    type: "button", class: `small ${cls}`, disabled: !ok,
    title: ok ? "" : `requires ${roles.join(" or ")} role`,
    onclick,
  }, label);
  return btn;
}
const errBox = (msg) => h("div", { class: "err", role: "alert" }, msg);
let errSeq = 0;
function fieldError(id) { return h("div", { class: "err", role: "alert", id, hidden: true }); }
function showErr(el, msg) { el.hidden = !msg; el.textContent = msg || ""; }

// ---------- shared fetchers ----------
async function loadCampaignBundle(cid) {
  const role = session.get()?.actor?.role;
  const canQuotes = ["buyer", "agent"].includes(role);
  const canRfq = ["buyer", "agent", "coordinator"].includes(role);
  const canEvidence = ["buyer", "agent", "coordinator"].includes(role);
  // 403-tolerant fetch: permission loss disables writes but keeps a
  // redacted diagnostic view instead of blanking the workspace.
  const safe = (p, fb) => p.catch((e) => (e.status === 403 ? fb : Promise.reject(e)));
  const empty = (k) => ({ [k]: [] });

  const [health, campaign, placements, revisions, qrs, quotes, approvals, grants, intents, spends] =
    await Promise.all([
      api("/api/health", { auth: false }),
      api(`/api/campaigns/${cid}`),
      api(`/api/campaigns/${cid}/placements`),
      api(`/api/campaigns/${cid}/revisions`),
      canRfq ? safe(api(`/api/campaigns/${cid}/quote-requests`), empty("quoteRequests"))
             : empty("quoteRequests"),
      canQuotes ? safe(api(`/api/campaigns/${cid}/quotes`), empty("quotes"))
                : empty("quotes"),
      canQuotes ? safe(api(`/api/campaigns/${cid}/approvals`), empty("approvals"))
                : empty("approvals"),
      canQuotes ? safe(api(`/api/campaigns/${cid}/grants`), empty("grants"))
                : empty("grants"),
      canQuotes ? safe(api(`/api/campaigns/${cid}/order-intents`), empty("intents"))
                : empty("intents"),
      canQuotes ? safe(api(`/api/campaigns/${cid}/spends`), { spends: [], receipts: [] })
                : { spends: [], receipts: [] },
    ]);
  const proofsByQr = {};
  if (canQuotes) {
    await Promise.all((qrs.quoteRequests || []).map(async (qr) => {
      try {
        const p = await api(`/api/campaigns/${cid}/quote-requests/${qr.id}/proofs`);
        proofsByQr[qr.id] = p.proofs;
      } catch { proofsByQr[qr.id] = []; }
    }));
  }
  const evidenceByPid = {};
  if (canEvidence) {
    await Promise.all((placements.placements || []).map(async (p) => {
      const e = await api(`/api/campaigns/${cid}/placements/${p.id}/evidence`);
      evidenceByPid[p.id] = e.evidence;
    }));
  }
  return {
    ledgerLabel: health.chain,
    campaign, placements: placements.placements, revisions: revisions.revisions,
    quoteRequests: qrs.quoteRequests, quotes: quotes.quotes,
    approvals: approvals.approvals, proofsByQr, grants: grants.grants,
    intents: intents.intents, spends: spends.spends, receipts: spends.receipts,
    evidenceByPid,
  };
}

// ---------- views ----------
async function viewSignin() {
  main().innerHTML = "";
  const errId = `e${++errSeq}`;
  const actorSel = h("select", { id: "si-actor", "aria-describedby": errId },
    DEMO_ACTORS.map((a) => h("option", { value: a.id }, `${a.role} — ${a.id}`)));
  const secretIn = h("input", {
    id: "si-secret", type: "password", autocomplete: "current-password",
    "aria-describedby": errId,
  });
  const err = fieldError(errId);
  main().append(
    h("div", { class: "card signin" },
      h("h1", {}, "Sign in"),
      h("p", { class: "muted" },
        "PressRecall runs locally with scoped bearer tokens. Pick a demo actor and enter its secret (README documents the local credentials)."),
      h("label", { for: "si-actor" }, "Actor"),
      actorSel,
      h("label", { for: "si-secret" }, "Secret"),
      secretIn,
      err,
      h("div", { class: "row", style: "margin-top:.8rem" },
        h("button", {
          class: "accent", type: "button",
          onclick: async () => {
            try {
              const res = await api("/api/auth/token", {
                method: "POST", auth: false,
                body: { actorId: actorSel.value, secret: secretIn.value },
              });
              session.set({ token: res.token, actor: res.actor });
              renderActorChip();
              location.hash = "#/";
            } catch (e) { showErr(err, e.message); }
          },
        }, "Sign in")),
      h("details", { class: "demo-creds" },
        h("summary", {}, "Local demo credentials"),
        h("table", {},
          h("tbody", {},
            DEMO_ACTORS.map((a) =>
              h("tr", {},
                h("td", {}, h("code", {}, a.id)),
                h("td", {}, a.role),
                h("td", {}, h("code", {}, a.secret))))))))
  );
  actorSel.onchange = () => {
    const a = DEMO_ACTORS.find((x) => x.id === actorSel.value);
    secretIn.value = a?.secret ?? "";
  };
  actorSel.onchange();
}

async function viewCampaigns() {
  const s = session.get();
  if (!s) return viewSignin();
  main().innerHTML = "";
  const err = fieldError(`e${++errSeq}`);
  const list = h("div", { class: "grid" }, h("p", { class: "muted" }, "Loading campaigns…"));

  main().append(
    h("div", { class: "row between" },
      h("h1", {}, "Campaigns"),
      s.actor.role === "printer"
        ? h("a", { href: "#/shop" }, h("button", { class: "accent" }, "Open print shop"))
        : h("span", {})),
    err, list);

  try {
    const { campaigns } = await api("/api/campaigns");
    list.innerHTML = "";
    if (!campaigns.length) {
      list.append(h("div", { class: "card empty" },
        h("p", {}, "No campaigns yet."),
        h("p", { class: "muted" }, "The first authorized action is creating a campaign with a budget cap."),
      ));
    }
    for (const c of campaigns) {
      list.append(h("a", { href: `#/c/${c.id}`, style: "text-decoration:none;color:inherit" },
        h("div", { class: "card site-card" },
          h("div", { class: "head" },
            h("b", {}, c.name),
            chip(c.status)),
          h("div", { class: "meta" },
            h("span", {}, `cap ${atoms(c.budgetCapAtoms, c.budgetToken)}`),
            h("span", { class: "mono" }, c.id)))));
    }
  } catch (e) { showErr(err, e.message); list.innerHTML = ""; }

  if (["buyer", "agent"].includes(s.actor.role)) {
    const nameIn = h("input", { id: "nc-name", placeholder: "Spring Fest reprint" });
    const capIn = h("input", { id: "nc-cap", type: "number", min: "0", value: "200000" });
    const tokIn = h("input", { id: "nc-tok", value: "USD" });
    main().append(h("div", { class: "card" },
      h("h2", {}, "New campaign"),
      h("label", { for: "nc-name" }, "Name"), nameIn,
      h("div", { class: "field-row" },
        h("div", {}, h("label", { for: "nc-cap" }, "Budget cap (atoms)"), capIn),
        h("div", {}, h("label", { for: "nc-tok" }, "Budget token"), tokIn)),
      err.cloneNode(),
      h("div", { class: "row", style: "margin-top:.7rem" },
        h("button", {
          class: "accent", type: "button",
          onclick: async () => {
            try {
              const c = await api("/api/campaigns", {
                method: "POST",
                body: { name: nameIn.value, budgetCapAtoms: Number(capIn.value), budgetToken: tokIn.value },
              });
              location.hash = `#/c/${c.id}`;
            } catch (e) { toast(e.message); }
          },
        }, "Create campaign"))));
  }
}

// ---------- campaign workspace ----------
async function viewWorkspace(cid) {
  const s = session.get();
  if (!s) return viewSignin();
  if (s.actor.role === "printer") { location.hash = "#/shop"; return; }
  main().innerHTML = "";
  const root = h("div", {});
  const stale = h("div", { class: "banner", hidden: true }, "refreshing — last-known data shown");
  main().append(root, stale);

  let bundle;
  try {
    bundle = await loadCampaignBundle(cid);
  } catch (e) {
    main().prepend(errBox(e.message));
    return;
  }
  renderWorkspace(root, cid, bundle);
}

function rerender(root, cid, stale) {
  (async () => {
    stale.hidden = false;
    try {
      const b = await loadCampaignBundle(cid);
      renderWorkspace(root, cid, b);
      stale.hidden = true;
      flushQueue();
    } catch (e) {
      stale.hidden = true;
      toast(e.message);
    }
  })();
}

function renderWorkspace(root, cid, b) {
  root.innerHTML = "";
  const s = session.get();
  const c = b.campaign;
  const refresh = () => rerender(root, cid, $("#main > .banner"));

  root.append(
    h("div", { class: "row between" },
      h("div", {},
        h("h1", { style: "margin-bottom:.15rem" }, c.name),
        h("div", { class: "muted small" },
          `${c.status} · cap ${atoms(c.budgetCapAtoms, c.budgetToken)}`)),
      h("button", { class: "ghost small", type: "button", onclick: refresh }, "Refresh")),
    h("div", { class: "banner sandbox", role: "note" },
      `Settlement adapter: ${esc(b.ledgerLabel || "SANDBOX")} — simulated ledger, not real money. Live Celo spend remains a separately authorized pilot.`));

  root.append(revisionsCard(cid, b, refresh));
  root.append(sitesCard(cid, b, refresh));
  root.append(quotesCard(cid, b, refresh));
  root.append(settlementCard(cid, b, refresh));
  root.append(fulfillmentCard(cid, b, refresh));
  root.append(releaseCard(cid, b, refresh));
}

// --- card 1: revisions ---
function revisionsCard(cid, b, refresh) {
  const err = fieldError(`e${++errSeq}`);
  const fileIn = h("input", { id: "rv-file", type: "file" });
  const textIn = h("textarea", { id: "rv-text", rows: "2", placeholder: "or paste asset text — used as the digest source" });
  const dateIn = h("input", { id: "rv-date", placeholder: "Sunday June 7" });
  const tgtIn = h("input", { id: "rv-tgt", placeholder: "https://go.fest/sunday (only for redirect-correctable content)" });
  const card = h("div", { class: "card" },
    h("h2", {}, h("span", { class: "step" }, "1"), "Artwork revisions"),
    b.revisions.length
      ? h("table", {},
          h("thead", {}, h("tr", {},
            h("th", {}, "seq"), h("th", {}, "digest"), h("th", {}, "event date"), h("th", {}, "redirect target"))),
          h("tbody", {}, b.revisions.map((r) => h("tr", {},
            h("td", {}, `v${r.seq}`),
            h("td", { class: "mono" }, short(r.assetDigest, 18)),
            h("td", {}, r.body?.eventDateText || "—"),
            h("td", { class: "mono" }, short(r.redirectTarget, 30) || "—")))))
      : h("p", { class: "muted" }, "No revisions yet — publish the original print file first."),
    h("h3", { style: "margin-top:.8rem" }, "Publish revision"),
    h("label", { for: "rv-file" }, "Asset file (image or text)"), fileIn,
    h("label", { for: "rv-text" }, "Asset text"), textIn,
    h("div", { class: "field-row" },
      h("div", {}, h("label", { for: "rv-date" }, "Event date (as printed)"), dateIn),
      h("div", {}, h("label", { for: "rv-tgt" }, "Redirect target (optional)"), tgtIn)),
    err,
    h("div", { class: "row", style: "margin-top:.6rem" },
      actionButton("Publish revision", NEEDS.buyer, async () => {
        try {
          let body = { body: { eventDateText: dateIn.value || undefined } };
          if (tgtIn.value) body.redirectTarget = tgtIn.value;
          const latest = b.revisions[b.revisions.length - 1];
          if (latest) body.parentId = latest.id;
          if (fileIn.files[0]) {
            body.assetBase64 = await fileToB64(fileIn.files[0]);
          } else if (textIn.value.trim()) {
            body.assetText = textIn.value.trim();
          } else {
            showErr(err, "attach a file or enter asset text"); return;
          }
          await api(`/api/campaigns/${cid}/revisions`, { method: "POST", body });
          showErr(err, ""); refresh();
        } catch (e) { showErr(err, e.message); }
      }, "accent")));
  return card;
}

async function fileToB64(file) {
  const buf = await file.arrayBuffer();
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(bin);
}
const b64ToText = (b64) => { try { return atob(b64); } catch { return "[binary asset]"; } };

// --- card 2: sites ---
function sitesCard(cid, b, refresh) {
  const card = h("div", { class: "card" },
    h("h2", {}, h("span", { class: "step" }, "2"), "Sites & required action"));

  if (!b.placements.length) {
    card.append(h("p", { class: "muted" },
      "No sites registered. Add a physical site (ink reprint) or a managed-redirect site (web correction)."));
  }

  for (const p of b.placements) {
    card.append(siteCard(cid, b, p, refresh));
  }

  // add placement
  const err = fieldError(`e${++errSeq}`);
  const revOpts = (sel) => h("select", { id: sel },
    h("option", { value: "" }, "— none —"),
    b.revisions.map((r) => h("option", { value: r.id }, `v${r.seq} · ${short(r.assetDigest, 10)}`)));
  const codeIn = h("input", { id: "pl-code", placeholder: "B" });
  const labelIn = h("input", { id: "pl-label", placeholder: "Market St shelter" });
  const fmtIn = h("input", { id: "pl-fmt", placeholder: "A2" });
  const inkIn = h("input", { id: "pl-ink", placeholder: "eventDateText" });
  const obsSel = revOpts("pl-obs");
  const managedChk = h("input", { id: "pl-managed", type: "checkbox" });
  const slugIn = h("input", { id: "pl-slug", placeholder: "fest-market", disabled: true });
  managedChk.onchange = () => { slugIn.disabled = !managedChk.checked; };
  card.append(
    h("details", {},
      h("summary", {}, "Add a site"),
      h("div", { class: "field-row" },
        h("div", {}, h("label", { for: "pl-code" }, "Site code"), codeIn),
        h("div", {}, h("label", { for: "pl-label" }, "Site label"), labelIn)),
      h("div", { class: "field-row" },
        h("div", {}, h("label", { for: "pl-fmt" }, "Format"), fmtIn),
        h("div", {}, h("label", { for: "pl-ink" }, "Ink fields (comma-sep)"), inkIn)),
      h("label", { for: "pl-obs" }, "Observed installed revision"), obsSel,
      h("label", { for: "pl-managed", class: "row", style: "gap:.4rem" },
        managedChk, " Managed redirect site (web-correctable)"),
      h("label", { for: "pl-slug" }, "Redirect slug"), slugIn,
      err,
      h("div", { class: "row", style: "margin-top:.6rem" },
        actionButton("Add site", NEEDS.buyerAgent, async () => {
          try {
            await api(`/api/campaigns/${cid}/placements`, {
              method: "POST",
              body: {
                siteCode: codeIn.value, siteLabel: labelIn.value,
                format: fmtIn.value,
                inkFields: inkIn.value ? inkIn.value.split(",").map((x) => x.trim()) : [],
                observedRevisionId: obsSel.value || undefined,
                managedRedirect: managedChk.checked,
                redirectSlug: managedChk.checked ? slugIn.value : undefined,
              },
            });
            showErr(err, ""); refresh();
          } catch (e) { showErr(err, e.message); }
        }, "accent"))));
  return card;
}

function siteCard(cid, b, p, refresh) {
  const pi = p.planItem || {};
  const target = b.revisions.find((r) => r.id === pi.targetRevisionId);
  const observed = b.revisions.find((r) => r.id === p.observedRevisionId);
  const el = h("div", {
    class: "site-card",
    "data-site-code": p.siteCode,
    "data-placement-id": p.id,
    "data-target-rev": pi.targetRevisionId || "",
  });

  el.append(
    h("div", { class: "head" },
      h("div", {},
        h("b", {}, `${p.siteCode} — ${p.siteLabel}`),
        " ",
        p.managedRedirect ? chip("managed redirect", "info") : chip("physical ink", "")),
      chip(pi.state)),
    h("div", { class: "meta" },
      h("span", {}, `format ${p.format || "—"}`),
      h("span", {}, `observed ${observed ? `v${observed.seq}` : "unknown"}`),
      h("span", {}, `target ${target ? `v${target.seq}` : "—"}`),
      p.deadline ? h("span", {}, `deadline ${p.deadline}`) : null),
    h("div", { class: "meta" },
      h("span", { class: "mono" }, `placement ${p.id}`),
      pi.targetRevisionId ? h("span", { class: "mono" }, `target ${short(pi.targetRevisionId, 20)}`) : null),
    h("div", { class: "meta" },
      h("span", { class: "mono" }, short(pi.reason, 90))),
    p.installation ? h("div", { class: "meta" },
      h("span", {}, "installed: "), chip(p.installation.status)) : null);

  const actions = h("div", { class: "actions" });
  el.append(actions);

  // decision actions
  actions.append(actionButton("Evaluate plan", ["agent"], async () => {
    try {
      const r = await api(`/api/campaigns/${cid}/plans/evaluate`, { method: "POST" });
      toast(`evaluated ${r.results.length} item(s)`); refresh();
    } catch (e) { toast(e.message); }
  }));

  if (p.managedRedirect) {
    // operator: register deployed redirect
    const regErr = fieldError(`e${++errSeq}`);
    const reg = h("details", {},
      h("summary", {}, "Operator: register deployed redirect"),
      h("div", { class: "field-row" },
        h("div", {},
          h("label", { for: `tg-${p.id}` }, "Approved target"),
          h("input", { id: `tg-${p.id}`, value: target?.redirectTarget || "" })),
        h("div", {},
          h("label", { for: `mu-${p.id}` }, "Deployed managed URL (QR resolves here)"),
          h("input", { id: `mu-${p.id}`, value: `${location.origin}/r/${p.redirectSlug || "slug"}` }))),
      regErr,
      h("div", { class: "row", style: "margin-top:.5rem" },
        actionButton("Register redirect", NEEDS.ops, async () => {
          try {
            await api("/api/redirects", { method: "POST", body: {
              slug: p.redirectSlug,
              target: $(`#tg-${p.id}`).value,
              managedUrl: $(`#mu-${p.id}`).value,
            } });
            showErr(regErr, ""); toast("redirect registered"); refresh();
          } catch (e) { showErr(regErr, e.message); }
        })));
    el.append(reg);

    actions.append(
      actionButton("Scan live redirect", ["agent", "coordinator"], async () => {
        try {
          const r = await api(`/api/campaigns/${cid}/plan-items/${pi.id}/scan`, { method: "POST", body: {} });
          toast(`scan → ${r.state}`); refresh();
        } catch (e) { toast(e.message); }
      }, "accent"),
      actionButton("Manual scan (stays unverified)", ["agent", "coordinator"], async () => {
        const loc = prompt("Reported location observed in the field:");
        if (loc === null) return;
        try {
          await api(`/api/campaigns/${cid}/plan-items/${pi.id}/scan`, {
            method: "POST", body: { manualLocation: loc },
          });
          refresh();
        } catch (e) { toast(e.message); }
      }));
  } else {
    // physical: record an observation of what's installed
    const obsSel = h("select", { id: `ob-${p.id}` },
      b.revisions.map((r) => h("option", { value: r.id }, `v${r.seq}`)));
    actions.append(obsSel,
      actionButton("Record observed revision", NEEDS.fieldOps, async () => {
        try {
          await api(`/api/campaigns/${cid}/placements/${p.id}/observations`, {
            method: "POST", body: { observedRevisionId: obsSel.value },
          });
          refresh();
        } catch (e) { toast(e.message); }
      }));
  }

  el.append(compareBlock(cid, b, p));
  return el;
}

function compareBlock(cid, b, p) {
  const evList = b.evidenceByPid[p.id] || [];
  if (!evList.length || !p.planItem?.targetRevisionId) return null;
  const last = evList[evList.length - 1];
  const det = h("details", {},
    h("summary", {}, "Compare approved artwork vs installed evidence"));
  const box = h("div", { class: "compare" });
  det.append(box);
  det.addEventListener("toggle", async () => {
    if (!det.open || det.dataset.loaded) return;
    det.dataset.loaded = "1";
    try {
      const [rev, ev] = await Promise.all([
        api(`/api/campaigns/${cid}/revisions/${p.planItem.targetRevisionId}/asset`),
        api(`/api/campaigns/${cid}/evidence/${last.id}/asset`),
      ]);
      box.append(
        h("figure", {},
          h("figcaption", {}, `approved · ${short(rev.assetDigest, 14)}`),
          renderAsset(rev.assetBase64)),
        h("figure", {},
          h("figcaption", {}, `installed · ${short(ev.payloadDigest, 14)}`),
          renderAsset(ev.assetBase64)));
    } catch (e) { box.append(errBox(e.message)); }
  });
  return det;
}

function renderAsset(b64) {
  // crude type sniff: PNG/JPEG magic → image, else text
  const head = (b64 || "").slice(0, 8);
  if (head.startsWith("iVBOR") || head.startsWith("/9j/")) {
    const mime = head.startsWith("iVBOR") ? "image/png" : "image/jpeg";
    return h("img", { src: `data:${mime};base64,${b64}`, alt: "asset preview" });
  }
  return h("pre", {}, b64ToText(b64).slice(0, 4000));
}

// --- card 3: quotes & proof ---
function quotesCard(cid, b, refresh) {
  const card = h("div", { class: "card" },
    h("h2", {}, h("span", { class: "step" }, "3"), "Quotes, proof & approval"));

  // create RFQ
  const reprintItems = b.placements.filter(
    (p) => p.planItem && ["REPRINT", "UNKNOWN", "OBSERVED", "REDIRECT_CHECK"].includes(p.planItem.state) && !p.managedRedirect);
  const err = fieldError(`e${++errSeq}`);
  const itemSel = h("select", { id: "rfq-item" },
    reprintItems.map((p) =>
      h("option", { value: p.planItem.id }, `${p.siteCode} — ${p.planItem.state}`)));
  const revSel = h("select", { id: "rfq-rev" },
    b.revisions.map((r) => h("option", { value: r.id }, `v${r.seq}`)));
  const dimIn = h("input", { id: "rfq-dim", value: "594x841mm" });
  const qtyIn = h("input", { id: "rfq-qty", type: "number", value: "1", min: "1" });
  const dlIn = h("input", { id: "rfq-dl", value: "2026-12-03" });

  card.append(
    b.quoteRequests.length
      ? h("table", {},
          h("thead", {}, h("tr", {}, h("th", {}, "RFQ"), h("th", {}, "site item"), h("th", {}, "status"), h("th", {}, "quotes"), h("th", {}, "proofs"))),
          h("tbody", {}, b.quoteRequests.map((qr) => h("tr", {},
            h("td", { class: "mono" }, short(qr.id, 14)),
            h("td", { class: "mono" }, short(qr.planItemId, 14)),
            h("td", {}, chip(qr.status)),
            h("td", {}, String(b.quotes.filter((q) => q.quoteRequestId === qr.id).length)),
            h("td", {}, String((b.proofsByQr[qr.id] || []).length))))))
      : h("p", { class: "muted" }, "No quote requests yet."),
    h("details", {},
      h("summary", {}, "Request quotes from shops"),
      reprintItems.length ? null : h("p", { class: "muted" }, "No physical site needs a reprint yet — evaluate the plan first."),
      h("div", { class: "field-row" },
        h("div", {}, h("label", { for: "rfq-item" }, "Plan item"), itemSel),
        h("div", {}, h("label", { for: "rfq-rev" }, "Target revision"), revSel)),
      h("div", { class: "field-row" },
        h("div", {}, h("label", { for: "rfq-dim" }, "Dimensions"), dimIn),
        h("div", {}, h("label", { for: "rfq-qty" }, "Qty"), qtyIn)),
      h("label", { for: "rfq-dl" }, "Deadline"), dlIn,
      err,
      h("div", { class: "row", style: "margin-top:.6rem" },
        actionButton("Send RFQ", NEEDS.buyerAgent, async () => {
          try {
            await api(`/api/campaigns/${cid}/quote-requests`, { method: "POST", body: {
              planItemId: itemSel.value, revisionId: revSel.value,
              dimensions: dimIn.value, qty: Number(qtyIn.value), deadline: dlIn.value,
            } });
            showErr(err, ""); toast("RFQ sent — switch to a printer role to quote"); refresh();
          } catch (e) { showErr(err, e.message); }
        }, "accent"))));

  // quotes + approve
  if (b.quotes.length) {
    const apprErr = fieldError(`e${++errSeq}`);
    const quoteRows = b.quotes.map((q) => {
      const proofs = b.proofsByQr[q.quoteRequestId] || [];
      const mine = proofs.filter((p) => p.revisionId === q.revisionId);
      const proofSel = h("select", { id: `pf-${q.id}` },
        mine.map((p) => h("option", { value: p.id }, `${short(p.id, 12)} · ${short(p.proofDigest, 10)}`)));
      const appr = b.approvals.find((a) => a.quoteId === q.id);
      return h("tr", {},
        h("td", {}, `${q.printerId}`),
        h("td", {}, `${atoms(q.priceAtoms, q.token)} × ${q.qty}`),
        h("td", { class: "mono" }, short(q.quoteHash, 14)),
        h("td", {}, q.expiresAt?.slice(0, 10) || "—"),
        h("td", {}, appr ? chip("APPROVED", "ok") : (mine.length ? proofSel : h("span", { class: "muted" }, "no proof"))),
        h("td", {}, appr
          ? h("span", { class: "mono small" }, short(appr.id, 12))
          : actionButton("Approve", NEEDS.buyer, async () => {
              try {
                await api(`/api/campaigns/${cid}/approvals`, { method: "POST", body: {
                  quoteId: q.id, proofId: proofSel.value,
                } });
                showErr(apprErr, ""); refresh();
              } catch (e) { showErr(apprErr, e.message); }
            })));
    });
    card.append(
      h("h3", { style: "margin-top:.8rem" }, "Printer quotes"),
      h("table", {},
        h("thead", {}, h("tr", {},
          h("th", {}, "shop"), h("th", {}, "price"), h("th", {}, "hash"), h("th", {}, "expires"), h("th", {}, "proof"), h("th", {}, "approve"))),
        h("tbody", {}, quoteRows)),
      apprErr);
  }

  // approvals + eligibility
  if (b.approvals.length) {
    card.append(h("h3", { style: "margin-top:.8rem" }, "Approvals"),
      h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "id"), h("th", {}, "amount"), h("th", {}, "payee"), h("th", {}, "eligibility"))),
        h("tbody", {}, b.approvals.map((a) => h("tr", {},
          h("td", { class: "mono" }, short(a.id, 14)),
          h("td", {}, atoms(a.budgetAtoms, a.selected?.token)),
          h("td", { class: "mono" }, a.selected?.recipient || "—"),
          h("td", {}, a.eligibility
            ? (a.eligibility.eligible ? chip("eligible", "ok") : h("span", { class: "chip bad" }, a.eligibility.reason))
            : "—"))))));
  }
  return card;
}

// --- card 4: settlement ---
function settlementCard(cid, b, refresh) {
  const card = h("div", { class: "card" },
    h("h2", {}, h("span", { class: "step" }, "4"), "Scoped payment"),
    h("p", { class: "note sandbox" },
      "Sandbox ledger — simulated settlement only. A human-granted session scopes amount and payees; live Celo spend is a separate authorized pilot."));

  // grants
  const err = fieldError(`e${++errSeq}`);
  const sidIn = h("input", { id: "gr-sess", value: `sess_${Date.now().toString(36)}` });
  const maxIn = h("input", { id: "gr-max", type: "number", value: "500000" });
  const payeeIn = h("input", { id: "gr-payee", value: "acct_printer_a" });
  card.append(
    h("h3", {}, "Grants"),
    b.grants.length ? h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "session"), h("th", {}, "max"), h("th", {}, "payees"), h("th", {}, "status"), h("th", {}, ""))),
      h("tbody", {}, b.grants.map((g) => h("tr", {},
        h("td", { class: "mono" }, g.sessionId),
        h("td", {}, atoms(g.maxAmountAtoms, g.token)),
        h("td", { class: "mono small" }, g.allowedPayees.join(", ")),
        h("td", {}, chip(g.status)),
        h("td", {}, g.status === "ACTIVE"
          ? actionButton("Revoke", NEEDS.buyer, async () => {
              await api(`/api/grants/${g.id}/revoke`, { method: "POST" }); refresh();
            }, "danger") : "")))))
      : h("p", { class: "muted" }, "No grants — the agent cannot spend until a human grants a scoped session."),
    h("details", {},
      h("summary", {}, "Grant a scoped session (human)"),
      h("div", { class: "field-row" },
        h("div", {}, h("label", { for: "gr-sess" }, "Session id"), sidIn),
        h("div", {}, h("label", { for: "gr-max" }, "Max amount (atoms)"), maxIn)),
      h("label", { for: "gr-payee" }, "Allowed payees (comma-sep)"), payeeIn,
      err,
      h("div", { class: "row", style: "margin-top:.6rem" },
        actionButton("Grant", NEEDS.buyer, async () => {
          try {
            await api(`/api/campaigns/${cid}/grants`, { method: "POST", body: {
              sessionId: sidIn.value, maxAmountAtoms: Number(maxIn.value),
              token: "USD", network: "SANDBOX",
              allowedPayees: payeeIn.value.split(",").map((x) => x.trim()).filter(Boolean),
            } });
            showErr(err, ""); refresh();
          } catch (e) { showErr(err, e.message); }
        }, "accent"))));

  // intents
  const intErr = fieldError(`e${++errSeq}`);
  const apprSel = h("select", { id: "oi-appr" },
    b.approvals.filter((a) => a.eligibility?.eligible !== false)
      .map((a) => h("option", { value: a.id }, `${short(a.id, 12)} · ${atoms(a.budgetAtoms)}`)));
  const ckIn = h("input", { id: "oi-ck", value: `ck_${Math.random().toString(36).slice(2, 10)}` });
  card.append(
    h("h3", { style: "margin-top:.8rem" }, "Order intents"),
    b.intents.length ? h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "id"), h("th", {}, "amount"), h("th", {}, "payee"), h("th", {}, "state"), h("th", {}, "actions"))),
      h("tbody", {}, b.intents.map((i) => h("tr", { "data-intent-id": i.id },
        h("td", { class: "mono" }, short(i.id, 14)),
        h("td", {}, atoms(i.amountAtoms, i.token)),
        h("td", { class: "mono" }, i.recipient),
        h("td", {}, chip(i.state)),
        h("td", {}, h("div", { class: "row" },
          i.state === "CONFIRMED" || i.state === "DELIVERED" ? "" :
          actionButton("Execute (pay)", NEEDS.buyerAgent, async () => {
            try {
              await api(`/api/order-intents/${i.id}/execute`, { method: "POST", body: {} });
              refresh();
            } catch (e) { toast(e.message); }
          }, "accent")))))))
      : h("p", { class: "muted" }, "No intents yet."),
    h("details", {},
      h("summary", {}, "Create order intent"),
      h("label", { for: "oi-appr" }, "Approval"), apprSel,
      h("label", { for: "oi-ck" }, "Client key (idempotency)"), ckIn,
      intErr,
      h("div", { class: "row", style: "margin-top:.6rem" },
        actionButton("Create intent", NEEDS.buyerAgent, async () => {
          try {
            await api(`/api/campaigns/${cid}/order-intents`, { method: "POST", body: {
              approvalId: apprSel.value, clientKey: ckIn.value,
            } });
            showErr(intErr, ""); refresh();
          } catch (e) { showErr(intErr, e.message); }
        }, "accent"))));

  // spends
  if (b.spends.length) {
    card.append(
      h("h3", { style: "margin-top:.8rem" }, "Spends & receipts"),
      h("table", {},
        h("thead", {}, h("tr", {},
          h("th", {}, "amount"), h("th", {}, "status"), h("th", {}, "tx"), h("th", {}, "ledger"), h("th", {}, "funded by"), h("th", {}, ""))),
        h("tbody", {}, b.spends.map((sp) => h("tr", {},
          h("td", {}, atoms(sp.amountAtoms, sp.token)),
          h("td", {}, chip(sp.status)),
          h("td", { class: "mono" }, short(sp.txHash, 16)),
          h("td", {}, sandboxChip(sp.ledger)),
          h("td", {}, sp.fundedBy || "team"),
          h("td", {}, sp.status === "AMBIGUOUS"
            ? actionButton("Reconcile", NEEDS.buyerAgent, async () => {
                const r = await api(`/api/spends/${sp.id}/reconcile`, { method: "POST" });
                toast(`reconcile → ${r.status || "done"}`); refresh();
              }) : ""))))));
  }
  return card;
}

// --- card 5: fulfillment & field evidence ---
function fulfillmentCard(cid, b, refresh) {
  const card = h("div", { class: "card" },
    h("h2", {}, h("span", { class: "step" }, "5"), "Delivery & field evidence"),
    h("p", { class: "muted small" },
      "Printer accepts and delivers in the print shop (switch actor). Field photo uploads queue offline and retry with the original client key."));

  // queued uploads
  const items = queue.all().filter((q) => q.campaignId === cid);
  if (items.length) {
    card.append(
      h("div", { class: "banner warn" },
        `${items.length} upload(s) queued offline — they retry with the same client key.`,
        " ",
        h("button", { class: "ghost small", type: "button", onclick: async () => { await flushQueue(); refresh(); } }, "Retry now")),
      h("table", {}, h("tbody", {}, items.map((q) => h("tr", {},
        h("td", { class: "mono" }, q.clientKey),
        h("td", {}, `site ${q.siteCode || q.placementId}`),
        h("td", {}, q.error ? h("span", { class: "chip bad" }, q.error) : chip("QUEUED", "info")))))));
  }

  // evidence upload per placement
  for (const p of b.placements) {
    const evList = b.evidenceByPid[p.id] || [];
    const err = fieldError(`e${++errSeq}`);
    const ckIn = h("input", { id: `ev-ck-${p.id}`, value: `ev_${Math.random().toString(36).slice(2, 10)}` });
    const fileIn = h("input", { id: `ev-file-${p.id}`, type: "file", accept: "image/*" });
    const noteIn = h("input", { id: `ev-note-${p.id}`, placeholder: "installer note" });
    const digestIn = h("input", {
      id: `ev-dg-${p.id}`, class: "mono",
      placeholder: "digest of revision seen installed (optional)",
    });
    const target = b.revisions.find((r) => r.id === p.planItem?.targetRevisionId);
    if (target) digestIn.value = target.assetDigest;

    const submit = async () => {
      const body = {
        clientKey: ckIn.value,
        revisionDigestSeen: digestIn.value || undefined,
        note: noteIn.value || undefined,
      };
      if (fileIn.files[0]) body.assetBase64 = await fileToB64(fileIn.files[0]);
      else {
        showErr(err, "attach a field photo (or use the text fixture below)"); return;
      }
      if (!navigator.onLine) {
        queue.add({ ...body, campaignId: cid, placementId: p.id, siteCode: p.siteCode, queuedAt: Date.now() });
        showErr(err, ""); toast("offline — queued with client key " + body.clientKey); refresh(); return;
      }
      try {
        await api(`/api/campaigns/${cid}/placements/${p.id}/evidence`, { method: "POST", body });
        showErr(err, ""); toast("evidence recorded"); refresh();
      } catch (e) {
        if (e instanceof TypeError) { // network failure → queue
          queue.add({ ...body, campaignId: cid, placementId: p.id, siteCode: p.siteCode, queuedAt: Date.now() });
          toast("connection lost — queued"); refresh();
        } else showErr(err, e.message);
      }
    };

    card.append(h("details", { "data-site": p.siteCode },
      h("summary", {}, `Site ${p.siteCode} — field evidence (${evList.length})`),
      evList.length ? h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "client key"), h("th", {}, "digest seen"), h("th", {}, "note"), h("th", {}, "at"))),
        h("tbody", {}, evList.map((e) => h("tr", {},
          h("td", { class: "mono" }, e.clientKey),
          h("td", { class: "mono" }, short(e.revisionDigestSeen, 16)),
          h("td", {}, e.note || "—"),
          h("td", { class: "small" }, (e.capturedAt || e.createdAt || "").slice(0, 19))))))
        : h("p", { class: "muted" }, "No field evidence yet."),
      h("div", { class: "field-row" },
        h("div", {}, h("label", { for: `ev-file-${p.id}` }, "Photo"), fileIn),
        h("div", {}, h("label", { for: `ev-ck-${p.id}` }, "Client key"), ckIn)),
      h("label", { for: `ev-dg-${p.id}` }, "Revision digest seen"), digestIn,
      h("label", { for: `ev-note-${p.id}` }, "Note"), noteIn,
      err,
      h("div", { class: "row", style: "margin-top:.5rem" },
        actionButton("Upload evidence", NEEDS.fieldOps, submit, "accent"),
        actionButton("Upload text fixture", NEEDS.fieldOps, async () => {
          const body = {
            clientKey: ckIn.value,
            assetText: `FIELD PHOTO site=${p.siteCode} at ${new Date().toISOString()}`,
            revisionDigestSeen: digestIn.value || undefined,
            note: noteIn.value || "text fixture",
          };
          if (!navigator.onLine) {
            queue.add({ ...body, campaignId: cid, placementId: p.id, siteCode: p.siteCode, queuedAt: Date.now() });
            toast("offline — queued"); refresh(); return;
          }
          try {
            await api(`/api/campaigns/${cid}/placements/${p.id}/evidence`, { method: "POST", body });
            refresh();
          } catch (e) { showErr(err, e.message); }
        }))));
  }

  // deliveries (read view for tenant roles)
  const deliveries = h("details", {},
    h("summary", {}, "Deliveries (per intent)"),
    h("p", { class: "muted" }, b.intents.length
      ? "Select an intent to view deliveries." : "No intents."),
    b.intents.map((i) => h("button", {
      class: "ghost small", type: "button", style: "margin-right:.4rem",
      onclick: async () => {
        try {
          const d = await api(`/api/order-intents/${i.id}/deliveries`);
          toast(`${d.deliveries.length} deliveries for ${short(i.id, 10)}`);
        } catch (e) { toast(e.message); }
      },
    }, short(i.id, 12))));
  card.append(deliveries);
  return card;
}

// --- card 6: release & export ---
function releaseCard(cid, b, refresh) {
  const card = h("div", { class: "card" },
    h("h2", {}, h("span", { class: "step" }, "6"), "Release & client export"));
  const err = fieldError(`e${++errSeq}`);
  const reportBox = h("div", { id: "report-box" }, h("p", { class: "muted" }, "Load the private report to preview what will ship."));
  const allowChk = h("input", { id: "rel-allow", type: "checkbox" });
  const linkBox = h("div", {});

  const showExportLink = (publicToken, status) => {
    linkBox.innerHTML = "";
    linkBox.append(
      h("div", { class: "banner" },
        h("b", {}, `released · ${status}`), " — client-safe export: ",
        h("a", { href: `/export.html?token=${publicToken}`, target: "_blank", rel: "noopener" },
          `/export.html?token=${publicToken}`),
        h("div", { class: "muted small" },
          "Opens without sign-in — the redacted public snapshot.")));
  };
  // Surface a previously published release after rerenders.
  api(`/api/campaigns/${cid}/release`).then((r) => {
    showExportLink(r.publicToken, r.status);
    reportBox.innerHTML = "";
    reportBox.append(h("p", { class: "note" },
      `Published ${r.releasedAt?.slice(0, 19) || ""} · ${r.status}`));
  }).catch(() => {});

  const renderReport = (r) => {
    reportBox.innerHTML = "";
    reportBox.append(
      h("dl", { class: "kv" },
        h("dt", {}, "state"), h("dd", {}, r.state),
        h("dt", {}, "sites"), h("dd", {}, `${r.counts.sitesVerified}/${r.counts.sitesTotal} verified`),
        h("dt", {}, "settled"), h("dd", {}, atoms(r.costs.settledAtoms)),
        h("dt", {}, "  · sandbox"), h("dd", {}, atoms(r.costs.sandboxSettledAtoms ?? 0)),
        h("dt", {}, "  · live"), h("dd", {}, atoms(r.costs.liveSettledAtoms ?? 0)),
        h("dt", {}, "independent use"), h("dd", {},
          `${atoms(r.attribution.independentAtoms)} · evidence ${r.attribution.evidenceClass}` +
          (r.attribution.claimedIndependentAtoms ? ` (+${atoms(r.attribution.claimedIndependentAtoms)} claimed on sandbox)` : "")),
        h("dt", {}, "team funded"), h("dd", {}, atoms(r.attribution.teamFundedAtoms)),
        h("dt", {}, "unresolved"), h("dd", {}, String(r.unresolved.length)),
        h("dt", {}, "exceptions"), h("dd", {}, String(r.exceptions.length))),
      r.unresolved.length ? h("p", { class: "note" }, `Unresolved: ${r.unresolved.join(", ")}`) : null);
  };

  card.append(
    reportBox,
    h("div", { class: "row", style: "margin-top:.6rem" },
      actionButton("Load report", ["buyer", "agent"], async () => {
        try { renderReport(await api(`/api/campaigns/${cid}/report`)); }
        catch (e) { showErr(err, e.message); }
      }),
      h("label", { for: "rel-allow", class: "row", style: "gap:.35rem; margin:0; font-weight:600" },
        allowChk, " sign off exceptions"),
      actionButton("Release to client", NEEDS.buyer, async () => {
        try {
          const r = await api(`/api/campaigns/${cid}/release`, {
            method: "POST", body: { allowExceptions: allowChk.checked },
          });
          showErr(err, "");
          renderReport(r.report);
          showExportLink(r.publicToken, r.status);
          refresh();
        } catch (e) { showErr(err, e.message); }
      }, "accent")),
    err, linkBox);
  return card;
}

// ---------- printer shop ----------
async function viewShop() {
  const s = session.get();
  if (!s) return viewSignin();
  main().innerHTML = "";
  const err = fieldError(`e${++errSeq}`);
  main().append(
    h("div", { class: "row between" },
      h("h1", {}, `Print shop — ${esc(s.actor.id)}`),
      h("a", { href: "#/" }, h("button", { class: "ghost small" }, "← campaigns"))),
    err);

  if (s.actor.role !== "printer") {
    main().append(h("p", { class: "muted" }, "This board is for printer actors — switch to Printer A or B."));
    return;
  }

  // open RFQs
  try {
    const { quoteRequests } = await api("/api/printer/quote-requests");
    const card = h("div", { class: "card" }, h("h2", {}, "Open quote requests"));
    if (!quoteRequests.length) card.append(h("p", { class: "muted" }, "No open RFQs."));
    for (const qr of quoteRequests) {
      const qErr = fieldError(`e${++errSeq}`);
      const priceIn = h("input", { id: `qp-${qr.id}`, type: "number", value: "42000" });
      const expIn = h("input", { id: `qe-${qr.id}`, value: "2099-01-01T00:00:00.000Z" });
      const acctIn = h("input", { id: `qa-${qr.id}`, value: `acct_${s.actor.id.replace("act_", "")}` });
      const proofIn = h("textarea", { id: `qf-${qr.id}`, rows: "2", placeholder: "proof text/asset — bound by digest to the revision" });
      card.append(h("details", {
          "data-rfq": qr.id,
          "data-campaign": qr.campaignId,
          "data-rev": qr.revisionId,
        },
        h("summary", {}, `RFQ ${short(qr.id, 14)} · ${qr.dimensions} · qty ${qr.qty} · due ${qr.deadline}`),
        h("p", { class: "mono small muted" },
          `campaign ${qr.campaignId} · item ${qr.planItemId} · revision ${qr.revisionId}`),
        h("div", { class: "field-row" },
          h("div", {}, h("label", { for: `qp-${qr.id}` }, "Total price (atoms)"), priceIn),
          h("div", {}, h("label", { for: `qa-${qr.id}` }, "Payee account"), acctIn)),
        h("label", { for: `qe-${qr.id}` }, "Expires at"), expIn,
        qErr,
        h("div", { class: "row", style: "margin-top:.5rem" },
          h("button", { class: "accent small", type: "button", onclick: async () => {
            try {
              await api(`/api/printer/quote-requests/${qr.id}/quotes`, { method: "POST", body: {
                qty: qr.qty, priceAtoms: Number(priceIn.value), token: "USD",
                network: "SANDBOX", recipient: acctIn.value, expiresAt: expIn.value,
              } });
              showErr(qErr, ""); toast("quote submitted");
            } catch (e) { showErr(qErr, e.message); }
          } }, "Submit quote")),
        h("label", { for: `qf-${qr.id}` }, "Print proof"), proofIn,
        h("div", { class: "row", style: "margin-top:.5rem" },
          h("button", { class: "ghost small", type: "button", onclick: async () => {
            try {
              await api(`/api/printer/quote-requests/${qr.id}/proofs`, { method: "POST", body: {
                assetText: proofIn.value || `PROOF rev=${qr.revisionId}`,
              } });
              toast("proof uploaded — buyer can now approve");
            } catch (e) { showErr(qErr, e.message); }
          } }, "Upload proof"))));
    }
    main().append(card);
  } catch (e) { showErr(err, e.message); }

  // jobs
  try {
    const { jobs } = await api("/api/printer/jobs");
    const card = h("div", { class: "card" }, h("h2", {}, "Jobs"));
    if (!jobs.length) card.append(h("p", { class: "muted" }, "No jobs yet — intents appear after the buyer approves a quote."));
    for (const j of jobs) {
      const jErr = fieldError(`e${++errSeq}`);
      const refIn = h("input", { id: `jr-${j.id}`, value: `REF-${j.id.slice(-6)}` });
      const pidIn = h("input", { id: `jp-${j.id}`, placeholder: "placement id (from buyer board)" });
      const dckIn = h("input", { id: `jd-${j.id}`, value: `d_${Math.random().toString(36).slice(2, 8)}` });
      const revIn = h("input", { id: `jv-${j.id}`, placeholder: "revision id delivered" });
      card.append(h("div", {
          class: "site-card",
          "data-job-id": j.id,
          "data-campaign": j.campaignId,
        },
        h("div", { class: "head" },
          h("b", {}, `job ${short(j.id, 14)} · ${atoms(j.amountAtoms, j.token)}`),
          chip(j.state)),
        h("div", { class: "meta" },
          h("span", { class: "mono" }, `payee ${j.recipient}`),
          h("span", { class: "mono" }, `campaign ${j.campaignId}`)),
        h("div", { class: "actions" },
          j.state === "REQUESTED" ? h("div", { class: "row" }, refIn,
            h("button", { class: "small", type: "button", onclick: async () => {
              try { await api(`/api/order-intents/${j.id}/reserve`, { method: "POST", body: { shopRef: refIn.value } }); viewShop(); }
              catch (e) { showErr(jErr, e.message); }
            } }, "Reserve")) : null,
          h("button", { class: "small", type: "button", onclick: async () => {
            try { await api(`/api/order-intents/${j.id}/accept`, { method: "POST" }); toast("job accepted"); viewShop(); }
            catch (e) { showErr(jErr, e.message); }
          } }, "Accept job"),
        ),
        h("details", {},
          h("summary", {}, "Record delivery"),
          h("div", { class: "field-row" },
            h("div", {}, h("label", { for: `jp-${j.id}` }, "Placement id"), pidIn),
            h("div", {}, h("label", { for: `jv-${j.id}` }, "Revision id"), revIn)),
          h("label", { for: `jd-${j.id}` }, "Client key"), dckIn,
          jErr,
          h("button", { class: "small", type: "button", style: "margin-top:.4rem", onclick: async () => {
            try {
              await api(`/api/order-intents/${j.id}/deliveries`, { method: "POST", body: {
                placementId: pidIn.value, qty: 1, revisionId: revIn.value, clientKey: dckIn.value,
              } });
              toast("delivery recorded"); viewShop();
            } catch (e) { showErr(jErr, e.message); }
          } }, "Deliver"))));
    }
    main().append(card);
  } catch (e) { showErr(err, e.message); }
}

// ---------- router ----------
async function route() {
  renderActorChip();
  renderQueueBadge();
  const hash = location.hash || "#/";
  if (hash.startsWith("#/c/")) {
    sessionStorage.setItem("pr_last_campaign", hash);
    return viewWorkspace(hash.slice(4));
  }
  if (hash === "#/shop") return viewShop();
  if (hash === "#/signin") return viewSignin();
  return viewCampaigns();
}

$("#switch-btn").addEventListener("click", renderActorPanel);
window.addEventListener("hashchange", route);
window.addEventListener("load", () => { route(); flushQueue(); });

// chain badge
api("/api/health", { auth: false }).then((r) => {
  const badge = $("#chain-badge");
  badge.hidden = false;
  badge.textContent = r.chain?.startsWith("SANDBOX") ? "SANDBOX" : r.chain;
}).catch(() => {});
