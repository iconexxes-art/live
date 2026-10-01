
## v0.12 Ratchet Prototype

LIVE v0.13 adds an experimental ratchet state layer for per-message key evolution, bounded out-of-order delivery, replay rejection, authenticated associated data, explicit chain rotation, and serializable local state. It is **not** a production Signal/Double Ratchet implementation and has not been independently audited. Production deployment should use a reviewed, established protocol/library rather than treating this prototype as a cryptographic guarantee.
# LIVE — Phase 1 Prototype

**Communication that happens in real time, not communication that waits for Send.**

The flagship interaction is **Live Writing**: the other person sees your actual
words appear as you type — before you send anything. A draft is a live,
private-until-sent state. It becomes a message only when you press **SEND** —
and messages are ephemeral: they dissolve a few seconds after they are
received. Clear a draft, discard it, or leave, and it simply disappears.

---

## Run it

```bash
node server.mjs
```

Then open **http://localhost:5173**.

## Chat across devices

Everything real-time now flows through the LIVE server, so it is **not limited
to one browser or one machine**:

1. Find this machine's LAN IP (e.g. `ipconfig` on Windows → IPv4 address).
2. On any other device on the same network (phone, tablet, another computer),
   open **http://<that-ip>:5173**.
3. Sign up or log in with a different username on each device.
4. Chat is **permission-gated** — see below.

## Privacy model: nobody is listed, nobody chats without permission

- **No directory.** There is no list of users anywhere. Names are invisible
  until someone accepts you.
- **Exact-username search only.** PEOPLE is a lookup, not a browse: type an
  exact username and nothing else matches — partials return nothing.
