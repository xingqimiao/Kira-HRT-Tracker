# Verification record — 2026-10-25, application 2.2.2

The self-hosted edition shares the current application code, including the latest navigation/back fixes. Local acceptance and the tagged native release jobs passed.

This file records checks; installation instructions are in the [beginner guide](README.en.md) / [中文教程](README.md).

## setup.1 installation revision

- The archive keeps application image tags at 2.2.2 and uses a distinct `-setup.1.tar.gz` asset name. Original release assets, application tags and database format are unchanged.
- Six focused deployment/package tests passed, including certificate export, refusal to overwrite keys, backup/restore pairing, a separate revision asset name and exclusion of secrets from the archive. Shell syntax and PowerShell parsing passed.
- From a clean extracted directory, the new Shell `install` command started all three published services using an empty Docker authentication configuration. It exported the public LAN CA automatically; trusted HTTPS, SPA/API routing and registration/write/read passed. A second installation was refused with the configuration and master-key checksums unchanged.
- Native Windows PowerShell ran the same installation command against a real WSL Docker daemon; health, certificate export and the HTTPS/account/record smoke check passed. This validates command sequencing, not Docker Desktop's Windows filesystem/ACL behavior. Tests remapped only fixture ports to loopback to avoid existing host listeners, and stopped their containers afterwards.
- The release workflow now exercises `install` on future native dual-architecture runs. This installer revision was tested locally on AMD64; ARM64 application image acceptance below belongs to the original tagged release. Public ACME and real-phone certificate/PWA acceptance remain outside these local checks.

## Published release acceptance

- [Native release workflow 40116998904](https://github.com/xingqimiao/Kira-HRT-Tracker/actions/runs/40116998904) passed on both native AMD64 and ARM64 runners, including HTTPS, account/record checks, upgrade tooling, real backup/restore and publication. The first run exposed a temporary registry connection-reset race; the readiness probe now retries that error as well.
- The [self-hosted 2.2.2 archive](https://github.com/xingqimiao/Kira-HRT-Tracker/releases/tag/self-host-v2.2.2) was downloaded again and its checksum verified. From a fresh directory, the downloaded scripts initialized and started a new deployment using the published GHCR images; trusted HTTPS and registration/write/read passed.
- Both published images were pulled with an empty Docker authentication configuration. Users do not need to sign in to GitHub to deploy the default package. The standard [2.2.2 Android release](https://github.com/xingqimiao/Kira-HRT-Tracker/releases/tag/v2.2.2) remains the repository's latest release.

## Passed locally

- **61 backend tests and 4 deployment tests:** OCI compatibility, local key configuration, account lifecycle, records, sharing and the MCP protocol. Local-key tests cover real MCP SDK connections/tool calls, registration, sessions after restart, record reads/writes, key rotation, password changes and token revocation. Deployment tests additionally catch version drift between the application and source deployment.
- **AMD64 containers:** Docker 29.1.3 and Compose 2.40.3 on WSL Ubuntu 26.04. Fresh database and local key; all three services healthy; HTTPS verified using the generated CA, without disabling certificate validation; account/record roundtrip and API fallback rejection passed.
- **Real backup and recovery:** maintenance commands produced a PostgreSQL custom-format dump, backed up the matching key/configuration/CA, and restored into a new Compose project and new volumes. The original record and original session remained readable over trusted HTTPS.
- **ARM64 runtime through QEMU:** separately built ARM64 API/Caddy images and ARM64 PostgreSQL started successfully. The AMD64 backup was restored on ARM64; existing records/sessions and a new registration/write/read roundtrip passed. This is functional emulation, not a performance test on ARM hardware.
- **Wrong-key and upgrade checks:** replacing the test deployment's master key caused actual API startup to reject the database. Restoring the original key preserved the record/session. The upgrade command also passed registry pull, automatic backup, configuration change and health gating, with the original session retained. The upgrade baseline used the same application build under a synthetic older tag because this is the first self-hosted release.

## Build and release checks

- API bundle, self-hosted frontend, frontend TypeScript, shell syntax, PowerShell parsing, Compose configuration and public/LAN/IP Caddy configuration checks passed. The API builder now installs locked root dependencies needed by shared modules; an isolated Docker build exposed the previous missing dependency.
- Self-hosted CSP allows same-origin WebAssembly/OCR and excludes official-site integrations. Public CA export and CI file ownership/permissions were corrected using actual container results. Browser/phone certificate installation and PWA installation still require real-device acceptance; browser automation did not establish those checks.
- Updated the server's locked `body-parser` to 2.4.0 and added a dependency floor. The [upstream advisory](https://github.com/advisories/GHSA-27r3-jxmh-p828) identifies older versions as affected. The updated dependency audit reported zero vulnerabilities.
- The official Web build and both Android channels were rebuilt from current source. Both APKs verified v2/v3/v4 signatures with the existing certificate, package `com.kiramyao.hrt`, version `2.2.2` / `2002002`, ARM64. They replace the stale local 2.2.2 APKs.
- Official Web and the fresh standard APK were deployed with a server-side backup, assets/APK before HTML/manifest, and exact CDN purges. The public manifest returned 2.2.2 and the downloaded APK matched `8E134842EE0E1E25B25855EF5BE8FF42568261E0D176CEC6389552A5D1AD8C42`. The public web bundle reported v2.2.2.

## Boundaries

Native ARM64 GitHub-runner results are recorded by the successful tagged release workflow above. Public ACME issuance and phone CA/PWA installation are not established by local-CA container tests.

The full existing backend suite previously stopped at a `deltaSync.test.ts` process that did not exit; the passing count above is the selected suite, not the complete repository suite. The original release's backend TypeScript check reported three pre-existing errors. A later CodeQL fixture correction removed the `unlinkToctou.test.ts` type error; two existing `http.ts` errors remain in the avatar projection and credentials body type. The setup.1 revision changes no backend runtime code.
