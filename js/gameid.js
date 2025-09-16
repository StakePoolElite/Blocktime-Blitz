// js/gameid.js
// Minimal adapter for Monad Games ID (kept for future integration)
// NOTE: this attaches to window.GAMESID; no exports required.

import { ethers } from "https://esm.sh/ethers@6.13.2";

(() => {
  'use strict';

  const CONFIG = {
    // Fill with official values when provided
    REGISTRY_ADDR: "0xGameIDRegistryGoesHere",
    REGISTRY_ABI: [
      "function idOf(address) view returns (uint256)",
      "function usernameOf(uint256) view returns (string)",
      "function register(string username) returns (uint256)",
      "event Registered(address indexed player, uint256 indexed gameId, string username)"
    ],
    ATTESTOR_ADDR: "0xGamesIDAttestorOrLeaderboard",
    ATTESTOR_ABI: [
      "function submitScore(uint256 gameId, uint256 score, bytes serverSig) external",
      "function best(uint256 gameId) view returns (uint256)",
      "event NewBest(uint256 indexed gameId, uint256 score, string username)"
    ],
    API_BASE: "https://gamesid.monad.xyz",
    ROUTES: {
      reserve: "/reserve",
      me: "/me",
      verifyScore: "/verify",
      leaderboard: "/leaderboard?limit=50"
    },
    DOMAIN_TAG: "MONAD_GAMES_ID",
  };

  class GamesID {
    constructor(provider){ this.provider = provider; this.signer = null; this.addr = null; this.gameId = 0; this.username = null; }
    async connect(){ if (!this.provider) throw new Error("No provider"); this.signer = await this.provider.getSigner(); this.addr = await this.signer.getAddress(); return this.addr; }

    // On-chain registry path (when available)
    async ensureOnchainID(preferredUsername){
      const reg = new ethers.Contract(CONFIG.REGISTRY_ADDR, CONFIG.REGISTRY_ABI, this.signer);
      const existing = await reg.idOf(this.addr);
      if (existing && Number(existing) !== 0n) {
        this.gameId = Number(existing);
        try { this.username = await reg.usernameOf(existing); } catch {}
        return { gameId: this.gameId, username: this.username };
      }
      const tx = await reg.register(preferredUsername || ("player_" + this.addr.slice(2,6)));
      await tx.wait();
      const id2 = await reg.idOf(this.addr);
      this.gameId = Number(id2);
      try { this.username = await reg.usernameOf(id2); } catch {}
      return { gameId: this.gameId, username: this.username };
    }

    // HTTP reserve path (if provided)
    async reserveUsernameHTTP(username){
      const body = { address: this.addr, username };
      const res = await fetch(CONFIG.API_BASE + CONFIG.ROUTES.reserve, { method:"POST", headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
      if (!res.ok) throw new Error("reserve failed");
      const j = await res.json();
      this.gameId = j.gameId; this.username = j.username || username;
      return { gameId: this.gameId, username: this.username };
    }

    async signSession(nonce = Math.floor(Math.random()*1e9)){
      const msg = [CONFIG.DOMAIN_TAG,"Login",`addr=${this.addr}`,`nonce=${nonce}`,`ts=${Date.now()}`].join("\n");
      const sig = await this.signer.signMessage(msg);
      return { msg, sig, nonce };
    }

    async getServerSigForScore({ gameId, score, seed, runNonce, build }){
      const payload = { gameId, score, seed, runNonce, build, addr: this.addr };
      const res = await fetch(CONFIG.API_BASE + CONFIG.ROUTES.verifyScore, { method:"POST", headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error("verifyScore failed");
      return res.json();
    }

    async submitOnchain({ gameId, score, serverSig }){
      const c = new ethers.Contract(CONFIG.ATTESTOR_ADDR, CONFIG.ATTESTOR_ABI, this.signer);
      return c.submitScore(gameId, score, serverSig);
    }

    async fetchLeaderboard(limit=20){
      const url = CONFIG.API_BASE + CONFIG.ROUTES.leaderboard + `&limit=${limit}`;
      const res = await fetch(url);
      if (!res.ok) return [];
      return res.json();
    }
  }

  // Attach to window for optional use elsewhere
  window.GAMESID = { CONFIG, GamesID };
})();
