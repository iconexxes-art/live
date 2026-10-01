/* LIVE — Phase 1 prototype bootstrap.
   Auth gate first, then the realtime stack backed by the LIVE server:
   accounts, conversation history and event relay live server-side, so
   different devices (and different browsers) share one live conversation.
   Swap ServerTransport for a WebSocket transport in Phase 2 — same envelope
   shape, same session, same UI. */

import { AccountStore } from './core/auth.js';
import { ServerTransport } from './core/transport.js';
import { LiveSession } from './core/session.js';
import { PageRenderer } from './ui/render.js';
import { AppUI } from './ui/app.js';
import { AuthUI } from './ui/auth-ui.js';

const accounts = new AccountStore();
let booted = false;

function startApp(account) {
  if (booted) return;
  booted = true;

  const transport = new ServerTransport();
  const session = new LiveSession({ transport, users: accounts });
  const renderer = new PageRenderer(document.getElementById('entries'), session);
  const app = new AppUI(session, renderer, accounts);
  app.mount();
  window.__LIVE = { session, renderer, accounts, app };

  /* one tap for every wire event: account + request broadcasts update the
     local caches/UI; everything else flows through the session reducer */
  transport.onEvent((env) => {
    accounts.applyServerEvent(env);
    app.onWireEvent(env);
    session._onRemote(env);
  });

  /* Server validates the HttpOnly session cookie before wiring live. */
  accounts.validate().then((valid) => {
    if (!valid) {
      accounts.clearCurrent();
      location.reload();
      return;
    }
    session.setIdentity(valid);
    session.start();
    accounts.refresh()
      .then(() => app.onAccountsRefreshed())
      .catch(() => { /* offline — snapshots still cover names */ });
  });
}

const auth = new AuthUI(accounts, startApp);
auth.mount();
