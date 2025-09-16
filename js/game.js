// js/game.js
import { ethers } from "https://esm.sh/ethers@6.13.2";

(() => {
  "use strict";

  // ===== CONFIG =====
  const BUILD_HASH    = "v0.1";
  const CONTRACT_ADDR = "0xc93f91a0C605a1829e95aEe5097699c0Fb83A922";
  const MONAD_TESTNET = {
    chainId: "0x279f",
    chainName: "Monad Testnet",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: ["https://testnet-rpc.monad.xyz"],
    blockExplorerUrls: []
  };

  // Prefer your main domain first, then alternates and (optionally) local dev
  const API_BASES = [
    "https://losarchos.com",
    "http://127.0.0.1:3000",                // dev only (may be blocked on https pages)
    `http://${location.hostname}:3000`      // dev only
  ];

  // ===== DOM refs =====
  const $ = (id) => document.getElementById(id);
  const btnConnect   = $("btnConnect");
  const btnID        = $("btnID");
  const btnVerify    = $("btnVerifyOnly");
  const btnSubmit    = $("btnSubmit");
  const elScore      = $("score");
  const elBest       = $("best");
  const elSeed       = $("seedShort");
  const elGID        = $("gid");
  const statusEl     = $("status");

  // ===== tiny logger =====
  const log = (msg, obj) => {
    const ts = new Date().toISOString().slice(11, 19);
    statusEl.textContent += `\n[${ts}] ${msg}${obj !== undefined ? " " + JSON.stringify(obj) : ""}`;
    statusEl.scrollTop = statusEl.scrollHeight;
    console.log("[BLITZ]", msg, obj ?? "");
  };

  // ===== helper: multi-base fetch with timeout =====
  async function tryFetchJSON(url, opts = {}, timeoutMs = 4000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...opts, signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  }

  async function fetchJSON(path) {
    for (const base of API_BASES) {
      try {
        const j = await tryFetchJSON(`${base}${path}?t=${Date.now()}`, {
          mode: "cors",
          cache: "no-store",
          credentials: "omit"
        });
        log("fetchJSON OK", { base, path });
        return j;
      } catch (e) {
        log("fetchJSON fail; trying next", { base, path, err: String(e) });
        continue;
      }
    }
    throw new Error("All API bases unreachable");
  }

  async function postJSON(path, body) {
    for (const base of API_BASES) {
      try {
        const j = await tryFetchJSON(`${base}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          mode: "cors",
          cache: "no-store",
          credentials: "omit"
        });
        log("postJSON OK", { base, path });
        return j;
      } catch (e) {
        log("postJSON fail; trying next", { base, path, err: String(e) });
        continue;
      }
    }
    throw new Error("All API bases unreachable");
  }

  // ===== Wallet / chain =====
  let provider, signer, wallet;
  async function ensureWallet() {
    if (!window.ethereum) {
      alert("Install MetaMask (or a compatible wallet).");
      throw new Error("no metamask");
    }
    provider = new ethers.BrowserProvider(window.ethereum);
    try {
      const net = await provider.getNetwork();
      if (net.chainId !== BigInt(0x279f)) {
        try {
          await window.ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: MONAD_TESTNET.chainId }]
          });
        } catch (e) {
          if (e && e.code === 4902) {
            await window.ethereum.request({
              method: "wallet_addEthereumChain",
              params: [MONAD_TESTNET]
            });
          } else {
            throw e;
          }
        }
      }
    } catch (e) {
      log("chain switch/add failed", String(e));
    }
    signer = await provider.getSigner();
    wallet = await signer.getAddress();
    btnConnect.textContent = wallet.slice(0, 6) + "…" + wallet.slice(-4);
    updateButtons();
    log("wallet connected", { wallet });
  }
  btnConnect.addEventListener("click", ensureWallet);

  // ===== Gate: require Game ID before play =====
  let gameId = 0;
  let alive = false; // start gated (no gameplay until ID)
  function updateButtons() {
    const hasIds = !!(signer && gameId);
    btnVerify.disabled = !hasIds;
    btnSubmit.disabled = !(hasIds && !alive); // can submit only on game over
  }

  btnID.addEventListener("click", async () => {
    if (!signer) await ensureWallet();
    // TEMP deterministic ID — replace with official Monad Games ID flow when ready
    const digest = ethers.keccak256(ethers.toUtf8Bytes(wallet));
    gameId = Number(BigInt(digest) % 1_000_000_000n);
    elGID.textContent = String(gameId);
    log("claimed GameID", { gameId });
    await startNewRun(); // start gameplay now
  });

  // ===== Seed / RNG =====
  let RUN_NONCE = 0, SEED_HEX = "0x";
  async function getDailyBlockHash() {
    try {
      const { blockhash } = await fetchJSON("/games/blitz/dailyhash");
      if (blockhash?.startsWith("0x")) return blockhash;
      log("dailyhash bad payload", { blockhash });
    } catch (e) {
      log("dailyhash unreachable; using fallback", String(e));
    }
    const d = new Date(); d.setUTCHours(0, 0, 0, 0);
    return ethers.keccak256(ethers.toUtf8Bytes(String(d.getTime())));
  }

  async function computeSeed() {
    const daily = await getDailyBlockHash();
    RUN_NONCE = Math.floor(Math.random() * 1e9);
    SEED_HEX = ethers.keccak256(
      ethers.concat([
        ethers.getBytes(daily),
        ethers.toUtf8Bytes(String(gameId || 0)),
        ethers.toUtf8Bytes(String(RUN_NONCE))
      ])
    );
    window.__BLITZ_RUN_NONCE = RUN_NONCE;
    window.__BLITZ_SEED_HEX = SEED_HEX;
    elSeed.textContent = SEED_HEX.slice(0, 10) + "…";
    log("seed computed", { daily, RUN_NONCE, SEED_HEX });
    return SEED_HEX;
  }

  function rngFactory(seedHex) {
    let x = Number(BigInt(seedHex) % 4294967291n) || 123456789;
    return () => {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      return (x >>> 0) / 4294967296;
    };
  }
  let rand;

  // ===== Game state =====
  const canvas = $("game");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height, ground = H - 40;

  let t = 0, score = 0, best = 0, speed = 5, gravity = 0.6;
  const player = { x: 90, y: ground, vy: 0, w: 28, h: 28, charging: false, jumpPower: 0 };
  const obs = [];
  const pows = [];
  let shield = 0, slowmo = 0;

  function spawnObstacle() {
    const R = rand || Math.random;
    const w = 20 + Math.floor(R() * 24);
    const h = 20 + Math.floor(R() * 40);
    const type = R() < 0.15 ? "tall" : "box";
    obs.push({ x: W + R() * 80, w, h, type });
    if (R() < 0.18) {
      const pt = R() < 0.5 ? "shield" : "slow";
      pows.push({ x: W + 40 + R() * 120, y: ground - 60, r: 10, type: pt });
    }
  }

  function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }

  function drawFrame() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#0f1826"; ctx.fillRect(0, ground, W, 4);
    ctx.fillStyle = "#89d2ff"; ctx.fillRect(player.x, player.y - player.h, player.w, player.h);
    if (shield > 0) { ctx.strokeStyle = "#89d2ff"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(player.x + player.w / 2, player.y - player.h / 2, 20, 0, Math.PI * 2); ctx.stroke(); }
    ctx.fillStyle = "#2b3d5c"; for (const o of obs) ctx.fillRect(o.x, ground - o.h, o.w, o.h);
    for (const p of pows) { ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fillStyle = p.type === "shield" ? "#6fffc3" : "#ffd56f"; ctx.fill(); }
    ctx.fillStyle = "#2a3750"; for (let i = 0; i < W; i += 32) ctx.fillRect(i, ground + 4, 16, 3);

    if (!alive) {
      ctx.fillStyle = "rgba(0,0,0,.6)"; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#fff"; ctx.font = "20px Inter, system-ui";
      const msg = signer ? "Claim your Game ID to play" : "Connect wallet to play";
      ctx.fillText(msg, 260, 130);
      ctx.font = "14px Inter, system-ui";
      ctx.fillText("Tip: use the buttons above", 310, 160);
    }
  }

  function step() {
    if (!alive) { drawFrame(); return; }
    requestAnimationFrame(step);
    t++;

    // difficulty curve
    speed += 0.0009;
    gravity = 0.6 + Math.min(t / 6000, 0.4);

    const curSpeed = slowmo > 0 ? speed * 0.6 : speed;
    if (slowmo > 0) slowmo--;

    // player
    if (player.charging && player.y >= ground) player.jumpPower += 0.9;
    player.vy += gravity;
    player.y += player.vy;
    if (player.y > ground) { player.y = ground; player.vy = 0; }

    // spawn cadence
    const R = rand || Math.random;
    if (t % Math.floor(50 + 60 * R()) === 0) spawnObstacle();

    // move & powerups
    for (let i = obs.length - 1; i >= 0; i--) {
      const o = obs[i]; o.x -= curSpeed; if (o.x + o.w < 0) obs.splice(i, 1);
    }
    for (let i = pows.length - 1; i >= 0; i--) {
      const p = pows[i]; p.x -= curSpeed; if (p.x + p.r < 0) { pows.splice(i, 1); continue; }
      if (rectsOverlap(player.x, player.y - player.h, player.w, player.h, p.x - p.r, p.y - p.r, p.r * 2, p.r * 2)) {
        if (p.type === "shield") shield = 600; else slowmo = 360;
        pows.splice(i, 1);
      }
    }
    if (shield > 0) shield--;

    // collisions
    for (const o of obs) {
      const hit = rectsOverlap(player.x, player.y - player.h, player.w, player.h, o.x, ground - o.h, o.w, o.h);
      if (hit) {
        if (shield > 0) { shield = 0; o.x = -9999; }
        else { alive = false; updateButtons(); }
      }
    }

    // score
    score += (slowmo ? 0.5 : 1);
    best = Math.max(best, Math.floor(score));
    elScore.textContent = String(Math.floor(score));
    elBest.textContent = String(best);

    drawFrame();
  }

  function addInputs() {
    addEventListener("keydown", (e) => {
      if (alive && (e.code === "ArrowUp" || e.code === "KeyW")) { player.charging = true; e.preventDefault(); }
    });
    addEventListener("keyup", (e) => {
      if (alive && (e.code === "ArrowUp" || e.code === "KeyW")) {
        player.vy = -(6 + Math.min(player.jumpPower / 8, 12));
        player.charging = false; player.jumpPower = 0;
      }
    });
    canvas.addEventListener("pointerdown", () => { if (alive) player.charging = true; });
    canvas.addEventListener("pointerup", () => {
      if (alive) { player.vy = -(6 + Math.min(player.jumpPower / 8, 12)); player.charging = false; player.jumpPower = 0; }
    });
    addEventListener("keydown", () => { if (!alive && signer && gameId) startNewRun(); });
    canvas.addEventListener("pointerdown", () => { if (!alive && signer && gameId) startNewRun(); });
  }

  async function startNewRun() {
    await computeSeed();
    rand = rngFactory(SEED_HEX);
    t = 0; alive = true; score = 0; speed = 5; gravity = 0.6; shield = 0; slowmo = 0;
    obs.length = 0; pows.length = 0; for (let i = 0; i < 6; i++) spawnObstacle();
    updateButtons();
    requestAnimationFrame(step);
  }

  // ===== Verify-only =====
  btnVerify.addEventListener("click", async () => {
    if (!signer || !gameId) { alert("Connect & claim Game ID first"); return; }
    const payload = { gameId, score: Math.floor(best), runNonce: RUN_NONCE, seed: SEED_HEX, build: BUILD_HASH, addr: wallet };
    log("POST /verify", payload);
    try {
      const { serverSig } = await postJSON("/games/blitz/verify", payload);
      if (!serverSig) throw new Error("No serverSig");
      log("verify ok (serverSig)", { serverSig: serverSig.slice(0, 12) + "…" });
      window.debugBlitz = { payload, serverSig };
    } catch (e) {
      log("verify failed", String(e));
      alert("Verify failed");
    }
  });

  // ===== Submit (verify → on-chain) =====
  btnSubmit.addEventListener("click", async () => {
    try {
      if (!signer || !gameId) { alert("Connect & claim Game ID first"); return; }
      const payload = { gameId, score: Math.floor(best), runNonce: RUN_NONCE, seed: SEED_HEX, build: BUILD_HASH, addr: wallet };
      log("POST /verify (submit)", payload);
      const { serverSig } = await postJSON("/games/blitz/verify", payload);
      if (!serverSig) throw new Error("No serverSig");
      const abi = ["function submit(uint256,uint256,bytes)"];
      const c = new ethers.Contract(CONTRACT_ADDR, abi, signer);
      const tx = await c.submit(gameId, payload.score, serverSig);
      log("submitted on-chain", { tx: tx.hash });
      alert("Submitted! Tx: " + tx.hash);
    } catch (e) {
      console.error(e);
      log("submit error", String(e));
      alert("Submit error: " + (e?.message || e));
    }
  });

  // ===== boot: gated splash (no run yet) =====
  (async () => {
    addInputs();
    drawFrame(); // splash
    // Optional health check
    try {
      const j = await fetchJSON("/games/blitz/dailyhash");
      log("dailyhash ok", j);
    } catch (e) {
      log("dailyhash unreachable (all bases)", String(e));
    }
  })();

})();
