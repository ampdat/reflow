#!/usr/bin/env node
/**
 * Drive an Obsidian instance over the Chrome DevTools Protocol.
 *
 * Obsidian is Electron, so with `--remote-debugging-port` its renderer is a
 * normal CDP target: we can evaluate JS in the plugin's own context, read the
 * console, and await long-running promises. That turns "install the plugin,
 * right-click a PDF, watch the console" into an automated loop.
 *
 * The instance is *isolated*: a private `--user-data-dir` and its own scratch
 * vault, so it never touches the user's real Obsidian session or vaults (and,
 * because Electron's single-instance lock lives in the user-data dir, it can
 * run alongside one).
 *
 *   node tools/obsidian-drive.mjs up                 # launch + open the vault
 *   node tools/obsidian-drive.mjs eval '<js>'        # evaluate, print JSON
 *   node tools/obsidian-drive.mjs eval-file <path>   # ditto, from a file
 *   node tools/obsidian-drive.mjs console [seconds]  # tail the renderer console
 *   node tools/obsidian-drive.mjs down               # quit the instance
 *
 * Expressions are wrapped in an async IIFE and awaited, so `eval` can just do
 * `return await somethingSlow()`. Console output produced during an `eval` is
 * interleaved on stderr; the JSON result goes to stdout.
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");

const PORT = Number(process.env.OBSIDIAN_CDP_PORT || 9333);
const ROOT = process.env.PDF2MD_TEST_ROOT || resolve(REPO, ".obsidian-test");
const PROFILE = resolve(ROOT, "profile");
const VAULT = resolve(ROOT, "vault");
const APP = "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
const VAULT_ID = "pdf2mdtestvault0";

const log = (...a) => console.error(...a);

// ---------------------------------------------------------------- CDP client

async function httpJson(path) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return res.json();
}

/** Wait until the debugger is up and the main Obsidian window has a target. */
async function waitForTarget(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const targets = await httpJson("/json/list");
      const page = targets.find(
        (t) => t.type === "page" && t.url.includes("obsidian.md") && t.webSocketDebuggerUrl,
      );
      if (page) return page;
      lastErr = new Error(`no obsidian page target yet (${targets.length} targets)`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for CDP target on :${PORT} — ${lastErr?.message}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.pending = new Map();
    this.onEvent = null;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method && this.onEvent) {
        this.onEvent(msg);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("CDP websocket failed")), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close() {
    this.ws.close();
  }
}

/** Render a CDP RemoteObject argument the way the devtools console would. */
function fmtArg(a) {
  if (a.type === "string") return a.value;
  if ("value" in a) return JSON.stringify(a.value);
  if (a.preview) {
    const props = (a.preview.properties || []).map((p) => `${p.name}: ${p.value}`).join(", ");
    return `${a.description || a.className || "object"}${props ? ` {${props}}` : ""}`;
  }
  return a.description || a.type;
}

function attachConsole(cdp, prefix = "  ") {
  cdp.onEvent = (msg) => {
    if (msg.method === "Runtime.consoleAPICalled") {
      const { type, args } = msg.params;
      log(`${prefix}[${type}] ${args.map(fmtArg).join(" ")}`);
    } else if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      log(`${prefix}[uncaught] ${d.exception?.description || d.text}`);
    }
  };
}

// ------------------------------------------------------------------- profile

/** Seed the isolated user-data dir + scratch vault so Obsidian opens straight in. */
function seedProfile() {
  mkdirSync(PROFILE, { recursive: true });
  mkdirSync(resolve(VAULT, ".obsidian"), { recursive: true });

  writeFileSync(
    resolve(PROFILE, "obsidian.json"),
    JSON.stringify({ vaults: { [VAULT_ID]: { path: VAULT, ts: Date.now(), open: true } } }, null, 2),
  );

  // Trust the vault so community plugins may load (equivalent to turning off
  // Restricted Mode in the UI); the driver enables the plugin itself anyway.
  const appJson = resolve(VAULT, ".obsidian", "app.json");
  if (!existsSync(appJson)) writeFileSync(appJson, JSON.stringify({ trustedForPlugins: true }));
  const cp = resolve(VAULT, ".obsidian", "community-plugins.json");
  if (!existsSync(cp)) writeFileSync(cp, JSON.stringify(["pdf-to-md"]));
}

