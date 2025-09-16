// js/game.js
import { ethers } from "https://esm.sh/ethers@6.13.2";

(() => {
  "use strict";

  // ===== CONFIG =====
  const BUILD_HASH    = "v0.1.1";
  const CONTRACT_ADDR = "0xc93f91a0C605a1829e95aEe5097699c0Fb83A922";
  const MONAD_TESTNET = {
    chainId: "0x279f",
    chainName: "Monad Testnet",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: ["https://testnet-rpc.monad.xyz"],
    blockExplorerUrls: []
  };

  const API_BASES = ["https://losarchos.com"];

  // ===== DOM refs =====
  const $ = (id) => document.getElementById(id);
  const btnConnect = $("btnConnect");
  const btnID      = $("btnID");
  const btnSubmit  = $("btnSubmit");
  const elScore    = $("score");
  const elBest     = $("best");
  const elSeed     = $("seedShort");
  const elGID      = $("gid");
  const statusEl   = $("status");

  // ===== tiny logger =====
  const log = (msg, obj) => {
    const ts = new Date().toISOString().slice(11, 19);
    statusEl.textContent += `\n[${ts}] ${msg}${obj !== undefined ? " " + JSON.stringify(obj) : ""}`;
    statusEl.scrollTop = statusEl.scrollHeight;
    console.log("[BLITZ]", msg, obj ?? "");
  };

  // ===== fetch helpers =====
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
      }
    }
    throw new Error("All API bases unreachable");
  }

  // ===== Wallet =====
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
          } else throw e;
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

  // ===== Game ID gating =====
  let gameId = 0;
  let alive = false;
  function updateButtons() {
    const hasIds = !!(signer && gameId);
    btnSubmit.disabled = !(hasIds && !alive);
    btnID.textContent = gameId ? (alive ? "Playing…" : "Play Game") : "Claim Game ID";
    btnID.disabled = alive; // disable while in-game
  }

  btnID.addEventListener("click", async () => {
    if (!signer) await ensureWallet();

    if (!gameId) {
      const digest = ethers.keccak256(ethers.toUtf8Bytes(wallet));
      gameId = Number(BigInt(digest) % 1_000_000_000n);
      elGID.textContent = String(gameId);
      log("claimed GameID", { gameId });
    }

    if (!alive) {
      await startNewRun();
    }
    updateButtons();
  });

  // ===== Seed =====
  let RUN_NONCE = 0, SEED_HEX = "0x";
  async function getDailyBlockHash() {
    try {
      const { blockhash } = await fetchJSON("/games/blitz/dailyhash");
      if (blockhash?.startsWith("0x")) return blockhash;
    } catch (e) {
      log("dailyhash unreachable; using fallback", String(e));
    }
    const d = new Date(); d.setUTCHours(0, 0, 0, 0);
    return ethers.keccak256(ethers.toUtf8Bytes(String(d.getTime())));
  }

  async function computeSeed() {
    const daily = await getDailyBlockHash();
    RUN_NONCE = 0;
    SEED_HEX = ethers.keccak256(ethers.concat([
      ethers.getBytes(daily),
      ethers.toUtf8Bytes(String(gameId || 0))
    ]));
    window.__BLITZ_RUN_NONCE = RUN_NONCE;
    window.__BLITZ_SEED_HEX = SEED_HEX;
    elSeed.textContent = SEED_HEX.slice(0, 10) + "…";
    log("seed computed", { daily, gameId, SEED_HEX });
    return SEED_HEX;
  }

  function rngFactory(seedHex) {
    let x = Number(BigInt(seedHex) % 4294967291n) || 123456789;
    return () => {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      return (x >>> 0) / 4294967296;
    };
  }
  let rand;

  // ===== Game state =====
  const canvas = $("game");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height, ground = H - 40;

  let t = 0, score = 0, best = 0, speed = 3, gravity = 0.5;
  const player = { x: 90, y: ground, vy: 0, w: 28, h: 28, charging: false, jumpPower: 0 };
  const obs = [];
  let jumpsLeft = 2;

  function spawnObstacle() {
    const R = rand || Math.random;
    if (R() < 0.3) return; // fewer obstacles
    const w = 20 + Math.floor(R() * 20);
    const h = 20 + Math.floor(R() * 30);
    obs.push({ x: W + R() * 120, w, h });
  }

  function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }

  function drawFrame() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#0f1826"; ctx.fillRect(0, ground, W, 4);
    ctx.fillStyle = "#89d2ff"; ctx.fillRect(player.x, player.y - player.h, player.w, player.h);
    ctx.fillStyle = "#2b3d5c"; for (const o of obs) ctx.fillRect(o.x, ground - o.h, o.w, o.h);

    if (!alive) {
      ctx.fillStyle = "rgba(0,0,0,.6)"; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#fff"; ctx.font = "20px Inter, system-ui";
      const msg = signer ? (gameId ? "Press Play Game" : "Claim your Game ID") : "Connect wallet to play";
      ctx.fillText(msg, 220, 140);
    }
  }

  function step() {
    if (!alive) { drawFrame(); return; }
    requestAnimationFrame(step);
    t++;

    speed += 0.0003; // slower acceleration
    gravity = 0.5 + Math.min(t / 12000, 0.3);

    // player
    player.vy += gravity;
    player.y += player.vy;
    if (player.y >= ground) {
      player.y = ground; player.vy = 0; jumpsLeft = 2;
    }

    if (player.charging && player.y >= ground) player.jumpPower += 0.8;

    // spawn cadence
    const R = rand || Math.random;
    if (t % Math.floor(100 + 80 * R()) === 0) spawnObstacle();

    // move obstacles
    for (let i = obs.length - 1; i >= 0; i--) {
      const o = obs[i]; o.x -= speed; if (o.x + o.w < 0) obs.splice(i, 1);
    }

    // collisions
    for (const o of obs) {
      if (rectsOverlap(player.x, player.y - player.h, player.w, player.h, o.x, ground - o.h, o.w, o.h)) {
        alive = false; updateButtons();
      }
    }

    // score
    score += 1;
    best = Math.max(best, Math.floor(score));
    elScore.textContent = String(Math.floor(score));
    elBest.textContent = String(best);

    drawFrame();
  }

  // ===== Inputs =====
  function addInputs() {
    addEventListener("keydown", (e) => {
      if (alive && (e.code === "ArrowUp" || e.code === "KeyW")) {
        if (jumpsLeft > 0) {
          player.vy = -(12 + Math.min(player.jumpPower / 5, 14)); // stronger jump
          player.charging = false; player.jumpPower = 0;
          jumpsLeft--;
        }
        e.preventDefault();
      } else if (!alive && signer && gameId) startNewRun();
    });
    canvas.addEventListener("pointerdown", () => {
      if (alive && jumpsLeft > 0) {
        player.vy = -14; jumpsLeft--; player.charging=false; player.jumpPower=0;
      } else if (!alive && signer && gameId) startNewRun();
    });
  }

  // ===== Run start =====
  async function startNewRun() {
    if (!gameId) { alert("Claim your Game ID first!"); return; }
    if (alive) return;

    await computeSeed();
    rand = rngFactory(SEED_HEX);
    t = 0; alive = true; score = 0; speed = 3; gravity = 0.5; jumpsLeft = 2;
    obs.length = 0; for (let i = 0; i < 3; i++) spawnObstacle();
    updateButtons();
    requestAnimationFrame(step);
  }

  // ===== boot =====
  (async () => {
    addInputs();
    drawFrame();
    try { const j = await fetchJSON("/games/blitz/dailyhash"); log("dailyhash ok", j); }
    catch (e) { log("dailyhash unreachable", String(e)); }
  })();


