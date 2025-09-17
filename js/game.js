// js/game.js
import { ethers } from "https://esm.sh/ethers@6.13.2";

(() => {
  "use strict";

  // ===== CONFIG =====
  const BUILD_HASH    = "v0.2";
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
  const elBoard    = $("leaderboard");
  const statusEl   = $("status");

  // ===== logger =====
  const log = (msg, obj) => {
    const ts = new Date().toISOString().slice(11, 19);
    statusEl.textContent += `\n[${ts}] ${msg}${obj ? " " + JSON.stringify(obj) : ""}`;
    statusEl.scrollTop = statusEl.scrollHeight;
    console.log("[BLITZ]", msg, obj ?? "");
  };

  // ===== fetch helpers =====
  async function fetchJSON(path) {
    for (const base of API_BASES) {
      try {
        const r = await fetch(`${base}${path}?t=${Date.now()}`, {
          mode: "cors", cache: "no-store", credentials: "omit"
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        log("fetchJSON OK", { base, path });
        return j;
      } catch (e) {
        log("fetchJSON fail", { base, path, err: String(e) });
      }
    }
    throw new Error("All API bases unreachable");
  }

  // ===== Wallet =====
  let provider, signer, wallet;
  async function ensureWallet() {
    if (!window.ethereum) { alert("Install MetaMask"); throw new Error("no metamask"); }
    provider = new ethers.BrowserProvider(window.ethereum);
    signer = await provider.getSigner();
    wallet = await signer.getAddress();
    btnConnect.textContent = wallet.slice(0,6) + "…" + wallet.slice(-4);
    updateButtons();
    log("wallet connected", { wallet });
  }
  btnConnect.addEventListener("click", ensureWallet);

  // ===== Game ID =====
  let gameId = 0;
  let alive = false;
  function updateButtons() {
    const hasIds = !!(signer && gameId);
    btnSubmit.disabled = !(hasIds && !alive && best > 0);
    btnID.textContent  = gameId ? (alive ? "Playing…" : "Play Game") : "Claim Game ID";
    btnID.disabled = alive;
  }

  btnID.addEventListener("click", async () => {
    if (!signer) await ensureWallet();
    if (!gameId) {
      const digest = ethers.keccak256(ethers.toUtf8Bytes(wallet));
      gameId = Number(BigInt(digest) % 1_000_000_000n);
      elGID.textContent = String(gameId);
      log("claimed GameID", { gameId });
    }
    if (!alive) await startNewRun();
    updateButtons();
  });

  // ===== Seed =====
  let RUN_NONCE = 0, SEED_HEX = "0x";
  async function computeSeed() {
    const { blockhash } = await fetchJSON("/games/blitz/dailyhash").catch(()=>({}));
    const daily = blockhash || ethers.keccak256(ethers.toUtf8Bytes(String(Date.now())));
    RUN_NONCE = 0;
    SEED_HEX = ethers.keccak256(ethers.concat([
      ethers.getBytes(daily), ethers.toUtf8Bytes(String(gameId || 0))
    ]));
    elSeed.textContent = SEED_HEX.slice(0,10)+"…";
    return SEED_HEX;
  }
  function rngFactory(seedHex) {
    let x = Number(BigInt(seedHex) % 4294967291n) || 123456;
    return ()=>{ x^=x<<13; x^=x>>>17; x^=x<<5; return (x>>>0)/4294967296; };
  }
  let rand;

  // ===== Game state =====
  const canvas = $("game"), ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height, ground = H-40;
  let t=0, score=0, best=0, speed=2.5, gravity=0.4;
  const player = { x:90, y:ground, vy:0, w:28, h:28 };
  const obs=[]; let jumpsLeft=2;

  function spawnObstacle() {
    const R = rand||Math.random;
    if (R()<0.25) return;
    const w=20+Math.floor(R()*20), h=20+Math.floor(R()*25);
    obs.push({x:W+R()*160,w,h});
  }
  function rectsOverlap(ax,ay,aw,ah,bx,by,bw,bh) {
    return ax<bx+bw && ax+aw>bx && ay<by+bh && ay+ah>by;
  }
  function drawFrame() {
    ctx.clearRect(0,0,W,H);
    ctx.fillStyle="#0f1826"; ctx.fillRect(0,ground,W,4);
    ctx.fillStyle="#89d2ff"; ctx.fillRect(player.x,player.y-player.h,player.w,player.h);
    ctx.fillStyle="#2b3d5c"; for(const o of obs) ctx.fillRect(o.x,ground-o.h,o.w,o.h);
    if(!alive){
      ctx.fillStyle="rgba(0,0,0,.6)"; ctx.fillRect(0,0,W,H);
      ctx.fillStyle="#fff"; ctx.font="20px Inter"; 
      const msg = signer?(gameId?"Game Over — Submit Score":"Claim Game ID"):"Connect wallet";
      ctx.fillText(msg,220,140);
    }
  }

  function step() {
    if(!alive){drawFrame();return;}
    requestAnimationFrame(step); t++;
    speed+=0.0002; gravity=0.4+Math.min(t/15000,0.25);

    player.vy+=gravity; player.y+=player.vy;
    if(player.y>=ground){player.y=ground; player.vy=0; jumpsLeft=2;}

    const R=rand||Math.random;
    if(t%Math.floor(100+120*R())===0) spawnObstacle();
    for(let i=obs.length-1;i>=0;i--){const o=obs[i]; o.x-=speed; if(o.x+o.w<0)obs.splice(i,1);}
    for(const o of obs){
      if(rectsOverlap(player.x,player.y-player.h,player.w,player.h,o.x,ground-o.h,o.w,o.h)){
        alive=false; updateButtons();
      }
    }

    score+=1; best=Math.max(best,Math.floor(score));
    elScore.textContent=String(Math.floor(score)); elBest.textContent=String(best);
    drawFrame();
  }

  // ===== Inputs =====
  function addInputs(){
    addEventListener("keydown",e=>{
      if(alive && (e.code==="ArrowUp"||e.code==="KeyW")){
        if(jumpsLeft>0){player.vy=-12; jumpsLeft--;}
        e.preventDefault();
      } else if(!alive && signer && gameId){ startNewRun(); }
    });
    canvas.addEventListener("pointerdown",()=>{
      if(alive && jumpsLeft>0){player.vy=-12; jumpsLeft--;}
      else if(!alive && signer && gameId){ startNewRun(); }
    });
  }

  // ===== Run start =====
  async function startNewRun(){
    if(!gameId){alert("Claim Game ID first!");return;}
    if(alive)return;
    await computeSeed(); rand=rngFactory(SEED_HEX);
    t=0; alive=true; score=0; speed=2.5; gravity=0.4; jumpsLeft=2;
    obs.length=0; for(let i=0;i<2;i++) spawnObstacle();
    updateButtons(); requestAnimationFrame(step);
  }

  // ===== Submit Score =====
  btnSubmit.addEventListener("click",async()=>{
    if(!signer||!gameId){alert("Connect & claim Game ID first");return;}
    const payload={gameId,score:Math.floor(best),addr:wallet,build:BUILD_HASH};
    log("submit clicked",payload);
    try{
      const res=await fetch(`${API_BASES[0]}/games/blitz/verify`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify(payload)
      });
      const j=await res.json(); log("verify response",j);
      if(!j.serverSig){alert("Verify failed");return;}
      const abi=["function submit(uint256,uint256,bytes)"];
      const c=new ethers.Contract(CONTRACT_ADDR,abi,signer);
      const tx=await c.submit(gameId,payload.score,j.serverSig);
      log("tx sent",{hash:tx.hash}); alert("Submitted! Tx: "+tx.hash);
      await loadLeaderboard();
    }catch(e){log("submit error",String(e));alert("Submit error: "+(e?.message||e));}
  });

  // ===== Leaderboard =====
  async function loadLeaderboard(limit=10){
    try{
      const res=await fetchJSON(`/games/blitz/leaderboard?limit=${limit}`);
      renderLeaderboard(res);
    }catch(e){log("leaderboard fetch failed",String(e));}
  }
  function renderLeaderboard(entries){
    if(!entries||!entries.length){elBoard.innerHTML="<p>No scores yet</p>";return;}
    let html=`<table><tr><th>#</th><th>Player</th><th>Score</th></tr>`;
    entries.forEach((r,i)=>{html+=`<tr><td>${i+1}</td><td>${r.username||"anon"}</td><td>${r.score}</td></tr>`;});
    html+="</table>"; elBoard.innerHTML=html;
  }

  // ===== boot =====
  (async()=>{
    addInputs(); drawFrame();
    try{await fetchJSON("/games/blitz/dailyhash");}catch{}
    await loadLeaderboard();
  })();

})();
