"""
Static hosted-mode contract tests for the Hermes Layer WebUI fork.

These tests intentionally check source-level integration points. If an upstream
merge reintroduces standalone WebUI controls or moves the Hermes Layer account
mount out of the stable titlebar area, the fork should fail before it ships.
"""

from pathlib import Path


REPO = Path(__file__).parent.parent
STATIC = REPO / "static"
HTML = (STATIC / "index.html").read_text(encoding="utf-8")
HERMES_LAYER_JS = (STATIC / "hermes-layer.js").read_text(encoding="utf-8")
BOOT_JS = (STATIC / "boot.js").read_text(encoding="utf-8")
PANELS_JS = (STATIC / "panels.js").read_text(encoding="utf-8")
UI_JS = (STATIC / "ui.js").read_text(encoding="utf-8")


def test_account_avatar_mount_is_part_of_the_webui_titlebar():
    assert "<title>Hermes Layer Agent</title>" in HTML
    assert '<script src="static/hermes-layer.js?v=__WEBUI_VERSION__"></script>' in HTML
    assert 'id="hermes-layer-account"' in HTML
    assert "data-hermes-layer-account" in HTML

    account_pos = HTML.index('id="hermes-layer-account"')
    reload_pos = HTML.index('id="btnReload"')
    assert account_pos < reload_pos, "Hermes Layer account menu must live inside the stable titlebar controls"


def test_standalone_hosted_controls_are_removed_from_markup():
    removed_ids = [
        "settingsCheckUpdates",
        "settingsIgnoreAgentUpdates",
        "settingsWhatsNewSummary",
        "settingsPassword",
        "settingsPasswordEnvLock",
        "btnSignOut",
        "btnRegisterPasskey",
        "passkeysSettingsBlock",
        "btnShutdown",
        "settingsDashboardMode",
        "settingsDashboardUrl",
    ]
    for element_id in removed_ids:
        assert f'id="{element_id}"' not in HTML, f"{element_id} must not be visible in hosted WebUI"


def test_hermes_layer_bridge_owns_account_billing_backups_support_and_headroom_routes():
    required_routes = [
        "api/hermes-layer/session",
        "api/hermes-layer/account",
        "api/hermes-layer/account/profile",
        "api/hermes-layer/account/password",
        "api/hermes-layer/billing/config",
        "api/hermes-layer/billing/state",
        "api/hermes-layer/billing/checkout",
        "api/hermes-layer/billing/portal",
        "api/hermes-layer/billing/sync-checkout",
        "api/hermes-layer/backups",
        "api/hermes-layer/restore",
        "api/hermes-layer/support/tickets",
        "api/hermes-layer/headroom",
        "api/hermes-layer/headroom/stats",
        "api/auth/logout",
    ]
    for route in required_routes:
        assert route in HERMES_LAYER_JS

    required_actions = ["account", "billing", "optimization", "backups", "support"]
    assert "data-hl-action" in HERMES_LAYER_JS
    assert "data-hl-account-logout" in HERMES_LAYER_JS
    for action in required_actions:
        assert f"'{action}'" in HERMES_LAYER_JS or f'"{action}"' in HERMES_LAYER_JS


def test_bridge_rebases_fetch_and_eventsource_to_the_agent_gateway():
    assert "window.__hermesLayerHosted = true;" in HERMES_LAYER_JS
    assert "window.fetch" in HERMES_LAYER_JS
    assert "window.EventSource" in HERMES_LAYER_JS
    assert "currentAgentBase()" in HERMES_LAYER_JS
    assert "agentScopedUrl" in HERMES_LAYER_JS


def test_hosted_mode_blocks_webui_updates_shutdown_auth_and_passkeys():
    assert "if(!window.__hermesLayerHosted&&" in BOOT_JS
    assert "api/updates/check" in BOOT_JS
    assert "if (window.__hermesLayerHosted) return;" in BOOT_JS

    guarded_functions = [
        "async function loadPasskeys",
        "async function registerPasskey",
        "async function deletePasskey",
        "async function checkUpdatesNow",
        "async function signOut",
        "async function goPasswordless",
        "async function disableAuth",
    ]
    for marker in guarded_functions:
        start = PANELS_JS.index(marker)
        block = PANELS_JS[start:start + 260]
        assert "if(window.__hermesLayerHosted) return;" in block, f"{marker} must no-op in hosted mode"

    assert "if(!window.__hermesLayerHosted && pw && pw.trim())" in PANELS_JS
    assert "body.check_for_updates" in PANELS_JS
    assert "if(!window.__hermesLayerHosted)" in PANELS_JS


def test_dashboard_and_host_editor_surfaces_are_hosted_guarded():
    for marker in [
        "function _applyDashboardStatus",
        "async function refreshDashboardStatus",
        "async function loadDashboardSettings",
        "async function saveDashboardSettings",
        "function openHermesDashboard",
        "function _initDashboardLinkProbe",
    ]:
        start = UI_JS.index(marker)
        block = UI_JS[start:start + 340]
        assert "window.__hermesLayerHosted" in block, f"{marker} must be hosted-aware"

    for route in ["/api/file/reveal", "/api/file/open-vscode"]:
        route_pos = UI_JS.index(route)
        guard_pos = UI_JS.rfind("if(!window.__hermesLayerHosted)", 0, route_pos)
        assert guard_pos != -1
        assert route_pos - guard_pos < 900, f"{route} must stay behind a hosted guard"
