import { config } from "./config.mjs";
import { createClient } from "@supabase/supabase-js";
import { initialState, validateState } from "./model.mjs";
import { mountBudget } from "./budget-ui.mjs";
import { SyncEngine } from "./sync-engine.mjs";
import { budgetApi } from "./supabase-api.mjs";
import { createTrackerApi } from "./tracker-api.mjs";
import { mountActivity } from "./activity-ui.mjs";
import shell from "./shell.html";
const $ = (s) => document.querySelector(s),
  CONFIG_KEY = "saldo-cloud-connection-v1";
let client = null,
  engine = null,
  ui = null,
  activity = null,
  tracker = null,
  currentUser = null,
  generation = 0;
function frame(content) {
  $("#gate").hidden = false;
  $("#gate").innerHTML =
    `<div class="gate-card"><a class="brand"><span class="brandmark">s</span>saldo<span class="branddot">.</span></a>${content}</div>`;
}
function setup(message = "") {
  frame(
    `<div class="eyebrow">PRIVATE CLOUD SETUP</div><h1>Connect your private budget.</h1><p>This app uses your Supabase project for sign-in and cloud saving. Budget data is not embedded in this public website.</p><p class="connection-url">Project: ${config.url}</p><form id="connect-form"><label for="publishable-key">Supabase publishable key</label><input id="publishable-key" autocomplete="off" spellcheck="false" placeholder="sb_publishable_…" required><p>Use only the publishable key from Supabase → Project Settings → API Keys. Never enter a database password, OAuth secret or secret key.</p><div id="connection-error" role="alert"></div><button class="primary">Save connection</button></form><p>Saved only in this browser. No budget data is sent until you sign in. This is public client configuration, not your login credential.</p>`,
  );
  $("#connection-error").textContent = message;
  $("#connect-form").onsubmit = (e) => {
    e.preventDefault();
    const key = $("#publishable-key").value.trim();
    if (!/^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(key)) {
      $("#connection-error").textContent =
        "Enter a publishable key beginning sb_publishable_. Secret and legacy keys are not accepted.";
      return;
    }
    try {
      localStorage.setItem(CONFIG_KEY, key);
      location.reload();
    } catch {
      $("#connection-error").textContent =
        "Browser storage is blocked. Allow site storage before continuing.";
    }
  };
}
function login(message = "") {
  frame(
    '<div class="eyebrow">YOUR PRIVATE WORKSPACE</div><h1>Your budget, wherever you are.</h1><p>Sign in to load your monthly plan. Import your existing private backup after signing in.</p><button class="primary" id="login">Continue with GitHub</button><p id="auth-error" role="alert"></p><button id="change-connection">Change connection</button>',
  );
  $("#auth-error").textContent = message;
  $("#change-connection").onclick = () => setup();
  $("#login").onclick = async () => {
    try {
      const redirect = new URL(".", location.href).href;
      const { error } = await client.auth.signInWithOAuth({
        provider: "github",
        options: { redirectTo: redirect },
      });
      if (error) throw error;
    } catch (e) {
      $("#auth-error").textContent = "Sign-in failed: " + e.message;
    }
  };
}
function askDiscard(action) {
  const modal = $("#modal");
  $("#modal-content").innerHTML =
    '<h2>Load the latest cloud budget?</h2><p class="subtitle">This discards the draft currently shown. Export it first if you want to keep these changes. Nothing is merged automatically.</p><div class="form-actions"><button id="draft-export">Export draft</button><button id="cancel-reload">Cancel</button><button class="primary" id="discard-reload">Discard draft and load</button></div>';
  modal.showModal();
  $("#draft-export").onclick = () => ui.exportBackup();
  $("#cancel-reload").onclick = () => modal.close();
  $("#discard-reload").onclick = () => {
    modal.close();
    action();
  };
}
function showStatus(state) {
  if (!ui) return;
  const status = state.status || engine?.status || "loading";
  const text =
    {
      loading: "Loading cloud budget…",
      ready: engine?.dirty ? "Changes pending" : "Ready · no changes to save",
      saving: "Saving to cloud…",
      saved: "Saved to cloud",
      offline: "Not saved to cloud · retry when connected",
      conflict:
        "Another device changed this budget. Export your draft or load the latest version.",
      error: "Cloud save needs attention",
    }[status] || status;
  $("#save-status").textContent = text;
  $("#cloud-message").textContent =
    text +
    (state.error ? " · " + String(state.error.message || state.error) : "");
  $("#cloud-message").className = status;
  $("#retry-cloud").hidden = !["offline", "error"].includes(status);
  $("#reload-cloud").hidden = status === "loading";
}
function clearWorkspace() {
  generation++;
  engine?.stop();
  activity?.destroy();
  tracker?.destroy();
  activity = null;
  tracker = null;
  ui?.destroy();
  engine = null;
  ui = null;
  currentUser = null;
  $("#workspace").innerHTML = "";
  $("#workspace").hidden = true;
  $("#gate").hidden = false;
}
async function openSession(session) {
  if (!session?.user) {
    clearWorkspace();
    login();
    return;
  }
  if (currentUser === session.user.id) return;
  clearWorkspace();
  const turn = generation,
    userId = session.user.id;
  currentUser = userId;
  $("#workspace").innerHTML = shell;
  $("#workspace").hidden = false;
  $("#gate").hidden = true;
  const main = $("#workspace main");
  const tools = document.createElement("section");
  tools.id = "cloud-tools";
  tools.innerHTML =
    '<span id="cloud-message">Loading cloud budget…</span><button id="retry-cloud" hidden>Retry cloud save</button><button id="reload-cloud">Load latest</button><button id="cloud-export">Export plan backup</button><button id="signout">Sign out</button>';
  main.insertBefore(tools, main.firstChild);
  const welcome = document.createElement("div");
  welcome.className = "cloud-onboarding";
  welcome.textContent =
    "Moving from the original app? Import your latest JSON backup in Plan settings. Keep a separate backup until you verify it on your other device. Changes save after acknowledgement from the cloud.";
  main.insertBefore(welcome, $("#content"));
  let sessionEngine;
  const sessionTracker = (tracker = createTrackerApi(client, userId, {
    url: config.url,
    key,
  }));
  const sessionUI = (ui = mountBudget({
    initial: initialState(),
    onView: (view) => {
      if (turn !== generation || currentUser !== userId) return;
      if (view !== "activity") {
        activity?.hide();
        return;
      }
      if (!activity)
        activity = mountActivity({
          root: $("#content"),
          api: sessionTracker,
          getBudget: () => sessionUI.getState(),
          userId,
          functionUrl: config.url + "/functions/v1/shortcut-entry",
        });
      void activity.open();
    },
    onChange: (payload) => {
      if (turn === generation && currentUser === userId)
        sessionEngine?.change(payload);
    },
  }));
  sessionEngine = engine = new SyncEngine({
    api: budgetApi(client, userId, { url: config.url, key }),
    initial: initialState(),
    storage: localStorage,
    cacheKey: `saldo-cloud-draft-${userId}`,
    validatePayload: (payload) => validateState(payload).valid,
    onData: (payload) => {
      if (turn !== generation) return;
      if (!validateState(payload).valid)
        throw new Error(
          "Saved draft or cloud data is invalid. Restore a valid backup.",
        );
      sessionUI.setState(payload);
    },
    onState: (s) => {
      if (turn === generation) showStatus(s);
    },
  });
  $("#cloud-export").onclick = () => ui.exportBackup();
  $("#retry-cloud").onclick = () =>
    sessionEngine.loaded
      ? sessionEngine.flush()
      : sessionEngine.start().then(() => sessionEngine.flush());
  $("#reload-cloud").onclick = () => {
    const load = () => sessionEngine.reloadRemote();
    if (engine.dirty || engine.status === "conflict") askDiscard(load);
    else load();
  };
  $("#signout").onclick = async () => {
    if (engine.dirty) {
      askDiscard(async () => {
        await doSignOut();
      });
      $("#modal-content h2").textContent = "Sign out with unsaved changes?";
      $("#modal-content .subtitle").textContent =
        "Export your draft first. Signing out here clears this account’s local draft from this browser.";
      $("#discard-reload").textContent = "Discard draft and sign out";
      return;
    }
    await doSignOut();
  };
  try {
    await sessionEngine.start();
  } catch (error) {
    if (turn !== generation) return;
    throw error;
  }
}
async function doSignOut() {
  const uid = currentUser;
  const turn = generation;
  const { error } = await client.auth.signOut({ scope: "local" });
  if (turn !== generation || uid !== currentUser) {
    if (!error) {
      try {
        localStorage.removeItem(`saldo-cloud-draft-${uid}`);
      } catch {}
    }
    return;
  }
  if (error) {
    showStatus({
      status: "error",
      error: "Sign-out failed. Please try again.",
    });
    return;
  }
  engine?.stop();
  try {
    localStorage.removeItem(`saldo-cloud-draft-${uid}`);
  } catch {}
  clearWorkspace();
  login();
}
let key = config.publishableKey;
try {
  key = key || localStorage.getItem(CONFIG_KEY) || "";
} catch {}
if (!/^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(key)) setup();
else {
  try {
    client = createClient(config.url, key, {
      auth: {
        flowType: "pkce",
        detectSessionInUrl: true,
        persistSession: true,
        autoRefreshToken: true,
      },
      global: { fetch: (...args) => fetch(...args) },
    });
    client.auth.onAuthStateChange((_event, session) => {
      setTimeout(
        () =>
          openSession(session).catch((e) => {
            clearWorkspace();
            login("Could not open your budget: " + e.message);
          }),
        0,
      );
    });
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    await openSession(data.session);
  } catch (e) {
    clearWorkspace();
    login("Connection failed: " + e.message);
  }
}
window.addEventListener("online", () => engine?.flush());
window.addEventListener("beforeunload", (e) => {
  if (engine?.dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
