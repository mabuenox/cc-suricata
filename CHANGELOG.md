# Changelog

## [0.4.0](https://github.com/mabuenox/cc-suricata/compare/v0.3.0...v0.4.0) (2026-11-07)


### Features

* a branch icon or a worktree icon in front of the branch name ([f928ffe](https://github.com/mabuenox/cc-suricata/commit/f928ffe0ad476b98dfb0d107e2b4393338823b12))
* a question for you is always next, and the summary is the suricata speaking ([2152971](https://github.com/mabuenox/cc-suricata/commit/2152971f7023ac1b78bf7d6c8a396ef916ddd752))
* a worktree says so after its branch ([aa0a9c1](https://github.com/mabuenox/cc-suricata/commit/aa0a9c13e23d81d241f032e0e7130b18ae13ebf3))
* closed sessions show the branch they were on, and whether their folder is a worktree ([f5445c4](https://github.com/mabuenox/cc-suricata/commit/f5445c42a83b0d00524565cf655ddfdd0692b731))
* findings strip and a two-sentence summary written by claude -p ([356e027](https://github.com/mabuenox/cc-suricata/commit/356e0276eef3a527b5e23471cc3ce93ba5705d10))
* one "Next" finding instead of a row of chips, a summary that adds what the list does not show, and no jump when it arrives ([865600b](https://github.com/mabuenox/cc-suricata/commit/865600bf7dfbced824a1bb7d1a3dbd6c5b5df24e))
* polish of the page: a folder icon and name where there is no repo, keyboard-reachable strip links, themed scrollbars and selection ([f79bf05](https://github.com/mabuenox/cc-suricata/commit/f79bf052f8eb4c3838fc57c0f6b18df01ab124a6))
* the list shows each session's title, with the registry name and branch under it ([ca9ad92](https://github.com/mabuenox/cc-suricata/commit/ca9ad92d687f8deb88d8c7857f4ee13a9d7eb99a))
* the strip and the summary name sessions by their title, and the strip uses the page's type size ([548493c](https://github.com/mabuenox/cc-suricata/commit/548493cc75cf775d57ae8b7bde91efa8171ffa3d))
* the strip shows one action only, the most urgent ([7eed828](https://github.com/mabuenox/cc-suricata/commit/7eed8288c1c3df55729e7666019b0f608026170a))
* the suricata speaks the language of your prompts, and the title column gets the width ([5afaf07](https://github.com/mabuenox/cc-suricata/commit/5afaf07be44f51f5c479046317c4b5dea5d8255c))
* the suricata's head and a speech bubble instead of the whole mascot next to the summary ([7cb6985](https://github.com/mabuenox/cc-suricata/commit/7cb69853d92c18d1f72db432e0e43d383bac8e67))


### Bug Fixes

* refuse cross-site requests, so another open site cannot trigger the summary or VS Code ([00d2059](https://github.com/mabuenox/cc-suricata/commit/00d20596a36ee4cd3f386e55d76637fffa73c569))
* the cross-site refusal only on /summary and /open, so a link from another site to the page still opens it ([607ef12](https://github.com/mabuenox/cc-suricata/commit/607ef12fba592adbee7c35ba48049db5fed46cd6))

## [0.3.0](https://github.com/mabuenox/cc-suricata/compare/v0.2.0...v0.3.0) (2026-11-05)


### Features

* search your prompts across every session ([bfe2e3b](https://github.com/mabuenox/cc-suricata/commit/bfe2e3be3d579dd52235773fc342fedeb07ee289))

## [0.2.0](https://github.com/mabuenox/cc-suricata/compare/v0.1.1...v0.2.0) (2026-11-04)


### Features

* notifications and VS Code on macOS and Linux ([1bddc3d](https://github.com/mabuenox/cc-suricata/commit/1bddc3d7334555de4544163468ea84cab5f03959))


### Bug Fixes

* show a session waiting on a permission prompt as "Asking you" ([c1d5de1](https://github.com/mabuenox/cc-suricata/commit/c1d5de1da9c2b121c7a2c5c19c66f926c3d5c8d2))

## 0.1.1 (2026-11-04)


### Features

* interface, notifications and screenshots in English ([2656882](https://github.com/mabuenox/cc-suricata/commit/2656882776acbfa052e3d2a492a145aaf9bb8b64))
* recent closed sessions with resume command, and a per-session timeline ([a315c25](https://github.com/mabuenox/cc-suricata/commit/a315c2598873748bc9d049fa7d1eebdf7af05a50))


### Bug Fixes

* an unexpected error reading the git branch is logged instead of swallowed ([b2303e0](https://github.com/mabuenox/cc-suricata/commit/b2303e07e358087bd32788588a3598758abd0d3e))
* evict resumed sessions from the closed cache, 404 on a missing transcript, no timeline clipping ([ed0b22b](https://github.com/mabuenox/cc-suricata/commit/ed0b22b140d01657c24c55c6375c7578852d1811))
* git branch on macOS/Linux, '' instead of null, TaskStop without id no longer hides background tasks ([b6c8f01](https://github.com/mabuenox/cc-suricata/commit/b6c8f0170bc7b793a5686c0407b99418726f0edc))


### Continuous Integration

* release-please and npm trusted publishing ([3086e20](https://github.com/mabuenox/cc-suricata/commit/3086e20733210f5fecaaa38c0c17d7314137d61b))