function isUp() {
  try {
    execFileSync("curl", ["-s", "-m", "1", `http://127.0.0.1:${PORT}/json/version`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

async function up() {
  seedProfile();
  if (isUp()) {
    log(`Obsidian already listening on :${PORT}`);
  } else {
    log(`launching isolated Obsidian (profile=${PROFILE}, vault=${VAULT})`);
    const child = spawn(
      APP,
      [`--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, "--no-first-run"],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
  }
  const target = await waitForTarget();
  log(`attached: ${target.url}`);
  return target;
}

// ---------------------------------------------------------------------- eval

async function evaluate(expression, { timeoutMs = 900_000, quiet = false } = {}) {
  const target = await up();
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  if (!quiet) attachConsole(cdp);

  const wrapped = `(async () => { ${expression} })()`;
  const result = await Promise.race([
    cdp.send("Runtime.evaluate", {
      expression: wrapped,
      awaitPromise: true,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
      timeout: timeoutMs,
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("eval timed out")), timeoutMs)),
  ]);
  cdp.close();

  if (result.exceptionDetails) {
    const d = result.exceptionDetails;
    throw new Error(d.exception?.description || d.text || JSON.stringify(d));
  }
  return result.result.value;
}

// ----------------------------------------------------------------------- cli

const [cmd, ...rest] = process.argv.slice(2);

try {
  switch (cmd) {
    case "up": {
      await up();
      break;
    }
    case "down": {
      try {
        execFileSync("pkill", ["-f", `--user-data-dir=${PROFILE}`]);
        log("quit");
      } catch {
        log("not running");
      }
      break;
    }
    case "reload": {
      // Picking up a new build means reloading the renderer, which kills the
      // CDP connection mid-call — so fire it without awaiting, then re-attach
      // and wait for the plugin to finish loading.
      try {
        await evaluate("setTimeout(() => location.reload(), 50); return 'reloading';", {
          timeoutMs: 5000,
          quiet: true,
        });
      } catch {
        /* the reload tears down the connection; expected */
      }
      await new Promise((r) => setTimeout(r, 2000));
      const deadline = Date.now() + 60_000;
      for (;;) {
        try {
          const ready = await evaluate(
            `const b = [...document.querySelectorAll("button")].find(b => /trust/i.test(b.textContent));
             if (b) b.click();
             await app.plugins.setEnable(true);
             if (!app.plugins.plugins["pdf-to-md"]) await app.plugins.enablePlugin("pdf-to-md");
             return !!app.plugins.plugins["pdf-to-md"];`,
            { timeoutMs: 20_000, quiet: true },
          );
          if (ready) break;
        } catch {
          /* renderer still coming up */
        }
        if (Date.now() > deadline) throw new Error("plugin did not load after reload");
        await new Promise((r) => setTimeout(r, 1000));
      }
      log("reloaded, plugin loaded");
      break;
    }
    case "eval":
    case "eval-file": {
      const src = cmd === "eval" ? rest.join(" ") : readFileSync(rest[0], "utf8");
      const value = await evaluate(src);
      console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
      break;
    }
    case "console": {
      const seconds = Number(rest[0] || 30);
      const target = await up();
      const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
      await cdp.send("Runtime.enable");
      attachConsole(cdp, "");
      log(`tailing console for ${seconds}s…`);
      await new Promise((r) => setTimeout(r, seconds * 1000));
      cdp.close();
      break;
    }
    default:
      log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
      process.exit(1);
  }
} catch (e) {
  log(`ERROR: ${e.message}`);
  process.exit(1);
}
process.exit(0);
