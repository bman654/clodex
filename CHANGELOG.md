# Changelog

## [2.10.0](https://github.com/bman654/clodex/compare/v2.9.0...v2.10.0) (2026-09-04)


### Features

* **openai:** reduce the risk of rate-limit errors when many agents run at once ([#172](https://github.com/bman654/clodex/issues/172)) ([28be454](https://github.com/bman654/clodex/commit/28be454332169a220144387c9ad8b950f260e2e5))


### Bug Fixes

* **openai:** stop long sessions on OpenAI models dying with "Prompt is too long" ([#167](https://github.com/bman654/clodex/issues/167)) ([a6fddd9](https://github.com/bman654/clodex/commit/a6fddd9d087241326894adc29ff7dc46e8bb0040))

## [2.9.0](https://github.com/bman654/clodex/compare/v2.8.5...v2.9.0) (2026-09-04)


### Features

* **timeouts:** let you raise the 10-minute limit so long agent runs can finish ([#171](https://github.com/bman654/clodex/issues/171)) ([369930a](https://github.com/bman654/clodex/commit/369930a579932a89f85511b68e10596975297bf1))


### Bug Fixes

* **patch:** restore Claude Code patching on 2.1.260, broken on every platform ([#175](https://github.com/bman654/clodex/issues/175)) ([00f793a](https://github.com/bman654/clodex/commit/00f793af94dcfba1fdec6554581ead58a2147e16))

## [2.8.5](https://github.com/bman654/clodex/compare/v2.8.4...v2.8.5) (2026-09-02)


### Bug Fixes

* **patch:** refuse an unfamiliar Claude Code build instead of rewriting the wrong bytes ([#164](https://github.com/bman654/clodex/issues/164)) ([33c00d5](https://github.com/bman654/clodex/commit/33c00d5056eaf68e7b0e1774c76e0adc6cee0d57))

## [2.8.4](https://github.com/bman654/clodex/compare/v2.8.3...v2.8.4) (2026-09-01)


### Bug Fixes

* **patch:** restore Claude Code patching on 2.1.257, broken on every platform ([#159](https://github.com/bman654/clodex/issues/159)) ([d3c4873](https://github.com/bman654/clodex/commit/d3c4873c1d00bf77ff321de9a872b1dc8d31e467))
* **proxy:** report a broken NODE_EXTRA_CA_CERTS instead of silently ignoring it ([#160](https://github.com/bman654/clodex/issues/160)) ([70c4580](https://github.com/bman654/clodex/commit/70c45804a2fa77a43af6fa1d4233103b3464c8cb))
* **proxy:** retry a dropped Anthropic connection instead of failing the request ([#161](https://github.com/bman654/clodex/issues/161)) ([c3dd0bb](https://github.com/bman654/clodex/commit/c3dd0bb0685ee79f77264a4055a5b067a9673d25))

## [2.8.3](https://github.com/bman654/clodex/compare/v2.8.2...v2.8.3) (2026-08-27)


### Bug Fixes

* **openai:** let a garbled tool call be retried instead of run with invented arguments ([#156](https://github.com/bman654/clodex/issues/156)) ([0d96089](https://github.com/bman654/clodex/commit/0d960899321acf8d2fbb9ab0e451be2a7f3875db))
* **openai:** prevent nested agents from being forced into worktrees ([#153](https://github.com/bman654/clodex/issues/153)) ([47f9ae5](https://github.com/bman654/clodex/commit/47f9ae57f26d6531e1001b062126ae830eb812ac))

## [2.8.2](https://github.com/bman654/clodex/compare/v2.8.1...v2.8.2) (2026-08-26)


### Bug Fixes

* **auth:** stop blaming a closed browser when sign-in was completed in an older tab ([7812a78](https://github.com/bman654/clodex/commit/7812a78e832e61da51be60280853c48ba3277219))
* **auth:** stop blaming another sign-in when a busy port blocks browser sign-in ([0b239fa](https://github.com/bman654/clodex/commit/0b239fa20a7a34cdee76e72aa6a6b2605c40e19c))
* **patch:** restore patching on Claude Code 2.1.246, where the patch was lost or crashed claude ([6a3b627](https://github.com/bman654/clodex/commit/6a3b627eabad518c22aec1ab20afff3285a36a5c))

## [2.8.1](https://github.com/bman654/clodex/compare/v2.8.0...v2.8.1) (2026-08-25)


### Bug Fixes

* **patch:** restore custom model aliases on Claude Code 2.1.242 and newer ([#144](https://github.com/bman654/clodex/issues/144)) ([7775dd5](https://github.com/bman654/clodex/commit/7775dd5cbee47d4b1f5a860c5570d52035c0a6ba))

## [2.8.0](https://github.com/bman654/clodex/compare/v2.7.0...v2.8.0) (2026-08-23)


### Features

* **auth:** add browser sign-in for workspaces that disable device codes ([#141](https://github.com/bman654/clodex/issues/141)) ([6db13fa](https://github.com/bman654/clodex/commit/6db13fa2197b2e7ddea9f6196210fa9dd4babe8e))

## [2.7.0](https://github.com/bman654/clodex/compare/v2.6.3...v2.7.0) (2026-08-21)


### Features

* **models:** choose a context stop against a provider pricing boundary ([#131](https://github.com/bman654/clodex/issues/131)) ([6e14ba9](https://github.com/bman654/clodex/commit/6e14ba9f8d851ce81c35c06c39fd569bd0c0273c))

## [2.6.3](https://github.com/bman654/clodex/compare/v2.6.2...v2.6.3) (2026-08-21)


### Bug Fixes

* **patch:** restore patching on Claude Code 2.1.239 so model aliases and effort settings work again ([#135](https://github.com/bman654/clodex/issues/135)) ([8c7007c](https://github.com/bman654/clodex/commit/8c7007c869945c22b1764a2f29f52a4460f7bf27))

## [2.6.2](https://github.com/bman654/clodex/compare/v2.6.1...v2.6.2) (2026-08-21)


### Bug Fixes

* **patch:** restore your models in Claude Code 2.1.238's picker on ARM64 Linux and Windows ([#133](https://github.com/bman654/clodex/issues/133)) ([131907a](https://github.com/bman654/clodex/commit/131907a31440c1f80cadce4fa0db6bb9407e3fd4))

## [2.6.1](https://github.com/bman654/clodex/compare/v2.6.0...v2.6.1) (2026-08-18)


### Bug Fixes

* **patch:** keep your own local patch text intact when clodex patches Claude Code ([#128](https://github.com/bman654/clodex/issues/128)) ([af53204](https://github.com/bman654/clodex/commit/af532042ef106d2384bfe40c269349d92680bf00))
* **patch:** make clodex patch work again on Linux so model aliases and effort settings apply ([#126](https://github.com/bman654/clodex/issues/126)) ([24c86d3](https://github.com/bman654/clodex/commit/24c86d3a9a749d595d434c72362815e7a6425c55))

## [2.6.0](https://github.com/bman654/clodex/compare/v2.5.2...v2.6.0) (2026-08-13)


### Features

* **providers:** add OpenCode Go so you can use its 17 models in Claude Code ([c38e3c5](https://github.com/bman654/clodex/commit/c38e3c564f37d7213407f2f18583c79f99711c60))

## [2.5.2](https://github.com/bman654/clodex/compare/v2.5.1...v2.5.2) (2026-08-13)


### Bug Fixes

* **patch:** restore patching on Claude Code 2.1.231 so aliases and effort settings work again ([#122](https://github.com/bman654/clodex/issues/122)) ([80b3d16](https://github.com/bman654/clodex/commit/80b3d16d180348c138d83a7d9eb9f18efdc3115f))

## [2.5.1](https://github.com/bman654/clodex/compare/v2.5.0...v2.5.1) (2026-08-12)


### Bug Fixes

* **patch:** restore patching on Claude Code 2.1.228 so model aliases work again ([#118](https://github.com/bman654/clodex/issues/118)) ([e996623](https://github.com/bman654/clodex/commit/e996623db711e0b6aaf21a033a28bc46abfcdc3e))

## [2.5.0](https://github.com/bman654/clodex/compare/v2.4.0...v2.5.0) (2026-08-11)


### Features

* **auth:** add multi-account OAuth selection ([#98](https://github.com/bman654/clodex/issues/98)) ([1683b2c](https://github.com/bman654/clodex/commit/1683b2c3d1e0e6c5b1976f91395c8f53a4441d68))
* **oauth:** add service-tier fast mode ([#97](https://github.com/bman654/clodex/issues/97)) ([8a01696](https://github.com/bman654/clodex/commit/8a016962a0206f98e01cb4425767502b708b1608))


### Bug Fixes

* **launch:** deliver parent diagnostics that the Claude Code mute swallowed ([#112](https://github.com/bman654/clodex/issues/112)) ([9832c11](https://github.com/bman654/clodex/commit/9832c117002240a81a7a886dcd462b25ca022c63))
* **proxy:** honor outbound proxy for raw passthrough ([#92](https://github.com/bman654/clodex/issues/92)) ([f8d017c](https://github.com/bman654/clodex/commit/f8d017c92b06ba69528d4e8b594879c4c8ec669e))
* **proxy:** isolate bridge settings from child commands ([#78](https://github.com/bman654/clodex/issues/78)) ([f0a0b87](https://github.com/bman654/clodex/commit/f0a0b87614404744aae0ad74e8cf9ce85aabbc2d))

## [2.4.0](https://github.com/bman654/clodex/compare/v2.3.0...v2.4.0) (2026-08-10)


### Features

* **providers:** support mixed-protocol metadata ([067492f](https://github.com/bman654/clodex/commit/067492ff28d7d3166212754b53d24d406043a8fd))
* **providers:** support mixed-protocol metadata ([f2126c3](https://github.com/bman654/clodex/commit/f2126c3048161bf8c4da8e1693704c6cbf07b2ae))


### Bug Fixes

* **env:** bypass the proxy for the loopback gateway in endpoint mode ([#106](https://github.com/bman654/clodex/issues/106)) ([69f61ff](https://github.com/bman654/clodex/commit/69f61ffd01a50ab1d52bd371109ba013580ec22b))
* **transport:** classify usage-limit terminals ([#96](https://github.com/bman654/clodex/issues/96)) ([0b0018a](https://github.com/bman654/clodex/commit/0b0018a6c1799028d31b7462ca39a4fc379ed955))

## [2.3.0](https://github.com/bman654/clodex/compare/v2.2.2...v2.3.0) (2026-08-09)


### Features

* **oauth:** omitted-reasoning alignment and abandoned-head canary coverage ([#91](https://github.com/bman654/clodex/issues/91)) ([c0e6c04](https://github.com/bman654/clodex/commit/c0e6c04623cdbbb675c043e24d9b52aa26eb0baf))
* **oauth:** warn on stderr when the tool-argument strip rule forks ([#89](https://github.com/bman654/clodex/issues/89)) ([827215a](https://github.com/bman654/clodex/commit/827215a8dcbad8d0cfc1f3f59a8087a5df5dc97b))


### Bug Fixes

* **proxy:** make upstream retry budget configurable ([#82](https://github.com/bman654/clodex/issues/82)) ([f585c7b](https://github.com/bman654/clodex/commit/f585c7b47c9264b2cd4639de2deb23b4a19e84bd))
* **sdk:** strip the volatile Claude Code billing header on every translated route ([#93](https://github.com/bman654/clodex/issues/93)) ([db8d0cb](https://github.com/bman654/clodex/commit/db8d0cbafd0719a5a00160aab1be6dac4dd7db78))
* **transport:** replay control-only socket failures ([#83](https://github.com/bman654/clodex/issues/83)) ([7ff2114](https://github.com/bman654/clodex/commit/7ff2114e04a555e3d538fa10cd6a9de897c6b22b))

## [2.2.2](https://github.com/bman654/clodex/compare/v2.2.1...v2.2.2) (2026-08-07)


### Bug Fixes

* **oauth:** snapshot function_call arguments in the sanitized downstream shape ([#80](https://github.com/bman654/clodex/issues/80)) ([7c2d1fd](https://github.com/bman654/clodex/commit/7c2d1fdfe40d6cd61bcafebf6935bec6d13b81d7))

## [2.2.1](https://github.com/bman654/clodex/compare/v2.2.0...v2.2.1) (2026-08-07)


### Bug Fixes

* **patcher:** accept the 2.1.224 minified Agent-tool model enum shape ([#85](https://github.com/bman654/clodex/issues/85)) ([2ec0916](https://github.com/bman654/clodex/commit/2ec0916dfdf7d594b4ef4242a6b6c19091291d86))

## [2.2.0](https://github.com/bman654/clodex/compare/v2.1.9...v2.2.0) (2026-08-07)


### Features

* **patcher:** add opt-in local patch extensions ([#75](https://github.com/bman654/clodex/issues/75)) ([785871d](https://github.com/bman654/clodex/commit/785871d9c5741233f176f6f00b0f7d19f4d235b7))


### Bug Fixes

* **deps:** bump undici to 7.29.0 ([#76](https://github.com/bman654/clodex/issues/76)) ([54621d1](https://github.com/bman654/clodex/commit/54621d1406c86c6b3dd14f799b2e933258057e0a))

## [2.1.9](https://github.com/bman654/clodex/compare/v2.1.8...v2.1.9) (2026-08-02)


### Performance Improvements

* **oauth:** canonicalize conversation items once per request, not per head ([#73](https://github.com/bman654/clodex/issues/73)) ([7acc070](https://github.com/bman654/clodex/commit/7acc070003907c7bcafb815cb2e5754418913914))

## [2.1.8](https://github.com/bman654/clodex/compare/v2.1.7...v2.1.8) (2026-08-02)


### Bug Fixes

* **oauth:** match reasoning heads on the encrypted blob, and make the connection pools configurable ([#71](https://github.com/bman654/clodex/issues/71)) ([32a82c2](https://github.com/bman654/clodex/commit/32a82c29a99d32c3520e2c4e814af70f2fb5a942))

## [2.1.7](https://github.com/bman654/clodex/compare/v2.1.6...v2.1.7) (2026-08-02)


### Bug Fixes

* **oauth:** continue chains when a reasoning item carries empty content ([#69](https://github.com/bman654/clodex/issues/69)) ([5cdd063](https://github.com/bman654/clodex/commit/5cdd063159a4073ace55abfc7b88f7fa6a9e2ebd))

## [2.1.6](https://github.com/bman654/clodex/compare/v2.1.5...v2.1.6) (2026-07-29)


### Bug Fixes

* **oauth:** surface in-band request rejections instead of an empty 200 ([#67](https://github.com/bman654/clodex/issues/67)) ([d512065](https://github.com/bman654/clodex/commit/d5120656f9c80518f150bbf3193eb781f27d6df9))
* **reasoning:** suppress reasoning.summary for gpt-5.3-codex-spark ([#65](https://github.com/bman654/clodex/issues/65)) ([b455916](https://github.com/bman654/clodex/commit/b455916d117398ba0635f551180f899ec5a660be))
* recover provider message and status from mid-stream error frames ([#68](https://github.com/bman654/clodex/issues/68)) ([5b138e4](https://github.com/bman654/clodex/commit/5b138e4bf9390c610b578a294e697216f2bb8d49))

## [2.1.5](https://github.com/bman654/clodex/compare/v2.1.4...v2.1.5) (2026-07-27)


### Bug Fixes

* canonicalize aliases without unsafe fallback ([#59](https://github.com/bman654/clodex/issues/59)) ([5fec19a](https://github.com/bman654/clodex/commit/5fec19a1c399491259e25b5b34cf447f95fbd08d))
* **patcher:** include transform-set version in patch config hash ([#60](https://github.com/bman654/clodex/issues/60)) ([09f79ad](https://github.com/bman654/clodex/commit/09f79ad968dbd5b3d53c8b4d9a43b3d2cbe1011d))
* **patcher:** resolve claude version from the binary being patched ([#62](https://github.com/bman654/clodex/issues/62)) ([164be9d](https://github.com/bman654/clodex/commit/164be9d2ef99f4cd81473ebdf3a42818f2994cc2))
* preserve extended effort levels in patched clients ([#57](https://github.com/bman654/clodex/issues/57)) ([e61f972](https://github.com/bman654/clodex/commit/e61f9725d14784fffebf26add13c3cc6fa1945ec))

## [2.1.4](https://github.com/bman654/clodex/compare/v2.1.3...v2.1.4) (2026-07-27)


### Bug Fixes

* **adapter:** prevent cached input usage inflation ([#56](https://github.com/bman654/clodex/issues/56)) ([4d96f54](https://github.com/bman654/clodex/commit/4d96f5462c793fcf9e1677d07aedc8fe2cc954bd))
* **proxy:** reuse private adapter connections ([#54](https://github.com/bman654/clodex/issues/54)) ([6de7af9](https://github.com/bman654/clodex/commit/6de7af96b957630dc2a4ea1fc7cfdd7481501685))

## [2.1.3](https://github.com/bman654/clodex/compare/v2.1.2...v2.1.3) (2026-07-25)


### Bug Fixes

* **wrapper:** exec into claude so background pty resizes reach it ([#51](https://github.com/bman654/clodex/issues/51)) ([73661d6](https://github.com/bman654/clodex/commit/73661d672cdbc2d2f2ccdc1b808a3b80d4811338))

## [2.1.2](https://github.com/bman654/clodex/compare/v2.1.1...v2.1.2) (2026-07-25)


### Bug Fixes

* **auth:** make chunked credentials crash-safe ([#17](https://github.com/bman654/clodex/issues/17)) ([cae6db6](https://github.com/bman654/clodex/commit/cae6db6389bcae576ccc51f054937dfe4685b059))
* **wrapper:** retry transient listener checks ([#44](https://github.com/bman654/clodex/issues/44)) ([de233d8](https://github.com/bman654/clodex/commit/de233d8c00aa12c55405ad12b9e9740988e8ee38))

## [2.1.1](https://github.com/bman654/clodex/compare/v2.1.0...v2.1.1) (2026-07-24)


### Bug Fixes

* **logging:** attribute proxy transport failures ([#43](https://github.com/bman654/clodex/issues/43)) ([5bff8dd](https://github.com/bman654/clodex/commit/5bff8ddb05c1fbd15760ea51791f71ac8eb94a77))

## [2.1.0](https://github.com/bman654/clodex/compare/v2.0.0...v2.1.0) (2026-07-24)


### Features

* **logging:** correlate response lifecycles ([#26](https://github.com/bman654/clodex/issues/26)) ([2de8cf8](https://github.com/bman654/clodex/commit/2de8cf8393f1f4bba867a05a0f22cec03acd6597))


### Bug Fixes

* **routing:** prevent configured route bypasses ([#10](https://github.com/bman654/clodex/issues/10)) ([383f464](https://github.com/bman654/clodex/commit/383f46461ddea28ee42e63bf6c52b1507f4ab4c5))

## [2.0.0](https://github.com/bman654/clodex/compare/v1.3.0...v2.0.0) (2026-07-24)


### ⚠ BREAKING CHANGES

* remove legacy ~/.relay-ai migration support ([#37](https://github.com/bman654/clodex/issues/37))

### Features

* remove legacy ~/.relay-ai migration support ([#37](https://github.com/bman654/clodex/issues/37)) ([6a7b5cf](https://github.com/bman654/clodex/commit/6a7b5cf35552b042a5b7b1b555be7c4eb51ec7d8))


### Bug Fixes

* **config:** serialize and atomically write preferences ([#40](https://github.com/bman654/clodex/issues/40)) ([e653d89](https://github.com/bman654/clodex/commit/e653d8939ce3244e50d65f0993579df156b02afd))
* **oauth:** treat websocket_connection_limit_reached as a retryable limit ([#38](https://github.com/bman654/clodex/issues/38)) ([32c1f7b](https://github.com/bman654/clodex/commit/32c1f7b552a20869e0a08ba79de09b5c1a1e1143))
* **providers:** reconcile credential cleanup for interactive hub mutations ([#39](https://github.com/bman654/clodex/issues/39)) ([102e496](https://github.com/bman654/clodex/commit/102e496a4b7c11430f4c215ccc9b218d19e5f020))
* **trace:** redact resolved credentials from trace logs by value ([#35](https://github.com/bman654/clodex/issues/35)) ([46d4818](https://github.com/bman654/clodex/commit/46d4818afdd9285c5beec66e31dc39089b1f61f0))

## [1.3.0](https://github.com/bman654/clodex/compare/v1.2.2...v1.3.0) (2026-07-24)


### Features

* **logging:** record proxy process lifecycle ([#30](https://github.com/bman654/clodex/issues/30)) ([495684c](https://github.com/bman654/clodex/commit/495684c63544c8d7b74ece0041585554157de427))


### Bug Fixes

* **auth:** make credential cleanup crash-safe ([#15](https://github.com/bman654/clodex/issues/15)) ([9657038](https://github.com/bman654/clodex/commit/96570383c82d0e92298909c1b6c75a28820335dd))
* **auth:** recover once from rejected access tokens ([#16](https://github.com/bman654/clodex/issues/16)) ([f9272d6](https://github.com/bman654/clodex/commit/f9272d60adafdf904f97ddae06f910bfd93b706b))
* **oauth:** map upstream 403 throttle to retryable 429 ([#33](https://github.com/bman654/clodex/issues/33)) ([303db6e](https://github.com/bman654/clodex/commit/303db6eb8bffd15004c0b69105cfe3cf95e22572))
* **transport:** retry pre-frame websocket failures ([#29](https://github.com/bman654/clodex/issues/29)) ([8485e1c](https://github.com/bman654/clodex/commit/8485e1c757cf8c23d9ceaa215977871dacda191b))

## [1.2.2](https://github.com/bman654/clodex/compare/v1.2.1...v1.2.2) (2026-07-23)


### Bug Fixes

* **auth:** enforce anonymous credential boundaries ([#21](https://github.com/bman654/clodex/issues/21)) ([d4ec9e2](https://github.com/bman654/clodex/commit/d4ec9e2b02f5203efad77eb21cf735c13feab8a0))
* **server:** wait for listener readiness ([#23](https://github.com/bman654/clodex/issues/23)) ([77ae2bf](https://github.com/bman654/clodex/commit/77ae2bf57e92dce4adb61efe4be3b79323b060d8))

## [1.2.1](https://github.com/bman654/clodex/compare/v1.2.0...v1.2.1) (2026-07-23)


### Bug Fixes

* **patcher:** pin node-gyp-build directly to unbreak fresh installs ([94aeab8](https://github.com/bman654/clodex/commit/94aeab8910d93da8dc3fa1dd0402b24b1faa3601))

## [1.2.0](https://github.com/bman654/clodex/compare/v1.1.0...v1.2.0) (2026-07-22)


### Features

* **auth:** harden credential and registry handling ([#8](https://github.com/bman654/clodex/issues/8)) ([502450c](https://github.com/bman654/clodex/commit/502450c42c4a6359307853a86dd5a33ed0aa5980))


### Bug Fixes

* **adapter:** deliver tool_result images as vision parts instead of base64 text ([#22](https://github.com/bman654/clodex/issues/22)) ([ac48a3b](https://github.com/bman654/clodex/commit/ac48a3b50ed8a6e58f6433ec8a64ba939036b776))

## [1.1.0](https://github.com/bman654/clodex/compare/v1.0.4...v1.1.0) (2026-07-21)


### Features

* **wrapper:** add opt-in readiness enforcement ([#12](https://github.com/bman654/clodex/issues/12)) ([e590981](https://github.com/bman654/clodex/commit/e5909812cfef7110c800aa39e1cf037df403815a))


### Bug Fixes

* **transport:** isolate connections by credential ([#9](https://github.com/bman654/clodex/issues/9)) ([b770db6](https://github.com/bman654/clodex/commit/b770db6fb6f406a0b18919e8e297c123ed612526))
* **transport:** terminate rejected connection upgrades ([#11](https://github.com/bman654/clodex/issues/11)) ([904b077](https://github.com/bman654/clodex/commit/904b07731c6440c6f9c81daa7ac6d3d67e41061e))

## [1.0.4](https://github.com/bman654/clodex/compare/v1.0.3...v1.0.4) (2026-07-20)


### Bug Fixes

* **proxy:** keepalive pings while buffering tool-call args to survive client idle abort ([ede161e](https://github.com/bman654/clodex/commit/ede161e9ecbb9e11a01c713bdd5ceafd51203ebf))

## [1.0.3](https://github.com/bman654/clodex/compare/v1.0.2...v1.0.3) (2026-07-20)


### Bug Fixes

* **adapter:** strip null/empty-array filler from optional tool params ([105dde5](https://github.com/bman654/clodex/commit/105dde5ef6b62e72bdddaffcf2109fa1ab13c1ab))

## [1.0.2](https://github.com/bman654/clodex/compare/v1.0.1...v1.0.2) (2026-07-20)


### Bug Fixes

* **test:** wait for terminal log event in http-proxy passthrough test to fix CI flake ([b683631](https://github.com/bman654/clodex/commit/b68363166b92a805f468760bec4a92d215122829))

## [1.0.1](https://github.com/bman654/clodex/compare/v1.0.0...v1.0.1) (2026-07-20)


### Bug Fixes

* **patcher:** replace unpinned npx tweakcc with pinned programmatic API ([bfb626f](https://github.com/bman654/clodex/commit/bfb626fd0afeeeec4e6715d2fd9a8fd85cb4ae5f))

## [1.0.0](https://github.com/bman654/clodex/compare/v0.1.1...v1.0.0) (2026-07-20)


### Documentation

* refine README wording and add proxy/agents tips ([614ea7d](https://github.com/bman654/clodex/commit/614ea7d7daf7e0a58eaa5c7341ad5e42c86751ef))

## [0.1.1](https://github.com/bman654/clodex/compare/v0.1.0...v0.1.1) (2026-07-20)


### Features

* **patch:** make short aliases the model identity and use real model labels ([1eda5f1](https://github.com/bman654/clodex/commit/1eda5f17468b9d71018c39e30f309f12e9faa444))
* **server:** multi-server discovery, --no-discovery opt-out, endpoint alias resolution ([cfe91f5](https://github.com/bman654/clodex/commit/cfe91f5ed08af0ebc36d150e2d8d67d44309d549))

## [0.1.0] - 2026-07-19

Initial release of **clodex**, a fork of the original relay-ai project, heavily modified and streamlined to do one thing: bridge Claude Code to OpenAI models (OpenAI API key and ChatGPT/Codex-plan OAuth). The full relay-ai commit history is preserved in this repository.

### Kept from relay-ai (battle-tested subsystems, unchanged)

- Anthropic ↔ OpenAI translation through the Vercel AI SDK adapter, including prompt-cache breakpoint mapping and cache-token accounting.
- ChatGPT/Codex OAuth Responses WebSocket continuation (`previous_response_id` incremental input with exact-prefix chain heads and safe full-context fallback).
- Endpoint bridge mode (local Anthropic-format gateway + `ANTHROPIC_BASE_URL`) with the multi-route favorites switch menu.
- Proxy bridge mode (selective `api.anthropic.com` MITM) with the alias response-model echo that keeps Claude Code's auto-compaction working.
- Favorites/alias management (`clodex models`) and the foreground gateway (`clodex server`, endpoint + proxy modes, `--port`).

### New in the fork

- Rebrand: `clodex` binary/package, `~/.clodex` config home (`CLODEX_HOME` override), `clodex:` model-id prefix, `clodex` keychain service — with silent one-time migration from legacy `~/.relay-ai` config and `relay-ai` keychain entries (legacy data is never modified).
- `clodex patch` — first-class Claude Code binary patcher built on tweakcc: bakes favorites + aliases into the binary (model validation, `/model` listing, alias resolution, real context windows), with a pristine per-version backup, a staleness manifest, a concurrency lock, and `--restore`.
- Launch-time patch freshness check in `clodex claude` (interactive y/N offer; non-blocking notice when non-interactive).
- Per-command bridge-mode defaults: `--endpoint`/`--proxy` select the mode for one run; `--save-mode` persists it as that command's default; bare runs default to proxy mode.

### Removed relative to relay-ai

All non-Claude-Code launch targets and non-OpenAI providers: the web UI, Codex/ChatGPT app and Gemini CLI launchers, Antigravity gateway, Claude Desktop setup, Vertex mode, OpenCode/Zen/Go backends and subscription tiers, and all other provider registries/templates.
