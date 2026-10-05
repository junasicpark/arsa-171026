// Skrip pengukuran (tools/measure-seam.js) - alat bantu diagnosa.
//
// Mengambil piksel NYATA hasil render di sambungan antara
// #fh5co-doa (Wedding Du'a) dan #fh5co-more-us (Some Moments),
// lalu menuliskannya ke tools/measure-output.txt.
//
//   1. Chrome headless + --remote-debugging-port.
//   2. CDP lewat WebSocket (Node 20 + --experimental-websocket).
//   3. Muat index.html dari file://, paksa semua state reveal aktif,
//      lalu Emulation.setDeviceMetricsOverride untuk tiap lebar uji.
//   4. Gulir #page ke seam, screenshot viewport, decode DI DALAM
//      halaman (createImageBitmap + OffscreenCanvas), baca piksel
//      per baris.
//
// Cara pakai:
//   node --experimental-websocket tools/measure-seam.js
//
// Catatan penting soal lingkungan:
//   - Overlay #invitation-cover + .fh5co-loader dihapus dulu; keduanya
//     position:fixed dan menutupi seluruh viewport.
//   - Yang menggulir adalah #page (overflow-x:hidden -> scroll container
//     internal), BUKAN window; body terkunci overflow:hidden.
//   - Gambar waiting="lazy" dipaksa eager, kalau tidak screenshot hanya
//     berisi kanvas putih.

const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PAGE =
  "file:///" + path.resolve(__dirname, "..", "index.html").replace(/\\/g, "/");
const PORT = 9223;

const WIDTHS = [
  { label: "desktop", width: 1440, height: 900, dsf: 1 },
  { label: "tablet", width: 768, height: 1024, dsf: 1 },
  { label: "mobile", width: 390, height: 844, dsf: 2 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    http
      .get(
        { hostname: u.hostname, port: u.port, path: u.pathname + u.search },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(e);
            }
          });
        }
      )
      .on("error", reject);
  });
}

