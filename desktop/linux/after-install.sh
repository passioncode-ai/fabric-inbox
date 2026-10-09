#!/bin/bash
# .deb post-install (desktop/dist-platform.mjs): what electron-builder's own script did, kept —
# `fabric-inbox` on PATH and the Chromium sandbox helper setuid where user namespaces are restricted —
# plus the desktop database, so x-scheme-handler/fabric-inbox finds the app (PL-04). The person's own
# default handler is set by the app at first launch (app.setAsDefaultProtocolClient).
set -e
APP_DIR='/opt/Fabric Inbox'
chmod 755 "$APP_DIR"
ln -sf "$APP_DIR/fabric-inbox" /usr/bin/fabric-inbox
if [ -f "$APP_DIR/chrome-sandbox" ]; then
  chown root:root "$APP_DIR/chrome-sandbox"
  chmod 4755 "$APP_DIR/chrome-sandbox"
fi
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q /usr/share/applications || true; fi
exit 0
