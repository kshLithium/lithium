# Third-Party Notices

Lithium depends on several open-source projects. Your use of packaged builds must also comply with those upstream licenses.

This project itself is licensed under the MIT License. See [LICENSE](LICENSE).

## Core Runtime Dependencies

- React — MIT
- React DOM — MIT
- Electron — MIT
- CodeMirror — MIT
- xterm.js — MIT
- node-pty — MIT
- pdf.js (`pdfjs-dist`) — Apache-2.0

## Notes

- `pdfjs-dist` is distributed under Apache-2.0 and may require preserving upstream notices in redistributed builds.
- Additional transitive dependencies are included through the normal npm dependency graph.
- Before distributing signed builds, review the final packaged dependency list and ship any required notices alongside the application bundle.
