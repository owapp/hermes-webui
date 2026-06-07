(function(){
  'use strict';

  if (window.__hermesLayerBridge) return;
  window.__hermesLayerBridge = true;

  var originalFetch = window.fetch && window.fetch.bind(window);
  var OriginalEventSource = window.EventSource;

  function readCookie(name){
    try {
      var parts = document.cookie.split(';');
      for (var i = 0; i < parts.length; i += 1) {
        var part = parts[i].trim();
        var eq = part.indexOf('=');
        if (eq < 0) continue;
        if (part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
      }
    } catch (_) {}
    return '';
  }

  function currentAgentBase(){
    return document.baseURI || location.href;
  }

  function sameOriginUrl(raw){
    try {
      var url = new URL(raw, location.href);
      return url.origin === location.origin ? url : null;
    } catch (_) {
      return null;
    }
  }

  function shouldRouteThroughAgent(url){
    return /^\/api(?:\/|$)/.test(url.pathname)
      || url.pathname === '/health'
      || /^\/stream(?:\/|$)/.test(url.pathname);
  }

  function agentScopedUrl(input){
    var raw = '';
    if (typeof input === 'string') raw = input;
    else if (input instanceof URL) raw = input.href;
    else if (input && typeof input.url === 'string') raw = input.url;
    else return null;

    var url = sameOriginUrl(raw);
    if (!url || !shouldRouteThroughAgent(url)) return null;

    var rel = url.pathname.replace(/^\/+/, '') + url.search + url.hash;
    return new URL(rel, currentAgentBase()).href;
  }

  function unsafe(method){
    return /^(POST|PUT|PATCH|DELETE)$/i.test(method || 'GET');
  }

  function addLayerCsrf(input, init){
    var opts = init ? Object.assign({}, init) : {};
    var method = (opts.method || (input && input.method) || 'GET').toUpperCase();
    if (!unsafe(method)) return opts;

    var token = readCookie('hl_csrf');
    if (!token) return opts;

    var headers = new Headers(opts.headers !== undefined ? opts.headers : ((input && input.headers) || {}));
    if (!headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', token);
    opts.headers = headers;
    return opts;
  }

  if (originalFetch) {
    window.fetch = function(input, init){
      var scoped = agentScopedUrl(input);
      var nextInput = scoped || input;
      var opts = addLayerCsrf(nextInput, init);
      return originalFetch(nextInput, opts);
    };

    if (navigator.sendBeacon) {
      var originalBeacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function(url, data){
        try {
          var scoped = agentScopedUrl(url);
          var target = scoped || url;
          var token = readCookie('hl_csrf');
          if (token) {
            var headers = {'X-CSRF-Token': token};
            if (data && data.type) headers['Content-Type'] = data.type;
            originalFetch(target, {
              method: 'POST',
              credentials: 'include',
              headers: headers,
              body: data,
              keepalive: true
            });
            return true;
          }
        } catch (_) {}
        return originalBeacon(url, data);
      };
    }
  }

  if (OriginalEventSource) {
    window.EventSource = function(url, eventSourceInitDict){
      return new OriginalEventSource(agentScopedUrl(url) || url, eventSourceInitDict);
    };
    window.EventSource.prototype = OriginalEventSource.prototype;
  }

  function escapeHtml(value){
    return String(value || '').replace(/[&<>"']/g, function(char){
      return ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[char] || char;
    });
  }

  function sessionUrl(){
    return new URL('api/hermes-layer/session', currentAgentBase()).href;
  }

  function controlPlaneUrl(path){
    try {
      return new URL(path, location.origin).href;
    } catch (_) {
      return path;
    }
  }

  function setOpen(root, open){
    var menu = root.querySelector('[data-hl-account-menu]');
    var button = root.querySelector('[data-hl-account-button]');
    if (!menu || !button) return;
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  }

  function renderAccountMenu(root, payload){
    var account = payload && payload.account ? payload.account : {};
    var links = payload && Array.isArray(payload.links) ? payload.links : [];
    var initials = account.initials || 'U';
    var name = account.name || account.email || 'Account';
    var email = account.email || '';
    var linkMarkup = links.map(function(link){
      return '<a class="hl-account-link" href="' + escapeHtml(link.href) + '" role="menuitem">' + escapeHtml(link.label) + '</a>';
    }).join('');

    root.hidden = false;
    root.innerHTML =
      '<button class="hl-account-avatar" type="button" data-hl-account-button aria-haspopup="menu" aria-expanded="false" aria-label="Account menu">' + escapeHtml(initials) + '</button>' +
      '<div class="hl-account-menu" data-hl-account-menu hidden role="menu" aria-label="Account">' +
        '<div class="hl-account-profile">' +
          '<div class="hl-account-name">' + escapeHtml(name) + '</div>' +
          '<div class="hl-account-email">' + escapeHtml(email) + '</div>' +
        '</div>' +
        '<div class="hl-account-separator"></div>' +
        linkMarkup +
        '<div class="hl-account-separator"></div>' +
        '<button class="hl-account-logout" type="button" data-hl-account-logout role="menuitem">Log out</button>' +
      '</div>';

    var button = root.querySelector('[data-hl-account-button]');
    var logout = root.querySelector('[data-hl-account-logout]');
    if (button) {
      button.addEventListener('click', function(event){
        event.stopPropagation();
        var menu = root.querySelector('[data-hl-account-menu]');
        setOpen(root, !!(menu && menu.hidden));
      });
    }
    if (logout && originalFetch) {
      logout.addEventListener('click', function(){
        var token = readCookie('hl_csrf');
        originalFetch(controlPlaneUrl('/api/auth/logout'), {
          method: 'POST',
          credentials: 'include',
          headers: token ? {'X-CSRF-Token': token} : {}
        }).finally(function(){
          window.location.assign(controlPlaneUrl('/'));
        });
      });
    }
  }

  function initAccountMenu(){
    var root = document.getElementById('hermes-layer-account');
    if (!root) {
      console.error('Hermes Layer account integration anchor missing. Review the pinned WebUI update.');
      return;
    }
    if (!originalFetch) return;
    originalFetch(sessionUrl(), { credentials: 'include' })
      .then(function(response){ return response.ok ? response.json() : null; })
      .then(function(payload){
        if (payload) renderAccountMenu(root, payload);
      })
      .catch(function(error){
        console.error('Hermes Layer account session failed', error);
      });
  }

  document.addEventListener('click', function(event){
    var root = document.getElementById('hermes-layer-account');
    if (root && !root.contains(event.target)) setOpen(root, false);
  });

  document.addEventListener('keydown', function(event){
    if (event.key === 'Escape') {
      var root = document.getElementById('hermes-layer-account');
      if (root) setOpen(root, false);
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAccountMenu, { once: true });
  } else {
    initAccountMenu();
  }
})();
