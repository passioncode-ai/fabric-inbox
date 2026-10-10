#!/bin/bash
# .deb post-remove: undo after-install.sh. The person's data (~/.config/Fabric Inbox) stays.
rm -f /usr/bin/fabric-inbox
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q /usr/share/applications || true; fi
exit 0