// … (everything above unchanged) …

  // ===== Submit (verify → on-chain) =====
  btnSubmit.addEventListener("click", async () => {
    if (!signer || !gameId) { alert("Connect & claim Game ID first"); return; }
    const payload = { 
      gameId, 
      score: Math.floor(best), 
      runNonce: RUN_NONCE, 
      seed: SEED_HEX, 
      build: BUILD_HASH, 
      addr: wallet 
    };
    log("POST /verify (submit)", payload);

    try {
      const { serverSig } = await postJSON("/games/blitz/verify", payload);
      if (!serverSig) throw new Error("No serverSig");
      log("verify ok (serverSig)", { serverSig: serverSig.slice(0, 12) + "…" });

      const abi = ["function submit(uint256,uint256,bytes)"];
      const c = new ethers.Contract(CONTRACT_ADDR, abi, signer);
      const tx = await c.submit(gameId, payload.score, serverSig);
      log("submitted on-chain", { tx: tx.hash });
      alert("Submitted! Tx: " + tx.hash);

      await loadLeaderboard(); // refresh after submit
    } catch (e) {
      log("submit error", String(e));
      alert("Submit error: " + (e?.message || e));
    }
  });

  // ===== Leaderboard =====
  async function loadLeaderboard(limit=10) {
    try {
      const res = await fetchJSON(`/games/blitz/leaderboard?limit=${limit}`);
      renderLeaderboard(res);
    } catch (e) {
      log("leaderboard fetch failed", String(e));
    }
  }

  function renderLeaderboard(entries) {
    const el = $("leaderboard");
    if (!entries || !entries.length) {
      el.innerHTML = "<p>No scores yet</p>";
      return;
    }
    let html = `<table><tr><th>#</th><th>Player</th><th>Score</th></tr>`;
    entries.forEach((row, i) => {
      html += `<tr><td>${i+1}</td><td>${row.username || "anon"}</td><td>${row.score}</td></tr>`;
    });
    html += "</table>";
    el.innerHTML = html;
  }

  // ===== boot =====
  (async () => {
    addInputs();
    drawFrame();
    try { const j = await fetchJSON("/games/blitz/dailyhash"); log("dailyhash ok", j); }
    catch (e) { log("dailyhash unreachable", String(e)); }

    await loadLeaderboard();
  })();

})();


