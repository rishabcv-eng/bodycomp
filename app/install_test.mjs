// Installing is the one flow that cannot be checked by running the app here:
// Android fires an event this browser will not fire, and iOS has no API at all.
// So the decisions - which platform, what to say, when to say nothing - are
// pure functions, tested against real user agent strings.
import { readFileSync } from "node:fs";
import { platformOf, installAdvice, isStandalone } from "./public/js/install.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`, extra); }
  else { fail++; console.log(`  FAIL ${name}`, extra); }
};

const UA = {
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1",
  iphoneFirefox: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15",
  ipadOS: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  androidChrome: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

console.log("Telling the platforms apart");
{
  const touch = n => ({ maxTouchPoints: n });
  ok("iPhone Safari", platformOf(UA.iphoneSafari, touch(5)) === "ios-safari");
  ok("Chrome on iOS is not Safari", platformOf(UA.iphoneChrome, touch(5)) === "ios-other-browser");
  ok("nor is Firefox on iOS", platformOf(UA.iphoneFirefox, touch(5)) === "ios-other-browser");
  ok("Android Chrome", platformOf(UA.androidChrome, touch(5)) === "android");
  ok("Windows is desktop", platformOf(UA.windows, touch(0)) === "desktop");

  // iPadOS has claimed to be a Mac since version 13. The only honest tell is a
  // Mac reporting touch points, because no actual Mac does.
  ok("iPadOS masquerading as a Mac is still iOS",
     platformOf(UA.ipadOS, touch(5)) === "ios-safari");
  ok("a real Mac is not", platformOf(UA.mac, touch(0)) === "desktop");
  ok("and a Mac with a drawing tablet is still a Mac",
     platformOf(UA.mac, touch(1)) === "desktop", "maxTouchPoints=1");
}

console.log("\nWhat each platform is told");
{
  // The rule that matters: never show a button that cannot install anything.
  const ios = installAdvice("ios-safari", false);
  ok("iPhone Safari gets instructions, not a button", ios.mode === "ios");
  ok("and is told exactly where to tap", /Add to Home Screen/.test(ios.body));

  const iosOther = installAdvice("ios-other-browser", false);
  ok("Chrome on iOS is sent to Safari", iosOther.mode === "note" && /Safari/.test(iosOther.title));

  const android = installAdvice("android", true);
  ok("Android with a live prompt gets a button", android.mode === "button");

  const androidNoPrompt = installAdvice("android", false);
  ok("Android without one falls back to instructions", androidNoPrompt.mode === "note");
  ok("and never claims a button that would do nothing", androidNoPrompt.mode !== "button");

  ok("a live prompt always wins, whatever the platform",
     installAdvice("ios-safari", true).mode === "button");
}

console.log("\nWhen to stay quiet");
{
  const win = matches => ({ matchMedia: q => ({ matches: matches.includes(q) }), navigator: {} });
  ok("a browser tab is not standalone", isStandalone(win([])) === false);
  ok("display-mode standalone is",
     isStandalone(win(["(display-mode: standalone)"])) === true);
  ok("fullscreen counts too", isStandalone(win(["(display-mode: fullscreen)"])) === true);
  // iOS predates the standard and still only sets navigator.standalone.
  ok("iOS's own flag counts",
     isStandalone({ matchMedia: () => ({ matches: false }), navigator: { standalone: true } }) === true);
  ok("and a missing matchMedia does not throw",
     isStandalone({ navigator: {} }) === false);
}

console.log("\nThe markup backs it up");
{
  const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const manifest = JSON.parse(readFileSync(new URL("./public/manifest.webmanifest", import.meta.url), "utf8"));

  ok("the manifest is linked", /<link rel="manifest"/.test(html));
  ok("iOS gets its own icon, which it uses instead of the manifest",
     /rel="apple-touch-icon"/.test(html));
  ok("iOS is told it may run standalone", /apple-mobile-web-app-capable/.test(html));
  ok("and launch screens are declared", (html.match(/apple-touch-startup-image/g) || []).length >= 10,
     `${(html.match(/apple-touch-startup-image/g) || []).length} declared`);
  ok("the viewport covers the notch", /viewport-fit=cover/.test(html));
  ok("beforeinstallprompt is captured before the modules load",
     html.indexOf("beforeinstallprompt") < html.indexOf('src="js/app.js"'));

  ok("the manifest is standalone", manifest.display === "standalone");
  ok("it has an explicit id, so the install does not move if start_url changes",
     typeof manifest.id === "string" && manifest.id.length > 0);
  // Android crops any icon to its own shape; without a maskable one it pads the
  // square icon into a smaller, letterboxed blob.
  ok("a maskable icon exists for Android",
     manifest.icons.some(i => (i.purpose || "").includes("maskable")));
  ok("at both sizes Android asks for",
     ["192x192", "512x512"].every(s =>
       manifest.icons.some(i => i.sizes === s && (i.purpose || "").includes("maskable"))));
  ok("screenshots are declared for the install dialog",
     manifest.screenshots?.length >= 1 && manifest.screenshots.every(s => s.form_factor));
  ok("theme and background match the app's own background",
     manifest.theme_color === "#07080B" && manifest.background_color === "#07080B");
}

console.log("\nThe home-screen shortcuts go somewhere");
{
  const manifest = JSON.parse(readFileSync(new URL("./public/manifest.webmanifest", import.meta.url), "utf8"));
  const ui = readFileSync(new URL("./public/js/ui.js", import.meta.url), "utf8");

  // Every shortcut launches at a hash, and the app has to actually read it on
  // load - it did not, so both shortcuts opened the welcome screen instead.
  const listed = ui.match(/DEEP_LINKABLE = new Set\([\[]([^\]]*)/)?.[1] || "";
  const linkable = [...listed.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  ok("the app reads the launch hash", /location\.hash/.test(ui));
  ok("and has a list of screens it will open at", linkable.length > 0, linkable.join(", "));

  const targets = (manifest.shortcuts || []).map(s => (s.url.split("#")[1] || ""));
  ok("every shortcut names a screen", targets.every(Boolean), targets.join(", "));
  ok("and every one of them is deep-linkable",
     targets.every(t => linkable.includes(t)),
     targets.filter(t => !linkable.includes(t)).join(", ") || "all reachable");

  // The camera needs a height before it means anything, results need a scan.
  ok("the camera is not deep-linkable", !linkable.includes("capture"));
  ok("nor is an empty results screen", !linkable.includes("results"));
}

console.log("\nThe worker caches what the shell needs");
{
  const sw = readFileSync(new URL("./public/sw.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const preloaded = [...html.matchAll(/<link rel="modulepreload" href="js\/([^"]+)"/g)].map(m => m[1]);
  const missing = preloaded.filter(f => !sw.includes(`./js/${f}`));
  ok("every preloaded module is in the precache list", missing.length === 0,
     missing.length ? `missing: ${missing.join(", ")}` : `${preloaded.length} modules`);
  ok("the 25 MB of MediaPipe is not precached",
     !/SHELL_URLS[\s\S]*?\.(wasm|tflite|task)/.test(sw));
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? "FAIL - the install flow does not behave"
                 : "PASS - install advice, manifest and precache all line up");
process.exit(fail ? 1 : 0);
