/**
 * server/routes/oidc.js — public OIDC endpoints.
 *
 * Mounted at /api/auth/oidc. CSRF middleware skips /api/auth/* so the
 * IdP redirect to /callback doesn't get blocked.
 */
import { Router } from 'express';
import { wrap } from '../logger.js';
import { logger } from '../logger.js';
import { signToken, sessionMaxAge, requireAuth, userMgmtActive } from '../middleware/auth.js';
import {
  listProviders, publicProvider, getProvider, getClient,
  generateAuthChecks, persistState, consumeState,
  resolveUser, applyAdminMapping, linkUser, unlinkUser, listUserLinks,
  isPasswordLoginEnabled,
} from '../lib/oidc.js';
import db from '../db.js';

const router = Router();

const _insecureCookies = process.env.INSECURE_COOKIES === '1' || process.env.INSECURE_COOKIES === 'true';
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  maxAge:   30 * 24 * 60 * 60 * 1000,
  secure:   !_insecureCookies,
};
const LOGOUT_COOKIE = 'nt_oidc_logout';

/** Choose a redirect URI for this provider that matches one of the configured ones. */
function _resolveRedirectUri(provider, req) {
  let configured = [];
  try { configured = JSON.parse(provider.redirect_uris || '[]'); } catch {}
  if (!configured.length) return null;
  // Prefer the one that matches the current request host; else fall back to first.
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const expectedOrigin = `${proto}://${host}`;
  const match = configured.find(u => typeof u === 'string' && u.startsWith(expectedOrigin));
  return match || configured[0];
}

/**
 * GET /api/auth/oidc/providers
 * Public — returns active providers + the password-login flag so the Login
 * page knows whether to render SSO buttons + the password form.
 */
router.get('/providers', wrap((req, res) => {
  const providers = listProviders({ activeOnly: true }).map(publicProvider);
  res.json({
    providers,
    enable_email_password_login: isPasswordLoginEnabled(),
  });
}));

/**
 * GET /api/auth/oidc/login/:providerId
 * Generates PKCE+state+nonce, persists, redirects to IdP.
 * Optional ?return=<hash-path> preserves the post-login destination.
 * Optional ?link=1 (only when authenticated) starts the link-via-Profile flow.
 */
router.get('/login/:providerId', wrap(async (req, res) => {
  const provider = getProvider(req.params.providerId);
  if (!provider || !provider.is_active) return res.status(404).send('Provider not found');

  const redirectUri = _resolveRedirectUri(provider, req);
  if (!redirectUri) return res.status(500).send('Provider has no redirect_uris configured');

  let client;
  try { client = await getClient(provider.id); }
  catch (e) {
    logger.warn(`[oidc] discovery failed for provider ${provider.id}: ${e?.message || e}`);
    return res.status(502).send('Could not reach identity provider');
  }

  const checks = generateAuthChecks();
  const linkMode = req.query.link === '1' && !!req.user;
  const isMobile = req.query.mobile === '1';
  const returnPath = typeof req.query.return === 'string' ? req.query.return.slice(0, 256) : '';
  persistState({
    providerId: provider.id,
    redirectUri,
    returnPath: linkMode ? (returnPath || '/profile') : returnPath,
    codeVerifier: checks.codeVerifier,
    state: checks.state,
    nonce: checks.nonce,
    mobile: isMobile,
    linkUserId: linkMode ? req.user.id : null,
  });

  const url = client.authorizationUrl({
    redirect_uri: redirectUri,
    scope: provider.scope,
    state: checks.state,
    nonce: checks.nonce,
    code_challenge: checks.codeChallenge,
    code_challenge_method: 'S256',
  });
  res.redirect(url);
}));

/**
 * GET /api/auth/oidc/callback/:providerId
 * Validates state/nonce, exchanges code for tokens, mints nt_token, redirects.
 */