- **Requests.** A found stranger shows only `@username` ("name hidden until
  they accept"). Tap **REQUEST TO CHAT**; the recipient gets a realtime badge
  and an inbox entry, and sees who's asking. They **ACCEPT** or **DECLINE**.
- **Gated everywhere.** Until acceptance the server refuses to relay drafts,
  messages or history between the two accounts (403) — the UI cannot bypass
  it. On acceptance, names and colors reveal and the conversation opens.
- **Home = recent chats, no content.** The home screen lists the people you
  recently chatted with (and when) — never the messages, which dissolve
  seconds after arrival anyway.

## What to try (the 60-second demo)

1. Type: `I was thinking we could meet tomorrow` — the words are already on the
   other device as a **LIVE DRAFT** bubble with a breathing cursor.
2. Stop typing for ~1.5 s — the draft dims slightly, the cursor slows, and a
   small *paused* note appears. No "typing…" bar; the text itself is the signal.
3. Delete a few words — the other side sees them dissolve.
4. Press **SEND** — the outlined draft dries into a cyan bubble with a
   `SENT · time · vanishes` caption.
5. ~8 s after receipt the bubble dims and **dissolves seamlessly** — the page
   glides shut and the server removes it too. This is the **SEND OR
   DISAPPEAR** half of the product idea.
6. Clear the field instead (**Esc**) — the draft vanishes everywhere and was
   never stored.
7. Switch the draft control to **PRIVATE** — the other side only sees
   "@you is writing…". Switch to **OFF** — they see nothing at all.
8. Both of you can draft simultaneously — each bubble stays with its author.
9. Click the **magnifier** — search filters the conversation and highlights
   matches live. Private drafts are never searched.
10. **YOU** in the navigation edits your display name and accent — every
    connected device updates.

## Architecture

```
server.mjs               zero-dependency Node server:
                         - static files
                         - accounts API (signup/login/validate/directory/profile)
                         - conversation history API + server-side expiry sweep
                         - realtime relay: SSE down (/events) + POST up (/send)
data/                    accounts.json · sessions.json · conversations.json · conv-meta.json
src/
  main.js                bootstrap: auth gate → transport + session + renderer + UI
  users.js               accent palette + conversation-id helpers
  core/
    events.js            event taxonomy (DRAFT_STARTED/UPDATED/PAUSED/SENT/DISCARDED,
                         MESSAGE_EXPIRED, USER_JOINED/LEFT, request.*), draft
                         statuses, visibility
    auth.js              AccountStore: server-backed accounts + client-side cache
                         (sync lookups for avatars/names); exact-username lookup,
                         chat-request send/accept/decline; token per window in
                         sessionStorage — demo grade, swap for real auth in Phase 2
    model.js             LiveDraft / Message factories (schema-shaped for the future backend)
    diff.js              incremental text diff → retain/delete/insert ops
    transport.js         ServerTransport (SSE + POST, cross-device) and
                         BroadcastTransport (same-device fallback) behind one interface
    session.js           state machine: multi-conversation, applies local + remote events
                         through one reducer. History is server-owned; drafts are never
                         stored anywhere. Opening a conversation requests a draft
                         resync from the writer.
  ui/
    auth-ui.js           log in / sign up screen
    render.js            bubbles, ink-in/ink-out animations, cursor, pause state,
                         private ghost, draft→committed settle, ephemeral dissolve,
                         search filter + highlights
    app.js               composer, account chip, find-people (exact search + request
                         inbox + badge), home recents, profile panel, search,
                         visibility control, nav, toasts
    avatar.js, util.js
```

### Permission model (server-enforced)

- `data/requests.json` holds chat requests: `pending → accepted | declined`.
- Two accounts can exchange draft/message events **only** while an accepted
  request connects them — `/send` returns 403 otherwise, and so do the history
  and recents endpoints.
- `/api/users/find` performs the exact-username lookup and returns the minimum
  the relationship allows: strangers expose `{id, username}` only; accepted
  connections reveal the full profile.
- Existing conversations are grandfathered in as accepted on server boot.

### Real-time design notes

- **Incremental, not snapshot.** Every keystroke emits `DRAFT_UPDATED` carrying
  minimal character ops (`INSERT " tomorrow"`, `DELETE 8`) plus a revision
  number. Duplicates are suppressed by event id; stale revisions are dropped;
  a peer that missed a draft's start requests a `DRAFT_RESYNC` snapshot —
  opening a conversation also broadcasts one, so late joiners (on any device)
  catch a draft already in flight.
- **Local echo is synchronous.** The writer's own page and composer update in
  the same tick as the keystroke. Only remote delivery is async — typing is
  never debounced or delayed locally.
- **Events, not conversations.** No event ever carries the whole conversation;
  the protocol is draft-scoped and relayed as-is by the server.
- **Ephemeral by design.** Sent messages carry `expiresAt`; the server sweeps
  expired ones and broadcasts `message.expired`, so every device dissolves in
  step. Recency (who you last talked to) is kept without keeping content.
- **Reconnects.** EventSource reconnects automatically; tokens survive server
  restarts; missed history is refetched; missed drafts are recovered by resync.

### Privacy principles in this prototype

- A live draft is **not** a message. Discarded drafts are never written to any
  storage — they exist only in memory as events.
- A **PRIVATE** draft's text is never rendered on the other device (the words
  are dropped from that document entirely and return via snapshot when the
  writer goes LIVE).
- Passwords are salted + SHA-256 on the server; tokens are demo-grade. This is
  not real security — real auth and E2EE land in Phase 2.
- Disappearing text is a product behavior, not a security guarantee: a
  determined observer can always capture what is on their screen.

### Not in Phase 1 (by design)

Real server auth hardening, WebSocket transport, Memory, attachments, E2EE,
voice, store-and-forward delivery, multi-device session management. The
foundation above is where they plug in.

## Security hardening pass

This build moves the security boundary to the server and is no longer the original demo-grade auth/relay implementation.

