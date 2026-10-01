/* Procedural duotone avatars — no image assets, no external identities. */

export function avatarEl(user, size = 24) {
  const el = document.createElement('span');
  el.className = 'avatar';
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML =
    `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" role="img">
       <rect x="0.5" y="0.5" width="39" height="39" rx="13" fill="${user.bg}"/>
       <rect x="0.5" y="0.5" width="39" height="39" rx="13" fill="none" stroke="${user.ring}"/>
       <circle cx="31" cy="9" r="7" fill="${user.fg}" opacity="0.12"/>
       <text x="20" y="26" text-anchor="middle" font-family="inherit"
             font-size="17" font-weight="700" fill="${user.fg}">${user.initial}</text>
     </svg>`;
  return el;
}