router.get('/callback/:providerId', wrap(async (req, res) => {
  const provider = getProvider(req.params.providerId);
  if (!provider) return res.status(404).send('Provider not found');

  const params = new URLSearchParams(req.url.split('?')[1] || '');
  const state = params.get('state');
  if (!state) return res.status(400).send('Missing state');

  const stored = consumeState(state);
  if (!stored) return res.status(400).send('Invalid or expired state');
  if (Number(stored.providerId) !== Number(provider.id)) {
    return res.status(400).send('State / provider mismatch');
  }

  let tokenSet, claims;
  try {
    const client = await getClient(provider.id);
    const callbackParams = client.callbackParams(req);
    tokenSet = await client.callback(stored.redirectUri, callbackParams, {
      state,
      nonce: stored.nonce,
      code_verifier: stored.codeVerifier,
    });
    claims = tokenSet.claims();
  } catch (e) {
    logger.warn(`[oidc] callback failed for provider ${provider.id}: ${e?.message || e}`);
    if (stored.mobile) return res.redirect(`nutritrace://oidc-callback/?error=callback_failed`);
    return _redirectToLogin(res, stored.returnPath, 'callback_failed');
  }

  // Branch: link flow (existing user) vs login flow
  if (stored.linkUserId) {
    try {
      linkUser(stored.linkUserId, provider.id, claims.sub, !!claims.email_verified);
    } catch (e) {
      const msg = encodeURIComponent(e?.message || 'link_failed');
      if (stored.mobile) return res.redirect(`nutritrace://oidc-callback/?error=${msg}`);
      return _redirectToLogin(res, stored.returnPath, msg);
    }
    if (stored.mobile) return res.redirect(`nutritrace://oidc-callback/?linked=1`);
    return _redirectToLogin(res, stored.returnPath, null, 'linked');
  }

  let result;
  try {
    result = resolveUser(provider, claims);
  } catch (e) {
    logger.info(`[oidc] resolveUser rejected for sub=${claims.sub}: ${e.message}`);
    const msg = encodeURIComponent(e.message);
    if (stored.mobile) return res.redirect(`nutritrace://oidc-callback/?error=${msg}`);
    return _redirectToLogin(res, stored.returnPath, msg);
  }
  applyAdminMapping(provider, result.user, claims);

  // First-user bootstrap: claim orphaned data (mirrors password /register).
  if (result.created && db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n === 1) {
    db.prepare('UPDATE foods SET user_id = ? WHERE user_id IS NULL').run(result.user.id);
    db.prepare('UPDATE meals SET user_id = ? WHERE user_id IS NULL').run(result.user.id);
    db.prepare('UPDATE diary SET user_id = ? WHERE user_id IS NULL').run(result.user.id);
    db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(result.user.id);
    result.user.role = 'admin';
    logger.info(`[oidc] first-user OIDC bootstrap: ${result.user.username} → admin`);
  }

  // Mint identical nt_token to password path
  const token = signToken(result.user);
  if (stored.mobile) {
    // Native (Capacitor) flow — Bearer token cannot be set as a cookie that
    // crosses back into the WebView. Hand the token off to the app via a
    // custom-scheme deep link; the in-app browser closes when the URL fires
    // and Android routes the launch intent to NutriTrace's appUrlOpen
    // listener (see src/App.svelte). id_token_hint + provider_id ride
    // along so the app can persist them locally for RP-initiated logout
    // later — the cookie-based path used by PWA doesn't reach the WebView's
    // separate cookie jar, so the client has to remember these itself.
    let deepLink = `nutritrace://oidc-callback/?token=${encodeURIComponent(token)}`;
    if (tokenSet?.id_token) {
      deepLink += `&id_token_hint=${encodeURIComponent(tokenSet.id_token)}`;
      deepLink += `&provider_id=${encodeURIComponent(provider.id)}`;
    }
    return res.redirect(deepLink);
  }
  res.cookie('nt_token', token, { ...COOKIE_OPTS, maxAge: sessionMaxAge() });
  // Save enough OIDC session context for RP-initiated logout later.
  if (tokenSet?.id_token) {
    res.cookie(LOGOUT_COOKIE, JSON.stringify({ providerId: provider.id, idTokenHint: tokenSet.id_token }), {
      ...COOKIE_OPTS,
      maxAge: sessionMaxAge(),
    });
  } else {
    res.clearCookie(LOGOUT_COOKIE);
  }
  return _redirectToLogin(res, stored.returnPath, null, 'ok');
}));

