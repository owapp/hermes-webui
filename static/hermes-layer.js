(function(){
  'use strict';

  if (window.__hermesLayerBridge) return;
  window.__hermesLayerBridge = true;
  window.__hermesLayerHosted = true;

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

  function isAgentGatewayUrl(url){
    return /^\/agent\/[^/]+\/api(?:\/|$)/.test(url.pathname)
      || /^\/agent\/[^/]+\/stream(?:\/|$)/.test(url.pathname)
      || /^\/agent\/[^/]+\/health$/.test(url.pathname);
  }

  function fetchInputUrl(input){
    var raw = '';
    if (typeof input === 'string') raw = input;
    else if (input instanceof URL) raw = input.href;
    else if (input && typeof input.url === 'string') raw = input.url;
    else return null;
    return sameOriginUrl(raw);
  }

  function agentScopedUrl(input){
    var url = fetchInputUrl(input);
    if (!url || !shouldRouteThroughAgent(url)) return null;

    var rel = url.pathname.replace(/^\/+/, '') + url.search + url.hash;
    return new URL(rel, currentAgentBase()).href;
  }

  function alreadyScopedToAgent(input){
    var url = fetchInputUrl(input);
    return !!(url && isAgentGatewayUrl(url));
  }

  function unsafe(method){
    return /^(POST|PUT|PATCH|DELETE)$/i.test(method || 'GET');
  }

  function requestInitFromFetchInput(input, init){
    var opts = {};
    if (typeof Request !== 'undefined' && input instanceof Request) {
      opts = {
        method: input.method,
        headers: input.headers,
        credentials: input.credentials,
        cache: input.cache,
        redirect: input.redirect,
        referrer: input.referrer,
        integrity: input.integrity,
        keepalive: input.keepalive,
        signal: input.signal
      };
      if (!/^(GET|HEAD)$/i.test(input.method)) {
        opts.body = input.clone().body;
      }
    }
    return init ? Object.assign(opts, init) : opts;
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
      var opts = requestInitFromFetchInput(input, init);
      if (scoped) return originalFetch(scoped, addLayerCsrf(input, opts));
      if (alreadyScopedToAgent(input)) return originalFetch(input, addLayerCsrf(input, opts));
      return originalFetch(input, init);
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
        return originalBeacon(scoped || url, data);
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

  function agentApiUrl(path){
    return new URL(path.replace(/^\/+/, ''), currentAgentBase()).href;
  }

  function agentApiJson(path, init){
    if (!originalFetch) return Promise.reject(new Error('Fetch unavailable.'));
    var opts = addLayerCsrf(path, init || {});
    opts.credentials = 'include';
    if (shouldSetJsonContentType(opts.body)) {
      var headers = new Headers(opts.headers || {});
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
      opts.headers = headers;
    }
    return originalFetch(agentApiUrl(path), opts).then(function(response){
      return response.text().then(function(text){
        var data = text ? JSON.parse(text) : null;
        if (!response.ok) {
          throw new Error((data && (data.message || data.error)) || ('HTTP ' + response.status));
        }
        return data;
      });
    });
  }

  function shouldSetJsonContentType(body){
    if (!body) return false;
    if (typeof FormData !== 'undefined' && body instanceof FormData) return false;
    if (typeof Blob !== 'undefined' && body instanceof Blob) return false;
    if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return false;
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(body)) return false;
    return true;
  }

  function formatNumber(value){
    var number = Number(value || 0);
    try { return new Intl.NumberFormat('en-US').format(number); } catch (_) { return String(number); }
  }

  function formatPercent(value){
    var number = Number(value || 0);
    try { return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(number) + '%'; } catch (_) { return String(number) + '%'; }
  }

  function formatBytes(value){
    var bytes = Number(value || 0);
    if (!bytes) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var index = 0;
    while (bytes >= 1024 && index < units.length - 1) {
      bytes = bytes / 1024;
      index += 1;
    }
    return (index === 0 ? String(bytes) : bytes.toFixed(bytes >= 10 ? 1 : 2)) + ' ' + units[index];
  }

  function formatDate(value){
    if (!value) return '-';
    try { return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); } catch (_) { return String(value); }
  }

  function metric(label, value){
    return '<div class="hl-surface-metric"><div class="hl-surface-label">' + escapeHtml(label) + '</div><div class="hl-surface-value">' + escapeHtml(value) + '</div></div>';
  }

  function statusItem(label, value, ok){
    return '<div class="hl-surface-status-item"><span>' + escapeHtml(label) + '</span><strong class="' + (ok ? 'is-ok' : 'is-warn') + '">' + escapeHtml(value) + '</strong></div>';
  }

  function ensureSurfaceRoot(){
    var root = document.getElementById('hermes-layer-surface-root');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'hermes-layer-surface-root';
    document.body.appendChild(root);
    return root;
  }

  function closeSurface(){
    var root = document.getElementById('hermes-layer-surface-root');
    if (root) root.innerHTML = '';
  }

  function surfaceShell(title, subtitle, body, busy){
    var root = ensureSurfaceRoot();
    root.innerHTML =
      '<div class="hl-surface-backdrop" data-hl-surface-close></div>' +
      '<section class="hl-surface" role="dialog" aria-modal="true" aria-label="' + escapeHtml(title) + '">' +
        '<header class="hl-surface-head">' +
          '<div><h2>' + escapeHtml(title) + '</h2><p>' + escapeHtml(subtitle) + '</p></div>' +
          '<button class="hl-surface-close" type="button" data-hl-surface-close aria-label="Close">x</button>' +
        '</header>' +
        (busy ? '<div class="hl-surface-progress"></div>' : '') +
        '<div class="hl-surface-body">' + body + '</div>' +
      '</section>';
    root.querySelectorAll('[data-hl-surface-close]').forEach(function(button){
      button.addEventListener('click', closeSurface);
    });
    return root;
  }

  function openOptimizationSurface(){
    surfaceShell(
      'Context Optimization',
      'Headroom runs inside this isolated workspace and reports redacted aggregate metrics.',
      '<div class="hl-surface-muted">Loading...</div>',
      true
    );
    Promise.all([
      agentApiJson('api/hermes-layer/headroom'),
      agentApiJson('api/hermes-layer/headroom/stats')
    ]).then(function(results){
      renderOptimizationSurface(results[0].headroom, results[1].stats, false);
    }).catch(function(error){
      surfaceShell(
        'Context Optimization',
        'Headroom runs inside this isolated workspace and reports redacted aggregate metrics.',
        '<div class="hl-surface-alert">' + escapeHtml(error.message || 'Context optimization failed.') + '</div>',
        false
      );
    });
  }

  function openBackupsSurface(){
    surfaceShell(
      'Backups',
      'Full workspace backups include Hermes/WebUI data, Headroom data, manifest and checksums.',
      '<div class="hl-surface-muted">Loading...</div>',
      true
    );
    agentApiJson('api/hermes-layer/backups').then(function(result){
      renderBackupsSurface(result.backups || [], false, '');
    }).catch(function(error){
      surfaceShell(
        'Backups',
        'Full workspace backups include Hermes/WebUI data, Headroom data, manifest and checksums.',
        '<div class="hl-surface-alert">' + escapeHtml(error.message || 'Backups failed.') + '</div>',
        false
      );
    });
  }

  function openWorkspaceSurface(message){
    surfaceShell(
      'Agent status',
      'Control your hosted Hermes Agent through Hermes Layer.',
      '<div class="hl-surface-muted">Loading...</div>',
      true
    );
    agentApiJson('api/hermes-layer/workspace').then(function(result){
      renderWorkspaceSurface(result.workspace || {}, false, message || '');
    }).catch(function(error){
      surfaceShell(
        'Agent status',
        'Control your hosted Hermes Agent through Hermes Layer.',
        '<div class="hl-surface-alert">' + escapeHtml(error.message || 'Agent status failed.') + '</div>',
        false
      );
    });
  }

  function openSupportSurface(){
    surfaceShell(
      'Support',
      'Send a support request without leaving your Hermes Agent workspace.',
      '<div class="hl-surface-muted">Loading...</div>',
      true
    );
    agentApiJson('api/hermes-layer/support/tickets').then(function(result){
      renderSupportSurface(result.tickets || [], false, '');
    }).catch(function(error){
      surfaceShell(
        'Support',
        'Send a support request without leaving your Hermes Agent workspace.',
        '<div class="hl-surface-alert">' + escapeHtml(error.message || 'Support failed.') + '</div>',
        false
      );
    });
  }

  function openAccountSurface(message){
    surfaceShell(
      'Account',
      'Manage your Hermes Layer account without leaving your agent workspace.',
      '<div class="hl-surface-muted">Loading...</div>',
      true
    );
    agentApiJson('api/hermes-layer/account').then(function(result){
      renderAccountSurface(result.user || {}, result.subscription || null, false, message || '');
    }).catch(function(error){
      surfaceShell(
        'Account',
        'Manage your Hermes Layer account without leaving your agent workspace.',
        '<div class="hl-surface-alert">' + escapeHtml(error.message || 'Account failed.') + '</div>',
        false
      );
    });
  }

  function openBillingSurface(message){
    surfaceShell(
      'Billing',
      'Manage your Hermes Layer subscription through Stripe Checkout and Customer Portal.',
      '<div class="hl-surface-muted">Loading...</div>',
      true
    );
    Promise.all([
      agentApiJson('api/hermes-layer/billing/config'),
      agentApiJson('api/hermes-layer/billing/state')
    ]).then(function(results){
      renderBillingSurface(results[0] || {}, results[1] || {}, false, message || '');
    }).catch(function(error){
      surfaceShell(
        'Billing',
        'Manage your Hermes Layer subscription through Stripe Checkout and Customer Portal.',
        '<div class="hl-surface-alert">' + escapeHtml(error.message || 'Billing failed.') + '</div>',
        false
      );
    });
  }

  function renderWorkspaceSurface(workspace, busy, message){
    workspace = workspace || {};
    var state = workspace.state || 'unknown';
    var health = workspace.healthStatus || 'unknown';
    var isRunning = state === 'running';
    var isStopped = state === 'stopped';
    var isSuspended = state === 'suspended';
    var isBusyState = ['provisioning', 'restarting', 'backing_up', 'restoring', 'updating', 'deleting'].indexOf(state) >= 0;
    var canStart = isStopped || isSuspended || state === 'failed';
    var canStop = isRunning || state === 'failed';
    var canRestart = isRunning || health === 'unhealthy';
    var canRecover = state === 'failed' || health === 'unhealthy';
    var primaryAction = canStart ? 'start' : canRecover ? 'recover' : canRestart ? 'restart' : '';
    var body =
      (message ? '<div class="hl-surface-alert">' + escapeHtml(message) + '</div>' : '') +
      '<div class="hl-surface-row">' +
        '<div><h3>Your Hermes Agent</h3><p>These actions are mediated by Hermes Layer and audited by the control plane.</p></div>' +
        '<button class="hl-surface-button" type="button" data-hl-refresh-workspace ' + (busy ? 'disabled' : '') + '>Refresh</button>' +
      '</div>' +
      '<div class="hl-surface-status-grid">' +
        statusItem('Agent service', state, ['running', 'stopped'].indexOf(state) >= 0) +
        statusItem('Health', health, health === 'healthy' || state === 'stopped') +
        statusItem('Billing access', 'active', true) +
        statusItem('Control plane', 'managed', true) +
      '</div>' +
      (workspace.errorMessage ? '<div class="hl-surface-alert">' + escapeHtml(workspace.errorMessage) + '</div>' : '') +
      '<div class="hl-surface-metrics">' +
        metric('Name', workspace.name || 'Hermes Agent') +
        metric('Last check', formatDate(workspace.lastHealthCheckAt)) +
        metric('Updated', formatDate(workspace.updatedAt)) +
        metric('Created', formatDate(workspace.createdAt)) +
      '</div>' +
      '<div class="hl-action-grid">' +
        '<button class="hl-surface-button ' + (primaryAction === 'start' ? 'is-primary' : '') + '" type="button" data-hl-workspace-action="start" ' + (busy || isBusyState || !canStart ? 'disabled' : '') + '>Start agent</button>' +
        '<button class="hl-surface-button ' + (primaryAction === 'restart' ? 'is-primary' : '') + '" type="button" data-hl-workspace-action="restart" ' + (busy || isBusyState || !canRestart ? 'disabled' : '') + '>Restart agent</button>' +
        '<button class="hl-surface-button ' + (primaryAction === 'recover' ? 'is-primary' : '') + '" type="button" data-hl-workspace-action="recover" ' + (busy || isBusyState || !canRecover ? 'disabled' : '') + '>Recover agent</button>' +
        '<button class="hl-surface-button" type="button" data-hl-workspace-action="stop" ' + (busy || isBusyState || !canStop ? 'disabled' : '') + '>Stop agent</button>' +
      '</div>';
    var root = surfaceShell(
      'Agent status',
      'Control your hosted Hermes Agent through Hermes Layer.',
      body,
      busy
    );
    var refresh = root.querySelector('[data-hl-refresh-workspace]');
    if (refresh) {
      refresh.addEventListener('click', function(){
        openWorkspaceSurface();
      });
    }
    root.querySelectorAll('[data-hl-workspace-action]').forEach(function(button){
      button.addEventListener('click', function(){
        var action = button.getAttribute('data-hl-workspace-action') || '';
        if (!action) return;
        if (action === 'stop' && !window.confirm('Stop this hosted Hermes Agent? Scheduled jobs and chat will pause until it is started again.')) return;
        renderWorkspaceSurface(workspace, true, action === 'recover' ? 'Recovering agent...' : action.charAt(0).toUpperCase() + action.slice(1) + ' requested...');
        agentApiJson('api/hermes-layer/workspace/action', {
          method: 'POST',
          body: JSON.stringify({ action: action })
        }).then(function(result){
          renderWorkspaceSurface(result.workspace || workspace, false, 'Agent ' + (result.appliedAction || action) + ' completed.');
        }).catch(function(error){
          renderWorkspaceSurface(workspace, false, error.message || 'Agent action failed.');
        });
      });
    });
  }

  function renderAccountSurface(user, subscription, busy, message){
    var body =
      (message ? '<div class="hl-surface-alert">' + escapeHtml(message) + '</div>' : '') +
      '<div class="hl-surface-metrics">' +
        metric('Email', user.email || '-') +
        metric('Role', user.role || 'user') +
        metric('Plan', (subscription && subscription.planKey) || 'none') +
        metric('Status', (subscription && subscription.status) || 'none') +
      '</div>' +
      '<form class="hl-account-form" data-hl-profile-form>' +
        '<h3>Profile</h3>' +
        '<label>Name<input name="name" type="text" maxlength="120" required value="' + escapeHtml(user.name || '') + '"></label>' +
        '<button class="hl-surface-button is-primary" type="submit" ' + (busy ? 'disabled' : '') + '>Save profile</button>' +
      '</form>' +
      '<form class="hl-account-form" data-hl-password-form>' +
        '<h3>Password</h3>' +
        '<label>Current password<input name="currentPassword" type="password" autocomplete="current-password" required></label>' +
        '<label>New password<input name="newPassword" type="password" autocomplete="new-password" minlength="10" required></label>' +
        '<button class="hl-surface-button" type="submit" ' + (busy ? 'disabled' : '') + '>Change password</button>' +
      '</form>';
    var root = surfaceShell(
      'Account',
      'Manage your Hermes Layer account without leaving your agent workspace.',
      body,
      busy
    );
    var profileForm = root.querySelector('[data-hl-profile-form]');
    if (profileForm) {
      profileForm.addEventListener('submit', function(event){
        event.preventDefault();
        var name = (profileForm.querySelector('[name="name"]') || {}).value || '';
        renderAccountSurface(user, subscription, true, 'Saving profile...');
        agentApiJson('api/hermes-layer/account/profile', {
          method: 'PATCH',
          body: JSON.stringify({ name: name })
        }).then(function(result){
          initAccountMenu();
          renderAccountSurface(result.user || user, subscription, false, 'Profile updated.');
        }).catch(function(error){
          renderAccountSurface(user, subscription, false, error.message || 'Profile update failed.');
        });
      });
    }
    var passwordForm = root.querySelector('[data-hl-password-form]');
    if (passwordForm) {
      passwordForm.addEventListener('submit', function(event){
        event.preventDefault();
        var currentPassword = (passwordForm.querySelector('[name="currentPassword"]') || {}).value || '';
        var newPassword = (passwordForm.querySelector('[name="newPassword"]') || {}).value || '';
        renderAccountSurface(user, subscription, true, 'Changing password...');
        agentApiJson('api/hermes-layer/account/password', {
          method: 'POST',
          body: JSON.stringify({ currentPassword: currentPassword, newPassword: newPassword })
        }).then(function(result){
          renderAccountSurface(result.user || user, subscription, false, 'Password changed. Other sessions were signed out.');
        }).catch(function(error){
          renderAccountSurface(user, subscription, false, error.message || 'Password change failed.');
        });
      });
    }
  }

  function renderBillingSurface(config, state, busy, message){
    var plans = Array.isArray(config.plans) ? config.plans : [];
    var subscription = state.subscription || {};
    var currentPlan = subscription.planKey || 'none';
    var stripeReady = !!state.stripeConfigured;
    var portalAvailable = !!state.portalAvailable;
    var activeSubscription = ['active', 'trialing'].indexOf(subscription.status || '') >= 0;
    var planCards = plans.map(function(plan){
      var active = activeSubscription && plan.key === currentPlan;
      var features = Array.isArray(plan.features) ? plan.features : [];
      var action = activeSubscription
        ? (active
            ? '<button class="hl-surface-button" type="button" disabled>Current plan</button>'
            : '<div class="hl-surface-muted">Manage plan changes in the billing portal.</div>')
        : '<button class="hl-surface-button is-primary" type="button" data-hl-checkout-plan="' + escapeHtml(plan.key || '') + '" ' + (busy || !stripeReady || !plan.priceId ? 'disabled' : '') + '>Choose plan</button>';
      return '<article class="hl-billing-plan' + (active ? ' is-active' : '') + '">' +
        '<div class="hl-billing-plan-head">' +
          '<div><h3>' + escapeHtml(plan.name || plan.key) + '</h3><p>' + escapeHtml(plan.description || '') + '</p></div>' +
          '<strong>EUR ' + escapeHtml(plan.priceEur || '-') + '<span>/mo</span></strong>' +
        '</div>' +
        '<ul>' + features.map(function(feature){ return '<li>' + escapeHtml(feature) + '</li>'; }).join('') + '</ul>' +
        action +
      '</article>';
    }).join('');
    var body =
      (message ? '<div class="hl-surface-alert">' + escapeHtml(message) + '</div>' : '') +
      (!stripeReady ? '<div class="hl-surface-alert">Stripe test keys and EUR price IDs are not configured for this environment.</div>' : '') +
      '<div class="hl-surface-row">' +
        '<div><h3>Subscription</h3><p>Checkout, tax collection and billing changes are handled by Stripe.</p></div>' +
        '<button class="hl-surface-button" type="button" data-hl-portal ' + (busy || !portalAvailable ? 'disabled' : '') + '>Open billing portal</button>' +
      '</div>' +
      '<div class="hl-surface-metrics">' +
        metric('Plan', currentPlan) +
        metric('Status', subscription.status || 'none') +
        metric('Tax', config.taxEnabled ? 'enabled' : 'disabled') +
        metric('Currency', config.currency || 'EUR') +
      '</div>' +
      '<div class="hl-billing-grid">' + (planCards || '<div class="hl-surface-muted">No plans configured.</div>') + '</div>';
    var root = surfaceShell(
      'Billing',
      'Manage your Hermes Layer subscription through Stripe Checkout and Customer Portal.',
      body,
      busy
    );
    root.querySelectorAll('[data-hl-checkout-plan]').forEach(function(button){
      button.addEventListener('click', function(){
        var planKey = button.getAttribute('data-hl-checkout-plan') || 'starter';
        renderBillingSurface(config, state, true, 'Opening Stripe Checkout...');
        agentApiJson('api/hermes-layer/billing/checkout', {
          method: 'POST',
          body: JSON.stringify({ planKey: planKey })
        }).then(function(result){
          if (result && result.url) window.location.assign(result.url);
          else renderBillingSurface(config, state, false, 'Stripe did not return a Checkout URL.');
        }).catch(function(error){
          renderBillingSurface(config, state, false, error.message || 'Checkout failed.');
        });
      });
    });
    var portal = root.querySelector('[data-hl-portal]');
    if (portal) {
      portal.addEventListener('click', function(){
        renderBillingSurface(config, state, true, 'Opening Stripe Customer Portal...');
        agentApiJson('api/hermes-layer/billing/portal', { method: 'POST' }).then(function(result){
          if (result && result.url) window.location.assign(result.url);
          else renderBillingSurface(config, state, false, 'Stripe did not return a portal URL.');
        }).catch(function(error){
          renderBillingSurface(config, state, false, error.message || 'Billing portal failed.');
        });
      });
    }
  }

  function handleBillingReturn(){
    var params = new URLSearchParams(location.search || '');
    var checkout = params.get('checkout');
    var sessionId = params.get('session_id');
    var billing = params.get('billing');
    if (!checkout && billing !== 'portal') return;
    params.delete('checkout');
    params.delete('session_id');
    params.delete('billing');
    var nextSearch = params.toString();
    var nextUrl = location.pathname + (nextSearch ? '?' + nextSearch : '') + location.hash;
    if (history && history.replaceState) history.replaceState(null, document.title, nextUrl);
    if (checkout === 'cancelled') {
      openBillingSurface('Checkout cancelled.');
      return;
    }
    if (billing === 'portal') {
      openBillingSurface('Returned from Stripe Customer Portal.');
      return;
    }
    if (checkout !== 'success') return;
    if (!sessionId) {
      openBillingSurface('Checkout session is missing.');
      return;
    }
    surfaceShell(
      'Billing',
      'Manage your Hermes Layer subscription through Stripe Checkout and Customer Portal.',
      '<div class="hl-surface-muted">Syncing subscription...</div>',
      true
    );
    agentApiJson('api/hermes-layer/billing/sync-checkout', {
      method: 'POST',
      body: JSON.stringify({ sessionId: sessionId })
    }).then(function(){
      initAccountMenu();
      openBillingSurface('Subscription activated.');
    }).catch(function(error){
      openBillingSurface(error.message || 'Checkout sync failed.');
    });
  }

  function renderSupportSurface(tickets, busy, message){
    var rows = (tickets || []).map(function(ticket){
      return '<div class="hl-support-ticket">' +
        '<div><strong>' + escapeHtml(ticket.subject) + '</strong><span>' + escapeHtml(ticket.status || 'open') + ' - ' + escapeHtml(formatDate(ticket.createdAt)) + '</span></div>' +
        '<p>' + escapeHtml(ticket.messagePreview || '') + '</p>' +
      '</div>';
    }).join('');
    var body =
      (message ? '<div class="hl-surface-alert">' + escapeHtml(message) + '</div>' : '') +
      '<form class="hl-support-form" data-hl-support-form>' +
        '<label>Subject<input name="subject" type="text" maxlength="160" required placeholder="What do you need help with?"></label>' +
        '<label>Message<textarea name="message" maxlength="5000" required rows="7" placeholder="Describe the issue, expected behavior, and any useful context."></textarea></label>' +
        '<button class="hl-surface-button is-primary" type="submit" ' + (busy ? 'disabled' : '') + '>Send request</button>' +
      '</form>' +
      '<h3>Recent requests</h3>' +
      '<div class="hl-support-list">' + (rows || '<div class="hl-surface-muted">No support requests yet.</div>') + '</div>';
    var root = surfaceShell(
      'Support',
      'Send a support request without leaving your Hermes Agent workspace.',
      body,
      busy
    );
    var form = root.querySelector('[data-hl-support-form]');
    if (form) {
      form.addEventListener('submit', function(event){
        event.preventDefault();
        var subject = (form.querySelector('[name="subject"]') || {}).value || '';
        var text = (form.querySelector('[name="message"]') || {}).value || '';
        renderSupportSurface(tickets, true, 'Sending support request...');
        agentApiJson('api/hermes-layer/support/tickets', {
          method: 'POST',
          body: JSON.stringify({ subject: subject, message: text })
        }).then(function(){
          return agentApiJson('api/hermes-layer/support/tickets');
        }).then(function(result){
          renderSupportSurface(result.tickets || [], false, 'Support request sent.');
        }).catch(function(error){
          renderSupportSurface(tickets, false, error.message || 'Support request failed.');
        });
      });
    }
  }

  function renderBackupsSurface(backups, busy, message){
    var rows = (backups || []).map(function(backup){
      var restorable = backup.status === 'completed' || backup.status === 'restored';
      var trigger = backup.trigger || 'manual';
      var triggerLabel = trigger === 'scheduled' ? 'Automatic backup' : (trigger === 'imported' ? 'Imported backup' : 'Manual backup');
      return '<div class="hl-backup-row">' +
        '<div class="hl-backup-main">' +
          '<strong>' + escapeHtml(backup.id) + '</strong>' +
          '<span>' + escapeHtml(triggerLabel) + ' - Created ' + escapeHtml(formatDate(backup.createdAt)) + '</span>' +
        '</div>' +
        '<div class="hl-backup-meta">' +
          '<span>' + escapeHtml(backup.status || 'unknown') + '</span>' +
          '<span>' + escapeHtml(formatBytes(backup.sizeBytes)) + '</span>' +
          '<button class="hl-surface-button" type="button" data-hl-download-backup="' + escapeHtml(backup.id) + '" ' + (restorable && !busy ? '' : 'disabled') + '>Download</button>' +
          '<button class="hl-surface-button" type="button" data-hl-restore-backup="' + escapeHtml(backup.id) + '" ' + (restorable && !busy ? '' : 'disabled') + '>Restore</button>' +
        '</div>' +
      '</div>';
    }).join('');
    var body =
      '<div class="hl-surface-row">' +
        '<div><h3>Full Workspace Backup</h3><p>Archives restore Hermes/WebUI data and Headroom context data together after checksum verification. Exports can be imported back into this workspace.</p></div>' +
        '<div class="hl-surface-actions">' +
          '<button class="hl-surface-button" type="button" data-hl-import-backup-button ' + (busy ? 'disabled' : '') + '>Import backup</button>' +
          '<button class="hl-surface-button is-primary" type="button" data-hl-create-backup ' + (busy ? 'disabled' : '') + '>Create backup</button>' +
          '<input type="file" data-hl-import-backup hidden accept=".tar.gz,application/gzip,application/x-gzip">' +
        '</div>' +
      '</div>' +
      (message ? '<div class="hl-surface-alert">' + escapeHtml(message) + '</div>' : '') +
      '<div class="hl-surface-metrics">' +
        metric('Backups', formatNumber((backups || []).length)) +
        metric('Completed', formatNumber((backups || []).filter(function(item){ return item.status === 'completed' || item.status === 'restored'; }).length)) +
        metric('Latest size', formatBytes((backups || [])[0] && (backups || [])[0].sizeBytes)) +
        metric('Format', 'Full workspace') +
      '</div>' +
      '<div class="hl-backup-list">' + (rows || '<div class="hl-surface-muted">No backups yet.</div>') + '</div>';
    var root = surfaceShell(
      'Backups',
      'Full workspace backups include Hermes/WebUI data, Headroom data, manifest and checksums.',
      body,
      busy
    );
    var createButton = root.querySelector('[data-hl-create-backup]');
    if (createButton) {
      createButton.addEventListener('click', function(){
        renderBackupsSurface(backups, true, 'Creating a full workspace backup...');
        agentApiJson('api/hermes-layer/backups', { method: 'POST' }).then(function(){
          return agentApiJson('api/hermes-layer/backups');
        }).then(function(result){
          renderBackupsSurface(result.backups || [], false, 'Backup completed.');
        }).catch(function(error){
          renderBackupsSurface(backups, false, error.message || 'Backup failed.');
        });
      });
    }
    var importButton = root.querySelector('[data-hl-import-backup-button]');
    var importInput = root.querySelector('[data-hl-import-backup]');
    if (importButton && importInput) {
      importButton.addEventListener('click', function(){
        importInput.value = '';
        importInput.click();
      });
      importInput.addEventListener('change', function(){
        var file = importInput.files && importInput.files[0];
        if (!file) return;
        renderBackupsSurface(backups, true, 'Importing full workspace backup...');
        agentApiJson('api/hermes-layer/backups/import', {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'application/gzip' },
          body: file
        }).then(function(){
          return agentApiJson('api/hermes-layer/backups');
        }).then(function(result){
          renderBackupsSurface(result.backups || [], false, 'Backup imported.');
        }).catch(function(error){
          renderBackupsSurface(backups, false, error.message || 'Backup import failed.');
        });
      });
    }
    root.querySelectorAll('[data-hl-download-backup]').forEach(function(button){
      button.addEventListener('click', function(){
        var backupId = button.getAttribute('data-hl-download-backup') || '';
        if (!backupId) return;
        window.location.assign(agentApiUrl('api/hermes-layer/backups/' + encodeURIComponent(backupId) + '/download'));
      });
    });
    root.querySelectorAll('[data-hl-restore-backup]').forEach(function(button){
      button.addEventListener('click', function(){
        var backupId = button.getAttribute('data-hl-restore-backup') || '';
        if (!backupId) return;
        if (!window.confirm('Restore this workspace from backup ' + backupId + '? Current agent data will be replaced.')) return;
        renderBackupsSurface(backups, true, 'Restoring backup...');
        agentApiJson('api/hermes-layer/restore', {
          method: 'POST',
          body: JSON.stringify({ backupId: backupId })
        }).then(function(){
          return agentApiJson('api/hermes-layer/backups');
        }).then(function(result){
          renderBackupsSurface(result.backups || [], false, 'Restore completed.');
        }).catch(function(error){
          renderBackupsSurface(backups, false, error.message || 'Restore failed.');
        });
      });
    });
  }

  function renderOptimizationSurface(state, stats, saving){
    var runtime = state && state.runtime ? state.runtime : {};
    var settings = state && state.settings ? state.settings : {};
    var summary = stats && stats.summary ? stats.summary : {};
    var enabled = settings.enabled !== false;
    var history = stats && stats.history ? stats.history : null;
    var lifetime = history && history.lifetime ? history.lifetime : {};
    var currentSession = history && history.currentSession ? history.currentSession : {};
    var periods = history && Array.isArray(history.periods) ? history.periods : [];
    var periodRows = periods.slice(0, 14).map(function(period){
      return '<tr>' +
        '<td>' + escapeHtml(period.date || '-') + '</td>' +
        '<td>' + escapeHtml(formatNumber(period.requests)) + '</td>' +
        '<td>' + escapeHtml(formatNumber(period.tokensSaved)) + '</td>' +
        '<td>' + escapeHtml(formatPercent(period.savingsPercent)) + '</td>' +
      '</tr>';
    }).join('');
    var body =
      '<div class="hl-surface-row">' +
        '<div><h3>Context optimization</h3><p>Uses Headroom inside this hosted agent to reduce context size before model calls.</p></div>' +
        '<label class="hl-switch"><input type="checkbox" data-hl-headroom-toggle ' + (enabled ? 'checked' : '') + ' ' + (saving ? 'disabled' : '') + '><span></span><b>' + (enabled ? 'Enabled' : 'Disabled') + '</b></label>' +
      '</div>' +
      '<div class="hl-surface-status-grid">' +
        statusItem('Optimization', runtime.status || 'unknown', ['healthy', 'disabled'].indexOf(runtime.status || '') >= 0) +
        statusItem('Optimizer service', runtime.sidecarHealthy ? 'healthy' : 'unhealthy', !!runtime.sidecarHealthy) +
        statusItem('Context engine', runtime.pluginConfigured ? 'configured' : 'missing', !!runtime.pluginConfigured) +
        statusItem('Tool bridge', runtime.mcpConfigured ? 'configured' : 'missing', !!runtime.mcpConfigured) +
      '</div>' +
      (runtime.message ? '<div class="hl-surface-alert">' + escapeHtml(runtime.message) + '</div>' : '') +
      '<div class="hl-surface-metrics">' +
        metric('Requests', formatNumber(summary.requests)) +
        metric('Compressed', formatNumber(summary.requestsCompressed)) +
        metric('Tokens saved', formatNumber(summary.tokensSaved)) +
        metric('Savings', formatPercent(summary.savingsPercent)) +
        metric('Tokens before', formatNumber(summary.tokensBefore)) +
        metric('Tokens after', formatNumber(summary.tokensAfter)) +
        metric('Cache hits', formatNumber(summary.cacheHits)) +
        metric('CCR entries', formatNumber(summary.ccrEntries)) +
      '</div>' +
      (history ? '<h3>History</h3>' +
        '<div class="hl-surface-metrics">' +
          metric('Lifetime requests', formatNumber(lifetime.requests)) +
          metric('Lifetime saved', formatNumber(lifetime.tokensSaved)) +
          metric('Session saved', formatNumber(currentSession.tokensSaved)) +
          metric('Generated', history.generatedAt || '-') +
        '</div>' +
        (periodRows ? '<table class="hl-surface-table"><thead><tr><th>Date</th><th>Requests</th><th>Tokens saved</th><th>Savings</th></tr></thead><tbody>' + periodRows + '</tbody></table>' : '<div class="hl-surface-muted">No history periods yet.</div>') : '');
    var root = surfaceShell(
      'Context Optimization',
      'Headroom runs inside this isolated workspace and reports redacted aggregate metrics.',
      body,
      saving
    );
    var toggle = root.querySelector('[data-hl-headroom-toggle]');
    if (toggle) {
      toggle.addEventListener('change', function(event){
        var next = !!event.target.checked;
        renderOptimizationSurface(state, stats, true);
        agentApiJson('api/hermes-layer/headroom', {
          method: 'PATCH',
          body: JSON.stringify({ enabled: next })
        }).then(function(result){
          return agentApiJson('api/hermes-layer/headroom/stats').then(function(statsResult){
            renderOptimizationSurface(result.headroom, statsResult.stats, false);
          });
        }).catch(function(error){
          renderOptimizationSurface(state, stats, false);
          var bodyNode = document.querySelector('.hl-surface-body');
          if (bodyNode) bodyNode.insertAdjacentHTML('afterbegin', '<div class="hl-surface-alert">' + escapeHtml(error.message || 'Context optimization update failed.') + '</div>');
        });
      });
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
      if (link.action) {
        return '<button class="hl-account-link" type="button" data-hl-action="' + escapeHtml(link.action) + '" role="menuitem">' + escapeHtml(link.label) + '</button>';
      }
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
    root.querySelectorAll('[data-hl-action]').forEach(function(action){
      action.addEventListener('click', function(event){
        event.preventDefault();
        setOpen(root, false);
        if (action.getAttribute('data-hl-action') === 'workspace') openWorkspaceSurface();
        if (action.getAttribute('data-hl-action') === 'account') openAccountSurface();
        if (action.getAttribute('data-hl-action') === 'billing') openBillingSurface();
        if (action.getAttribute('data-hl-action') === 'optimization') openOptimizationSurface();
        if (action.getAttribute('data-hl-action') === 'backups') openBackupsSurface();
        if (action.getAttribute('data-hl-action') === 'support') openSupportSurface();
      });
    });
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

  function initHermesLayer(){
    initAccountMenu();
    handleBillingReturn();
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
    document.addEventListener('DOMContentLoaded', initHermesLayer, { once: true });
  } else {
    initHermesLayer();
  }
})();
