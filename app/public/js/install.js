// Getting the app onto a home screen, which is two different problems.
//
// Android Chrome fires `beforeinstallprompt`, so the browser can be asked to
// install and the whole thing is one tap. iOS fires nothing and exposes no API
// at all: Safari can only be *told* to do it by the user, through Share -> Add
// to Home Screen. So Android gets a button that installs, and iOS gets
// instructions - and pretending otherwise would mean a button that does nothing.
//
// The detection is pure and exported so it can be tested against real user
// agent strings rather than trusted.

/** Already launched from a home screen? Then no prompt belongs on screen. */
export function isStandalone(win = window) {
  return !!(win.matchMedia?.("(display-mode: standalone)").matches
    // iOS predates the standard and still only sets this.
    || win.navigator?.standalone
    || win.matchMedia?.("(display-mode: fullscreen)").matches);
}

/**
 * Which install story applies.
 *
 * iPadOS reports itself as a Mac, and has done since iPadOS 13 - the only
 * reliable tell is a Mac that reports touch points, which no real Mac does.
 */
export function platformOf(ua = navigator.userAgent, nav = navigator) {
  const iPadAsMac = /Macintosh/.test(ua) && (nav?.maxTouchPoints || 0) > 1;
  if (/iPhone|iPad|iPod/.test(ua) || iPadAsMac) {
    // Chrome and Firefox on iOS are Safari underneath, but their share sheets
    // do not offer Add to Home Screen - only Safari's does.
    return /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) ? "ios-other-browser" : "ios-safari";
  }
  if (/Android/.test(ua)) return "android";
  return "desktop";
}

/** What to say, given the platform and whether the browser offered to install. */
export function installAdvice(platform, canPrompt) {
  if (canPrompt) {
    return { mode: "button", title: "Install bodycomp",
             body: "Add it to your home screen - it opens full screen and works with no signal." };
  }
  switch (platform) {
    case "ios-safari":
      return { mode: "ios", title: "Add to your home screen",
               body: "Tap the Share button below, then <b>Add to Home Screen</b>. "
                   + "It opens full screen, with no browser bars, and works offline." };
    case "ios-other-browser":
      return { mode: "note", title: "Open this in Safari to install",
               body: "Only Safari can add an app to the iPhone home screen. "
                   + "Open this page in Safari, then Share &rarr; Add to Home Screen." };
    case "android":
      return { mode: "note", title: "Add to your home screen",
               body: "Open your browser menu and choose <b>Install app</b> or "
                   + "<b>Add to Home screen</b>." };
    default:
      return { mode: "note", title: "Install bodycomp",
               body: "Open this page on your phone to add it to your home screen." };
  }
}

const DISMISS_KEY = "bodycomp.install.dismissed";

/**
 * Wire the install card.
 *
 * `beforeinstallprompt` can fire before or after this runs, so the event is
 * captured as early as app.js loads and replayed here rather than listened for
 * and missed.
 */
export function wireInstall({ root, store = localStorage } = {}) {
  if (!root) return;
  const platform = platformOf();

  const dismissed = () => {
    try { return store.getItem(DISMISS_KEY) === "1"; } catch { return false; }
  };
  const hide = () => { root.hidden = true; };

  // Installed, dismissed, or a desktop nobody is going to install on: say nothing.
  if (isStandalone() || dismissed() || platform === "desktop") return hide();

  const render = () => {
    const deferred = window.__bodycompInstallPrompt || null;
    const advice = installAdvice(platform, !!deferred);
    root.hidden = false;
    root.innerHTML = `
      <div class="install-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M12 15V3M8 11l4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
      </div>
      <div class="install-text">
        <b>${advice.title}</b>
        <span>${advice.body}</span>
      </div>
      ${advice.mode === "button"
        ? `<button class="btn primary" type="button" data-install>Install</button>`
        : ""}
      <button class="install-x" type="button" data-dismiss aria-label="Dismiss">
        <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>`;
  };

  root.addEventListener("click", async e => {
    if (e.target.closest("[data-dismiss]")) {
      try { store.setItem(DISMISS_KEY, "1"); } catch { /* private mode */ }
      return hide();
    }
    const btn = e.target.closest("[data-install]");
    if (!btn) return;

    const deferred = window.__bodycompInstallPrompt;
    if (!deferred) return hide();
    btn.disabled = true;
    try {
      deferred.prompt();
      const { outcome } = await deferred.userChoice;
      // The event is single-use; keeping it would hand the browser a spent
      // prompt and silently do nothing on the second tap.
      window.__bodycompInstallPrompt = null;
      if (outcome === "accepted") hide();
      else { btn.disabled = false; render(); }
    } catch {
      btn.disabled = false;
    }
  });

  // Chrome may fire the event after this module has already decided what to
  // show, so re-render when it arrives and upgrade instructions into a button.
  window.addEventListener("bodycomp:installable", render);
  window.addEventListener("appinstalled", () => {
    window.__bodycompInstallPrompt = null;
    hide();
  });

  render();
}