function _redirectToLogin(res, returnPath, error, ok) {
  const basePath = (process.env.BASE_URL || '').replace(/\/$/, '');
  let dest = `${basePath}/`;
  // Always come back through the SPA root + hash so svelte-spa-router can route.
  let hash = returnPath || '/';
  if (!hash.startsWith('/')) hash = '/' + hash;
  let qs = '';
  if (error) qs = `?oidc_error=${error}`;
  else if (ok) qs = `?oidc=${ok}`;
  res.redirect(`${dest}#${hash}${qs}`);
}

/**
 * POST /api/auth/oidc/logout
 * Best-effort RP-initiated logout. Always clears the local cookie; tries to
 * redirect to the IdP's end_session_endpoint when available.
 */
router.post('/logout', wrap(async (req, res) => {
  const raw = req.cookies?.[LOGOUT_COOKIE];
  res.clearCookie('nt_token');
  res.clearCookie(LOGOUT_COOKIE);

  // Native clients can't reach the LOGOUT_COOKIE jar set in the Custom Tabs
  // browser, so they POST the same id_token_hint + providerId they were
  // handed at login time. Body wins when present; otherwise fall back to
  // the cookie (PWA path).
  let saved = null;
  if (req.body?.idTokenHint && req.body?.providerId) {
    saved = { idTokenHint: String(req.body.idTokenHint), providerId: req.body.providerId };
  } else if (raw) {
    try { saved = JSON.parse(raw); } catch {}
  }
  if (!saved?.providerId) return res.json({ ok: true });

  const provider = getProvider(saved.providerId);
  if (!provider || !provider.is_active) return res.json({ ok: true });

  try {
    const client = await getClient(provider.id);
    const endSessionEndpoint = client.issuer?.metadata?.end_session_endpoint;
    if (!endSessionEndpoint) return res.json({ ok: true });

    // Mobile (Capacitor) returns to the app via the same deep-link scheme
    // used by the OIDC login callback. The user must register
    // `nutritrace://oidc-callback` as a Post Logout Redirect URI at the IdP
    // (alongside the equivalent HTTPS root URL for PWA). The IdP redirects
    // to this URI after destroying the session; App.svelte's appUrlOpen
    // listener catches the deep link and closes the Capacitor browser.
    const isMobile = req.query?.mobile === '1' || req.query?.mobile === 'true';
    let postLogoutRedirectUri;
    if (isMobile) {
      postLogoutRedirectUri = 'nutritrace://oidc-callback';
    } else {
      const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
      const host = req.headers['x-forwarded-host'] || req.get('host');
      const basePath = (process.env.BASE_URL || '').replace(/\/$/, '');
      postLogoutRedirectUri = `${proto}://${host}${basePath}/`;
    }

    const logoutUrl = new URL(endSessionEndpoint);
    logoutUrl.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
    if (saved.idTokenHint) logoutUrl.searchParams.set('id_token_hint', saved.idTokenHint);

    return res.json({ ok: true, logoutUrl: logoutUrl.toString() });
  } catch (e) {
    logger.warn(`[oidc] logout failed for provider ${saved.providerId}: ${e?.message || e}`);
    return res.json({ ok: true });
  }
}));

/**
 * POST /api/auth/oidc/unlink/:linkId  (authenticated user only)
 * Removes a user_oidc_links row. Refuses to strand a user.
 */
router.post('/unlink/:linkId', requireAuth, wrap((req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  try {
    unlinkUser(req.user.id, Number(req.params.linkId));
    res.json({ ok: true, links: listUserLinks(req.user.id) });
  } catch (e) {
    res.status(400).json({ error: e?.message || 'Unlink failed' });
  }
}));

/**
 * GET /api/auth/oidc/links  (authenticated user only)
 * List the linked providers for the Profile page.
 */
router.get('/links', requireAuth, wrap((req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ links: listUserLinks(req.user.id) });
}));

export default router;