- Sessions use an `HttpOnly; SameSite=Strict` cookie; bearer tokens are not returned to browser JavaScript or accepted from query strings.
- Session expiry is enforced server-side and `/api/logout` revokes the current session.
- Passwords for new accounts use Node `scrypt`; legacy salted-SHA256 accounts are migrated to `scrypt` after a successful login.
- Login and signup attempts are rate-limited.
- State-changing requests require a same-origin `Origin` check.
- There is no account directory endpoint. User discovery is exact-username lookup only.
- `/data/*` is never served as static web content.
- Realtime events are routed only to authorized conversation participants.
- Client-supplied author IDs, message authors, timestamps and ephemeral expiry values are not trusted.
- Only an explicit client-event allowlist can enter the realtime protocol.
- PRIVATE/OFF draft content is stripped before it leaves the server boundary.
- Presence is conversation-scoped rather than globally broadcast.
- Existing demo session tokens are invalidated when the hardened server starts; users must sign in again.
- `data/sessions.json` is reset and should remain untracked. Runtime JSON data should not be committed to source control.

## Verification

Run:

```bash
npm test
```

The included integration tests cover static database exposure, cookie sessions, password login, directory removal, forged-author rejection, query-token rejection, authorized realtime routing, third-party isolation, PRIVATE draft redaction, and server-controlled message expiry.

### Production follow-up

The remaining scale/security roadmap is: normalize the PostgreSQL state model, add structured schema validation, strengthen abuse controls/observability, harden reconnect/state synchronization, and introduce end-to-end encryption before positioning the service as a privacy-maximal production messenger.


## v0.4 Data Layer

LIVE now has a storage repository boundary. With no `DATABASE_URL`, the project remains runnable using the existing JSON compatibility store. When `DATABASE_URL` is supplied and the `pg` dependency is installed, LIVE initializes PostgreSQL automatically, applies migration 001, and persists the application state through a transactional repository.

### PostgreSQL

```bash
npm install
DATABASE_URL="postgres://USER:PASSWORD@HOST:5432/live" npm start
```

The first database migration creates `live_schema_migrations` and `live_state`. The current release intentionally keeps the application model behind the repository boundary so the next release can split high-volume entities into normalized tables without changing the UI or realtime contracts.

For production, do not use JSON persistence; configure PostgreSQL and set `REQUIRE_DATABASE=1` so a database outage prevents accidental fallback to local files.


## v0.5 — Normalized PostgreSQL Data Layer

LIVE now has a relational PostgreSQL persistence model instead of storing the whole application state in one JSONB document. The production schema includes:

- `live_accounts` — user identity and password verifier metadata
- `live_requests` — connection requests and status
- `live_conversations` — conversation metadata
- `live_conversation_members` — explicit membership indexes
- `live_messages` — committed message records with expiry indexes
- `live_sessions` — hashed-at-rest session records (sessions are intentionally invalidated on server restart)
- `live_conversation_meta` — conversation-level last activity
- `live_schema_migrations` — migration tracking

The repository preserves the existing application-facing state shape for now, so the UI and realtime engine do not need to change while the persistence layer evolves. Legacy `live_state` data is imported once into normalized tables when the normalized database is empty.

Set `DATABASE_URL` to enable PostgreSQL. Set `REQUIRE_DATABASE=1` in production to fail closed rather than silently falling back to JSON.

## v0.7 Reliability & State Synchronization

The realtime protocol now uses a monotonic server sequence (`seq`) and event IDs (`eid`).
Clients remember the last received sequence for the browser session and request replay after reconnect.
The server retains a bounded in-memory replay window and replays only events belonging to conversations the authenticated account can access.

WebSocket is the primary transport at `/ws`; SSE/POST remains the compatibility fallback. WebSocket clients send masked frames as required by RFC 6455. The server acknowledges accepted client events with `event.ack` and rejects malformed/unauthorized events.

This is a reliability layer, not yet a distributed event log. The replay buffer is process-local and bounded. v0.7 should move event/reconnect state into Redis or another shared realtime layer before horizontal scaling.

