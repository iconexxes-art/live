/* AccountStore — device-independent user system.
   Accounts, login and the directory live on the LIVE server (data/accounts.json);
   this store talks to the API and keeps a client-side cache for synchronous
   avatar/name lookups in the renderer. Signups and profile edits broadcast to
   every connected device, so caches stay in sync in real time.

   Session: an HttpOnly, SameSite cookie. JavaScript never receives the bearer
   credential, and the server is authoritative for session validity. */

import { ACCENTS } from '../users.js';

const ACCOUNT_KEY = 'live.auth.account.v1';

export class AccountStore {
  constructor() {
    this.cache = new Map(); // id -> public account
  }

  /* ---------- API plumbing ---------- */

  setCurrent(token, account) {
    try {
      /* Session credentials are HttpOnly cookies now; never store a bearer token in JS. */
      sessionStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
    } catch { /* ignore */ }
    this.cache.set(account.id, account);
  }

  getCurrent() {
    try {
      const account = JSON.parse(sessionStorage.getItem(ACCOUNT_KEY) ?? 'null');
      if (account) return { account };
    } catch { /* ignore */ }
    return null;
  }

  clearCurrent() {
    try {
      sessionStorage.removeItem(ACCOUNT_KEY);
    } catch { /* ignore */ }
  }

  async _api(path, options = {}) {
    let res;
    try {
      res = await fetch(path, options);
    } catch {
      throw new Error('Cannot reach the LIVE server.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
    return data;
  }

  /* ---------- auth ---------- */

  async signup({ username, name, password }) {
    const { account } = await this._api('/api/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, name, password }),
    });
    this.setCurrent(null, account);
    return account;
  }

  async login({ username, password }) {
    const { account } = await this._api('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    this.setCurrent(null, account);
    return account;
  }

  /* token check against the server; returns the account or null */
  async validate(token) {
    try {
      const data = await this._api('/api/validate');
      this.cache.set(data.account.id, data.account);
      return data.account;
    } catch {
      return null;
    }
  }

  async logout() {
    try { await this._api('/api/logout', { method: 'POST' }); } finally { this.clearCurrent(); }
  }

  /* ---------- directory ---------- */

  async refresh() {
    /* Directory listing was removed for privacy. The current account is
       enough to seed the local cache; other identities arrive only through
       exact username lookup or an authorized relationship. */
    const current = this.getCurrent();
    if (current?.account?.id) this.cache.set(current.account.id, current.account);
    return current?.account ? [current.account] : [];
  }

  /* profile edits go through the server so every device updates */
  async updateProfile(id, patch) {
    const account = await this._api('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: patch.name, accent: patch.accent }),
    });
    this.cache.set(account.id, account);
    return account;
  }

  /* ---------- synchronous cache reads (renderer / presence) ---------- */

  get(id) {
    return this.cache.get(id) ?? null;
  }

  list(query = '') {
    const q = String(query).trim().toLowerCase();
    const all = [...this.cache.values()].sort((a, b) => a.username.localeCompare(b.username));
    if (!q) return all;
    return all.filter((a) => a.username.includes(q) || a.name.toLowerCase().includes(q));
  }

  /* live updates pushed by the server */
  applyServerEvent(env) {
    if (env.type === 'account.created' || env.type === 'account.updated') {
      if (env.account?.id) this.cache.set(env.account.id, env.account);
    }
    if (env.type === 'request.accepted' && env.user?.id) {
      this.cache.set(env.user.id, env.user); // names/colors reveal on acceptance
    }
  }

  /* ---------- people: exact-username lookup + permission requests ---------- */

  /* exact username only — the server exposes nothing else, and non-connected
     matches carry just {id, username} (no display name, no colors) */
  async findUser(username) {
    const data = await this._api(`/api/users/find?username=${encodeURIComponent(username ?? '')}`);
    if (data.found && data.account?.id) {
      const known = this.cache.get(data.account.id);
      const minimal = !data.account.bg;
      this.cache.set(data.account.id, {
        ...(known ?? {}),
        ...data.account,
        /* not yet connected: render with a neutral identity — no real name */
        ...(minimal ? ACCENTS.slate : {}),
        name: data.account.name ?? (minimal ? `@${data.account.username}` : data.account.name),
        initial: (data.account.name ?? data.account.username)[0].toUpperCase(),
      });
    }
    return data;
  }

  async sendRequest(toId) {
    return this._api('/api/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toId }),
    });
  }

  async acceptRequest(requestId) {
    const data = await this._api('/api/requests/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId }),
    });
    if (data.account?.id) this.cache.set(data.account.id, data.account);
    return data;
  }

  async declineRequest(requestId) {
    return this._api('/api/requests/decline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId }),
    });
  }

  async fetchRequests() {
    const data = await this._api('/api/requests');
    return { incoming: data.incoming ?? [], outgoing: data.outgoing ?? [] };
  }
}
