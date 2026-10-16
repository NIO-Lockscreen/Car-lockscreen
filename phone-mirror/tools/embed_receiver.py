#!/usr/bin/env python3
"""Synchronize standalone receiver HTML into the Swift Broadcast Upload extension."""
from pathlib import Path
root = Path(__file__).resolve().parents[1]
html = (root / 'web' / 'receiver.html').read_text()
assert '"""#' not in html
swift = 'import Foundation\n\nenum ReceiverHTML {\n    static let page = #"""\n' + html + '\n"""#\n}\n'
(root / 'ios/BroadcastUpload/ReceiverHTML.swift').write_text(swift)
print('Embedded', len(html), 'chars of receiver UI into Swift extension')