## v0.7 Distributed Realtime

LIVE now has a distributed event-plane abstraction. In PostgreSQL mode, realtime envelopes are persisted in `live_events`, assigned globally ordered sequence numbers, and propagated between server instances with PostgreSQL `LISTEN/NOTIFY`. Reconnect replay reads from the shared event store instead of relying only on process-local memory. JSON development mode uses an in-memory broker with the same interface.

The PostgreSQL repository also uses transactional upserts rather than truncating shared tables, preventing one server instance from deleting another instance's writes. `migrations/003_realtime_events.sql` documents the distributed event schema.

This is not yet the final million-user architecture: PostgreSQL `LISTEN/NOTIFY` is an intentional zero-extra-dependency distributed broker for this stage. A dedicated Redis/NATS-style event bus can replace the broker interface later without changing the application event contract.


## v0.8 abuse resistance and operations
- Per-account realtime quotas and active-draft caps.
- Per-account connection limits and global connection ceiling.
- Event de-duplication for retry safety.
- User blocking and abuse reporting endpoints.
- Health and readiness endpoints: `/healthz`, `/readyz`.
- Structured request IDs remain attached to API responses.
- PostgreSQL persists moderation state; JSON compatibility mode persists `blocks.json` and `reports.json`.

## v0.10 experimental E2EE with multi-device signed prekeys

Set `LIVE_E2EE=1` to enable the experimental browser-side encryption path.

- Browser/device creates a persistent P-256 ECDH identity key in IndexedDB.
- Only the public key is registered with the server.
- DM payloads derive a local AES-256-GCM key using ECDH + HKDF.
- Draft/message plaintext is not accepted by the server in E2EE mode.
- The server stores and routes opaque encrypted payloads.
- `GET /api/keys?username=...` is restricted to an accepted conversation.

This is **not yet a production cryptographic protocol**. It does not yet provide
Signal-style ratcheting/forward secrecy, device verification, prekeys,
secure multi-device key distribution, or account recovery. Those must be
specified, tested and independently reviewed before claiming full E2EE.


## v0.10 Identity & Key Management

E2EE-enabled browsers now have a stable device identifier and public-key fingerprint. The server tracks multiple device keys per account, exposes authorized device metadata, and supports explicit verification state plus key-change detection. Verification is user-controlled; encryption alone is not treated as identity proof.

## v0.11 — Multi-device E2EE foundation
- Device identity persistence is owned by the PostgreSQL migration runner.
- Devices can publish signed P-256 prekey bundles.
- Authorized contacts can retrieve bundles for session establishment.
- Browser crypto verifies signed prekeys before deriving a session key.
- This remains an experimental E2EE protocol foundation and has not received an independent cryptographic audit.


## v0.13 — Encrypted Message Transport Integration

The experimental v0.12 ratchet is now wired into the browser session transport. When E2EE is enabled, clients register/publish device bundles, establish device-targeted ratchet sessions, and send ciphertext envelopes. The server routes opaque ciphertext and never receives plaintext message content. Incoming ciphertext is queued briefly if its session-init event is still being processed. This remains an experimental cryptographic protocol and is not a production Signal/Double Ratchet implementation or independently audited.

## v0.14 — Key Transparency Prototype

v0.14 adds an experimental key-transparency layer for device identity changes. LIVE now maintains an append-only per-account hash chain of device registration, key rotation, and verification events. The current root is signed by a server ECDSA P-256 transparency key and exposed only to authorized conversation contacts.

Clients verify the chain and signature, pin the observed root locally, and detect history forks, rewrites, signing-key changes, and unexpected root advancement. This provides change detection and a foundation for stronger external consistency witnesses.

This is **not** a production transparency system yet. A malicious server that controls the initial trust state can still establish a false view. A production design needs independently verifiable witnesses/consistency proofs, secure server-key provisioning, formal protocol specification, recovery semantics, and independent cryptographic review.
