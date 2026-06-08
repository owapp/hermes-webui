"""
Static hosted-mode contract tests for the Hermes Layer WebUI fork.

These tests intentionally check source-level integration points. If an upstream
merge reintroduces standalone WebUI controls or moves the Hermes Layer account
mount out of the stable titlebar area, the fork should fail before it ships.
"""

from pathlib import Path
import struct


REPO = Path(__file__).parent.parent
STATIC = REPO / "static"
HTML = (STATIC / "index.html").read_text(encoding="utf-8")
HERMES_LAYER_JS = (STATIC / "hermes-layer.js").read_text(encoding="utf-8")
BOOT_JS = (STATIC / "boot.js").read_text(encoding="utf-8")
PANELS_JS = (STATIC / "panels.js").read_text(encoding="utf-8")
UI_JS = (STATIC / "ui.js").read_text(encoding="utf-8")


def png_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    assert data.startswith(b"\x89PNG\r\n\x1a\n")
    return struct.unpack(">II", data[16:24])


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
        "api/hermes-layer/workspace",
        "api/hermes-layer/workspace/action",
        "api/hermes-layer/account",
        "api/hermes-layer/account/profile",
        "api/hermes-layer/account/password",
        "api/hermes-layer/billing/config",
        "api/hermes-layer/billing/state",
        "api/hermes-layer/billing/checkout",
        "api/hermes-layer/billing/portal",
        "api/hermes-layer/billing/sync-checkout",
        "api/hermes-layer/backups",
        "api/hermes-layer/backups/import",
        "api/hermes-layer/restore",
        "api/hermes-layer/support/tickets",
        "api/hermes-layer/headroom",
        "api/hermes-layer/headroom/stats",
        "api/auth/logout",
    ]
    for route in required_routes:
        assert route in HERMES_LAYER_JS

    required_actions = ["workspace", "account", "billing", "optimization", "backups", "support"]
    assert "data-hl-action" in HERMES_LAYER_JS
    assert "data-hl-account-logout" in HERMES_LAYER_JS
    assert "data-hl-workspace-action" in HERMES_LAYER_JS
    assert "data-hl-import-backup-button" in HERMES_LAYER_JS
    assert "shouldSetJsonContentType" in HERMES_LAYER_JS
    assert "Agent status" in HERMES_LAYER_JS
    for action in required_actions:
        assert f"'{action}'" in HERMES_LAYER_JS or f'"{action}"' in HERMES_LAYER_JS


def test_account_menu_is_avatar_based_not_a_brand_overlay_button():
    assert '<button class="hl-account-avatar"' in HERMES_LAYER_JS
    assert 'aria-label="Account menu"' in HERMES_LAYER_JS
    assert 'data-hl-account-menu hidden role="menu"' in HERMES_LAYER_JS
    assert 'data-hl-account-button' in HERMES_LAYER_JS
    assert 'data-hl-account-logout' in HERMES_LAYER_JS
    assert 'Hermes Layer</button>' not in HERMES_LAYER_JS
    assert 'data-hl-action="' in HERMES_LAYER_JS


def test_hosted_layer_surfaces_use_agent_language_not_infra_labels():
    assert "Control your hosted Hermes Agent through Hermes Layer." in HERMES_LAYER_JS
    assert "Agent service" in HERMES_LAYER_JS
    assert "Current agent data will be replaced." in HERMES_LAYER_JS
    assert "Optimizer service" in HERMES_LAYER_JS
    assert "Context engine" in HERMES_LAYER_JS
    assert "Tool bridge" in HERMES_LAYER_JS
    assert "Control your hosted Hermes Agent runtime" not in HERMES_LAYER_JS
    assert "Current runtime data will be replaced." not in HERMES_LAYER_JS
    assert "statusItem('Runtime'" not in HERMES_LAYER_JS
    assert "statusItem('Sidecar'" not in HERMES_LAYER_JS
    assert "statusItem('Plugin'" not in HERMES_LAYER_JS
    assert "statusItem('MCP'" not in HERMES_LAYER_JS


