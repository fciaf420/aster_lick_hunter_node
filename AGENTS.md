# Repository Guidelines

## Project Structure & Module Organization
- `src/` holds all runtime code. Bot logic lives under `src/lib/bot/` (e.g., `hunter.ts`, `positionManager.ts`), shared services in `src/lib/services/`, and HTTP handlers in `src/app/api/`.
- Frontend components are in `src/components/`; Next.js routes and pages follow `src/app/<route>`.
- The configuration template is `config.default.json`; live config files (`config.user.json`, backups) stay untracked.
- Tests reside in `tests/` (grouped by area: `core/`, `api/`, `components/`, `integration/`, `lib/`), while database artifacts are stored under `data/` (ignored in Git).

## Build, Test, and Development Commands
- `npm run dev` – launches the Next.js UI and bot in watch mode via the process manager.
- `npm run build` – creates a production bundle (`next build`).
- `npm run start` – runs the built artifacts for production-style validation.
- `npm run lint` – executes ESLint across the project; `npx tsc --noEmit` checks types.
- `npm test` – runs every suite via `tests/run-all.ts`; targeted suites: `npm run test:hunter`, `test:position`, `test:rate`, `test:ws`, `test:errors`, `test:integration`.
- `npm run optimize:ui` – runs the configuration optimizer (`optimize-config.js`).

## Coding Style & Naming Conventions
- TypeScript/JavaScript only; tab width is two spaces. Match the surrounding code and ESLint config (semicolons, single quotes).
- Use descriptive camelCase for variables/functions, PascalCase for classes/components, and kebab-case for new file names.
- Keep modules focused: prefer exporting pure helpers from `src/lib/utils/` and side-effect code from service/bot directories.

## Testing Guidelines
- Tests use `tsx` runners with assert-style checks; name files `<feature>.test.ts` in the matching `tests/<area>/` folder.
- Aim to cover liquidation handling, cooldown enforcement, and optimizer regressions when touching related code.
- Prefer deterministic fixtures; stub network/database calls with in-memory mocks where possible.

## Commit & Pull Request Guidelines
- Commit messages follow the short, imperative style already in history (e.g., "Sync bot trading updates and tooling patches").
- Squash noisy local commits before opening PRs. Reference ticket IDs in the title or first line when relevant.
- PRs should describe the change, list validation steps (`npm run lint`, tests), and include screenshots or sample logs for UI/bot behavior changes.

## Security & Configuration Tips
- Never commit live secrets; `.env*` and `config.user.json` are ignored on purpose. Use `.env.local` for local overrides.
- `patch-package` still runs after installs (via `postinstall`) but there are currently no patches. The old `proxy-from-env` patch was dropped because axios >= 1.20 depends on `proxy-from-env` 2.x, which already parses URLs with the WHATWG `URL` class instead of `url.parse`. Any new patch placed in `patches/` is applied automatically.
- axios >= 1.20 sends HTTPS requests through `HTTPS_PROXY`/`https_proxy` with an HTTP CONNECT tunnel (`https-proxy-agent`), always bypasses the proxy for loopback hosts, and no longer reads `npm_config_*proxy`. Earlier axios forwarded `GET https://host/path` to the proxy as a plaintext absolute-URI request. Operators running the bot behind a forward proxy must allow CONNECT to port 443; a proxy that only accepts absolute-URI forwarding will refuse every REST call at startup.
- React version note: `react`/`react-dom` are pinned to 19.3.x, but Next 15.5 serves App Router pages with its own vendored React (`node_modules/next/dist/compiled/react`, a 19.2 canary). APIs that exist only in 19.3 (`Activity`, `ViewTransition`, `addTransitionType`, `useEffectEvent`) type-check and pass jest yet are `undefined` at runtime in the real app, so `eslint.config.mjs` rejects them. Before using any newer React API, confirm it is exported by `node_modules/next/dist/compiled/react`; drop the lint rule only after upgrading to a Next release whose vendored React exports them.
- `package.json` carries an `overrides` entry that forces Next's bundled `postcss` (pinned to 8.4.31 upstream) up to 8.5.x for the security advisories. Remove it when upgrading to a Next release that ships a fixed `postcss`.
- Back up config files before running optimizers; the script writes `config.user.backup-<timestamp>.json` automatically.
