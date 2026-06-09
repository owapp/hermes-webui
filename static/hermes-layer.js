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

  function openBackupsSurface(){
    surfaceShell(
      'Backups',
      'Full workspace backups include Hermes/WebUI data, manifest and checksums.',
      '<div class="hl-surface-muted">Loading...</div>',
      true
    );
    agentApiJson('api/hermes-layer/backups').then(function(result){
      renderBackupsSurface(result.backups || [], false, '');
    }).catch(function(error){
      surfaceShell(
        'Backups',
        'Full workspace backups include Hermes/WebUI data, manifest and checksums.',
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
        '<button class="hl-surface-button is-warning" type="button" data-hl-workspace-action="restart" ' + (busy || isBusyState || !canRestart ? 'disabled' : '') + '>Restart agent</button>' +
        '<button class="hl-surface-button ' + (primaryAction === 'recover' ? 'is-primary' : '') + '" type="button" data-hl-workspace-action="recover" ' + (busy || isBusyState || !canRecover ? 'disabled' : '') + '>Recover agent</button>' +
        '<button class="hl-surface-button is-danger" type="button" data-hl-workspace-action="stop" ' + (busy || isBusyState || !canStop ? 'disabled' : '') + '>Stop agent</button>' +
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
        '<div><h3>Full Workspace Backup</h3><p>Archives restore Hermes/WebUI data after checksum verification. Exports can be imported back into this workspace.</p></div>' +
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
      'Full workspace backups include Hermes/WebUI data, manifest and checksums.',
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

  function setOpen(root, open){
    var menu = root.querySelector('[data-hl-account-menu]');
    var button = root.querySelector('[data-hl-account-button]');
    if (!menu || !button) return;
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  }

  function accountIconMarkup(){
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
  }

  function bindAccountButton(root){
    var button = root.querySelector('[data-hl-account-button]');
    if (!button) return;
    button.addEventListener('click', function(event){
      event.stopPropagation();
      var menu = root.querySelector('[data-hl-account-menu]');
      setOpen(root, !!(menu && menu.hidden));
    });
  }

  function renderAccountLoadingMenu(root, message){
    root.hidden = false;
    root.classList.add('is-loading');
    root.innerHTML =
      '<button class="hl-account-avatar is-loading" type="button" data-hl-account-button aria-haspopup="menu" aria-expanded="false" aria-label="Account menu">' + accountIconMarkup() + '</button>' +
      '<div class="hl-account-menu hl-account-menu-loading" data-hl-account-menu hidden role="menu" aria-label="Account">' +
        '<div class="hl-account-loading">' + escapeHtml(message || 'Loading account...') + '</div>' +
      '</div>';
    bindAccountButton(root);
  }

  function humanizeSubscriptionValue(value){
    var text = String(value || 'none').replace(/[-_]+/g, ' ').trim();
    if (!text) return 'None';
    return text.replace(/\b\w/g, function(match){ return match.toUpperCase(); });
  }

  function subscriptionStatusClass(status){
    var normalized = String(status || 'none').toLowerCase();
    if (normalized === 'active' || normalized === 'trialing') return 'is-ok';
    if (normalized === 'none' || normalized === 'canceled' || normalized === 'unpaid' || normalized === 'past_due') return 'is-warn';
    return 'is-neutral';
  }

  function accountSubscriptionMarkup(subscription){
    var plan = humanizeSubscriptionValue(subscription && subscription.planKey);
    var status = String((subscription && subscription.status) || 'none').toLowerCase();
    var label = plan + ' - ' + humanizeSubscriptionValue(status);
    return '<div class="hl-account-subscription ' + subscriptionStatusClass(status) + '" data-hl-subscription-status="' + escapeHtml(status) + '">' +
      '<span>Subscription</span>' +
      '<strong>' + escapeHtml(label) + '</strong>' +
      '</div>';
  }

  function accountAiCreditsMarkup(aiCredits){
    if (!aiCredits) return '';
    var available = Number(aiCredits.availableCents || 0) / 100;
    var label = '';
    try { label = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' }).format(available); }
    catch (_) { label = 'EUR ' + available.toFixed(2); }
    return '<div class="hl-account-subscription is-neutral" data-hl-ai-credits>' +
      '<span>AI credits</span>' +
      '<strong>' + escapeHtml(label) + '</strong>' +
      '</div>';
  }

  function renderAccountMenu(root, payload){
    var account = payload && payload.account ? payload.account : {};
    var subscription = payload && payload.subscription ? payload.subscription : {};
    var aiCredits = payload && payload.aiCredits ? payload.aiCredits : null;
    var links = payload && Array.isArray(payload.links) ? payload.links : [];
    var name = account.name || account.email || 'Account';
    var email = account.email || '';
    var linkMarkup = links.map(function(link){
      if (link.action) {
        return '<button class="hl-account-link" type="button" data-hl-action="' + escapeHtml(link.action) + '" role="menuitem">' + escapeHtml(link.label) + '</button>';
      }
      var target = link.target ? ' target="' + escapeHtml(link.target) + '" rel="noopener noreferrer"' : '';
      return '<a class="hl-account-link" href="' + escapeHtml(link.href) + '"' + target + ' role="menuitem">' + escapeHtml(link.label) + '</a>';
    }).join('');

    root.hidden = false;
    root.classList.remove('is-loading');
    root.innerHTML =
      '<button class="hl-account-avatar" type="button" data-hl-account-button aria-haspopup="menu" aria-expanded="false" aria-label="Account menu">' + accountIconMarkup() + '</button>' +
      '<div class="hl-account-menu" data-hl-account-menu hidden role="menu" aria-label="Account">' +
        '<div class="hl-account-profile">' +
          '<div class="hl-account-name">' + escapeHtml(name) + '</div>' +
          '<div class="hl-account-email">' + escapeHtml(email) + '</div>' +
          accountSubscriptionMarkup(subscription) +
          accountAiCreditsMarkup(aiCredits) +
        '</div>' +
        '<div class="hl-account-separator"></div>' +
        linkMarkup +
        '<div class="hl-account-separator"></div>' +
        '<button class="hl-account-logout" type="button" data-hl-account-logout role="menuitem">Log out</button>' +
      '</div>';

    var logout = root.querySelector('[data-hl-account-logout]');
    bindAccountButton(root);
    if (logout && originalFetch) {
      logout.addEventListener('click', function(){
        agentApiJson('api/hermes-layer/logout', { method: 'POST' }).finally(function(){
          window.location.assign(controlPlaneUrl('/'));
        });
      });
    }
    root.querySelectorAll('[data-hl-action]').forEach(function(action){
      action.addEventListener('click', function(event){
        event.preventDefault();
        setOpen(root, false);
        if (action.getAttribute('data-hl-action') === 'workspace') openWorkspaceSurface();
        if (action.getAttribute('data-hl-action') === 'backups') openBackupsSurface();
      });
    });
  }

  function initAccountMenu(){
    var root = document.getElementById('hermes-layer-account');
    if (!root) {
      console.error('Hermes Layer account integration anchor missing. Review the pinned WebUI update.');
      return;
    }
    renderAccountLoadingMenu(root);
    if (!originalFetch) return;
    originalFetch(sessionUrl(), { credentials: 'include' })
      .then(function(response){ return response.ok ? response.json() : null; })
      .then(function(payload){
        if (payload) renderAccountMenu(root, payload);
      })
      .catch(function(error){
        renderAccountLoadingMenu(root, 'Account unavailable. Reload this page to retry.');
        console.error('Hermes Layer account session failed', error);
      });
  }

  function initHermesLayer(){
    initAccountMenu();
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