def test_hosted_bridge_does_not_integrate_webui_through_iframe_or_proxy_dom_patch():
    lowered = HERMES_LAYER_JS.lower()
    assert "iframe" not in lowered
    assert "contentdocument" not in lowered
    assert "srcdoc" not in lowered
    assert "mutationobserver" not in lowered


def test_headroom_history_is_rendered_as_redacted_metrics_not_raw_json():
    assert "JSON.stringify(stats.history" not in HERMES_LAYER_JS
    assert "hl-surface-table" in HERMES_LAYER_JS
    assert "Lifetime saved" in HERMES_LAYER_JS
    assert "Session saved" in HERMES_LAYER_JS
    assert "storage_path" not in HERMES_LAYER_JS
    assert ".hl-surface-table" in (STATIC / "style.css").read_text(encoding="utf-8")


def test_bridge_rebases_fetch_and_eventsource_to_the_agent_gateway():
    assert "window.__hermesLayerHosted = true;" in HERMES_LAYER_JS
    assert "window.fetch" in HERMES_LAYER_JS
    assert "window.EventSource" in HERMES_LAYER_JS
    assert "currentAgentBase()" in HERMES_LAYER_JS
    assert "agentScopedUrl" in HERMES_LAYER_JS


def test_hosted_mode_brands_browser_title_without_renaming_hermes_agent_ui():
    assert "function hostedDocumentAssistantName()" in UI_JS
    assert "window.__hermesLayerHosted ? 'Hermes Layer Agent' : assistantDisplayName()" in UI_JS
    assert "document.title=hostedDocumentAssistantName();" in UI_JS
    assert "sessionTitle+' \\u2014 '+hostedDocumentAssistantName()" in UI_JS
    assert "document.title=typeof hostedDocumentAssistantName==='function'?hostedDocumentAssistantName():name;" in BOOT_JS


def test_hosted_mode_uses_hermes_layer_favicons():
    favicon_svg = (STATIC / "favicon.svg").read_text(encoding="utf-8")
    favicon_512_svg = (STATIC / "favicon-512.svg").read_text(encoding="utf-8")
    assert 'viewBox="0 0 330 330"' in favicon_svg
    assert "#00C5EF" in favicon_svg
    assert "#5843E5" in favicon_svg
    assert "#F5C542" not in favicon_svg
    assert "#D4961C" not in favicon_svg
    assert favicon_512_svg == favicon_svg
    assert png_size(STATIC / "favicon-32.png") == (32, 32)
    assert png_size(STATIC / "favicon-192.png") == (192, 192)
    assert png_size(STATIC / "favicon-512.png") == (512, 512)
    assert png_size(STATIC / "apple-touch-icon.png") == (512, 512)
    assert (STATIC / "favicon.ico").read_bytes().startswith(b"\x00\x00\x01\x00")


def test_bridge_only_adds_layer_csrf_to_agent_scoped_fetches():
    assert "function requestInitFromFetchInput" in HERMES_LAYER_JS
    assert "input instanceof Request" in HERMES_LAYER_JS
    assert "input.clone().body" in HERMES_LAYER_JS
    assert "function isAgentGatewayUrl(url)" in HERMES_LAYER_JS
    assert "function alreadyScopedToAgent(input)" in HERMES_LAYER_JS
    assert "return originalFetch(scoped, addLayerCsrf(input, opts));" in HERMES_LAYER_JS
    assert "return originalFetch(input, addLayerCsrf(input, opts));" in HERMES_LAYER_JS
    assert "return originalBeacon(scoped || url, data);" in HERMES_LAYER_JS


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

    for marker in ["async function applyUpdates", "async function forceUpdate"]:
        start = UI_JS.index(marker)
        block = UI_JS[start:start + 180]
        assert "if(window.__hermesLayerHosted) return;" in block, f"{marker} must no-op in hosted mode"


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
