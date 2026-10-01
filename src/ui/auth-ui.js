/* AuthUI — log in / sign up gate. Calls onReady(account) once authenticated.
   Auto-logs-in when this device still has a current account. */

export class AuthUI {
  constructor(accounts, onReady) {
    this.accounts = accounts;
    this.onReady = onReady;
    this.mode = 'login';
  }

  mount() {
    this.overlay = document.querySelector('#authOverlay');
    this.tabIn = document.querySelector('#authTabIn');
    this.tabUp = document.querySelector('#authTabUp');
    this.username = document.querySelector('#authUsername');
    this.nameField = document.querySelector('#authNameField');
    this.name = document.querySelector('#authName');
    this.password = document.querySelector('#authPassword');
    this.error = document.querySelector('#authError');
    this.submit = document.querySelector('#authSubmit');

    this.tabIn.addEventListener('click', () => this._setMode('login'));
    this.tabUp.addEventListener('click', () => this._setMode('signup'));
    this.submit.addEventListener('click', () => this._submit());
    this.overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._submit();
    });

    const current = this.accounts.getCurrent();
    if (current?.account) {
      this.overlay.hidden = true;
      this.onReady(current.account);
      return;
    }
    this.overlay.hidden = false;
    this._setMode('login');
    this.username.focus();
  }

  _setMode(mode) {
    this.mode = mode;
    this.tabIn.classList.toggle('is-active', mode === 'login');
    this.tabUp.classList.toggle('is-active', mode === 'signup');
    this.nameField.hidden = mode === 'login';
    this.submit.textContent = mode === 'login' ? 'LOG IN' : 'CREATE ACCOUNT';
    this.error.textContent = '';
  }

  async _submit() {
    this.error.textContent = '';
    this.submit.disabled = true;
    try {
      const account = this.mode === 'signup'
        ? await this.accounts.signup({
            username: this.username.value,
            name: this.name.value,
            password: this.password.value,
          })
        : await this.accounts.login({
            username: this.username.value,
            password: this.password.value,
          });
      /* the store already saved the per-window session (token + account) */
      this.overlay.hidden = true;
      this.onReady(account);
    } catch (err) {
      this.error.textContent = err?.message ?? 'Something went wrong.';
      this.submit.disabled = false;
      return;
    }
    this.submit.disabled = false;
  }
}