async function waitForChrome() {
  for (let i = 0; i < 60; i++) {
    try {
      const v = await getJSON(`http://127.0.0.1:${PORT}/json/version`);
      if (v && v.webSocketDebuggerUrl) return v;
    } catch (_) {
      /* belum siap */
    }
    await sleep(250);
  }
  throw new Error("Chrome tidak siap di port " + PORT);
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.sessionId = null;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}, useSession = true) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (useSession && this.sessionId) payload.sessionId = this.sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-seam-"));

  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--allow-file-access-from-files",
      "--force-device-scale-factor=1",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  let out = "";
  try {
    const version = await waitForChrome();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", rej, { once: true });
    });

    const cdp = new CDP(ws);
    const { targetInfos } = await cdp.send("Target.getTargets", {}, false);
    const pageTarget = targetInfos.find((t) => t.type === "page");
    const { sessionId } = await cdp.send(
      "Target.attachToTarget",
      { targetId: pageTarget.targetId, flatten: true },
      false
    );
    cdp.sessionId = sessionId;

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    for (const vp of WIDTHS) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: vp.dsf,
        mobile: vp.label === "mobile",
      });

      await cdp.send("Page.navigate", { url: PAGE });
      await sleep(1500);

      // Paksa state reveal aktif: yang diukur = kondisi final dilihat user.
      await cdp.send("Runtime.evaluate", {
        expression: `
          (() => {
            document.documentElement.classList.add('js');
            document.querySelectorAll('.is-revealed, .is-visible')
              .forEach((el) => { el.classList.add('is-revealed'); el.classList.add('is-visible'); });
            ['doa-section','more-us-section','chapter-two','rsvp-scene']
              .forEach((c) => document.querySelectorAll('.'+c)
                .forEach((el) => { el.classList.add('is-revealed'); el.classList.add('is-visible'); }));
            return true;
          })()
        `,
        returnByValue: true,
      });
      await sleep(700);

      const geo = await cdp.send("Runtime.evaluate", {
        expression: `
          (() => {
            const a = document.getElementById('fh5co-doa');
            const b = document.getElementById('fh5co-more-us');
            if (!a || !b) return null;
            const ra = a.getBoundingClientRect();
            const rb = b.getBoundingClientRect();
            return {
              seamDocY: ra.bottom + window.scrollY,
              doaH: ra.height, moreUsH: rb.height
            };
          })()
        `,
        returnByValue: true,
      });

      const g = geo.result.value;
      if (g == null) {
        out += `[${vp.label}] section tidak ditemukan\n`;
        continue;
      }

      const seamDocY = Math.round(g.seamDocY);

      // Paksa gambar eager + tunggu (bounded), lalu scroll tepat ke seam.
      await cdp.send("Runtime.evaluate", {
        expression: `
          (async () => {
            // Cover + loader adalah overlay POSITION FIXED (z-index 100001)
            // yang menutupi seluruh viewport, jadi screenshot tanpa
            // membuang keduanya hanya memotret overlay - bukan section.
            document.getElementById('invitation-cover')?.remove();
            document.querySelector('.fh5co-loader')?.remove();
            document.querySelectorAll('img[loading="lazy"]')
              .forEach((im) => { im.loading = 'eager'; });
            const pending = Array.from(document.images)
              .filter((im) => !im.complete)
              .map((im) => new Promise((r) => { im.onload = im.onerror = r; }));
            const cap = new Promise((r) => setTimeout(r, 5000));
            await Promise.race([Promise.all(pending), cap]);
            if (document.fonts && document.fonts.ready) {
              await Promise.race([document.fonts.ready, cap]);
            }
            await new Promise((r) => setTimeout(r, 500));
            return true;
          })()
        `,
        awaitPromise: true,
        returnByValue: true,
      });

      // ---- Scroll ke seam ----
      // Scroll-nya BUKAN window: #page (overflow-x:hidden -> jadi scroll
      // container internal) yang menggulir, sementara body terkunci
      // overflow:hidden. Jadi scroll #page, lalu tangkap VIEWPORT biasa.
      const pos = await cdp.send("Runtime.evaluate", {
        expression: `
          (() => {
            const doa = document.getElementById('fh5co-doa');
            const scroller = document.getElementById('page');
            const sTop = scroller.scrollTop;
            const seamInScroller = doa.getBoundingClientRect().bottom
              - scroller.getBoundingClientRect().top + sTop;
            scroller.scrollTop = Math.max(0, seamInScroller - scroller.clientHeight / 2);
            const seamViewportY = Math.round(
              doa.getBoundingClientRect().bottom
            );
            return {
              seamViewportY,
              scrollTop: scroller.scrollTop,
              clientH: scroller.clientHeight,
              scrollH: scroller.scrollHeight,
              dpr: window.devicePixelRatio
            };
          })()
        `,
        returnByValue: true,
      });

      const pv0 = pos.result.value;
      await sleep(500);

      // Kanal koordinat: baris piksel screenshot = baris CSS * dpr.
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });

      const rows = await cdp.send("Runtime.evaluate", {
        expression: `
          (async () => {
            const bin = atob(${JSON.stringify(shot.data)});
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
            const cv = new OffscreenCanvas(bmp.width, bmp.height);
            const ctx = cv.getContext('2d');
            ctx.drawImage(bmp, 0, 0);
            const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
            const res = [];
            for (let y = 0; y < bmp.height; y++) {
              let r = 0, g2 = 0, b = 0;
              for (let x = 0; x < bmp.width; x++) {
                const i = (y * bmp.width + x) * 4;
                r += data[i]; g2 += data[i+1]; b += data[i+2];
              }
              const n = bmp.width;
              res.push([y, Math.round(r/n), Math.round(g2/n), Math.round(b/n)]);
            }
            return { w: bmp.width, h: bmp.height, rows: res };
          })()
        `,
        awaitPromise: true,
        returnByValue: true,
      });

      const rv = rows.result.value;
      // Baris piksel screenshot = koordinat viewport * dpr.
      const seamPx = Math.round(pv0.seamViewportY * pv0.dpr);
      out += `\n===== ${vp.label} (${vp.width}x${vp.height} @${vp.dsf}x) =====\n`;
      out += `seam viewportY=${pv0.seamViewportY} dpr=${pv0.dpr} scrollTop=${pv0.scrollTop}/${pv0.scrollH} clientH=${pv0.clientH} | doa h=${Math.round(g.doaH)} more-us h=${Math.round(g.moreUsH)}\n`;
      out += "  rel |     R,    G,    B\n";

      for (const [y, r, g2, b] of rv.rows) {
        const rel = y - seamPx;
        if (Math.abs(rel) > 300) continue;
        const mark = rel === 0 ? "  <== SEAM" : "";
        out += `${String(rel).padStart(5)} | ${String(r).padStart(4)},${String(g2).padStart(4)},${String(b).padStart(4)}${mark}\n`;
      }

      fs.writeFileSync(path.join(__dirname, "measure-output.txt"), out, "utf8");
    }

    console.log(out);
    fs.writeFileSync(path.join(__dirname, "measure-output.txt"), out, "utf8");
  } finally {
    chrome.kill();
  }
}

main().catch((e) => {
  console.error("GAGAL:", e);
  process.exit(1);
});