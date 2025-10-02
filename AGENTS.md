# Repository Guidelines

## Project Structure & Module Organization
- `src/` holds all runtime code. Bot logic lives under `src/lib/bot/` (e.g., `hunter.ts`, `positionManager.ts`), shared services in `src/lib/services/`, and HTTP handlers in `src/app/api/`.
- Frontend components are in `src/components/`; Next.js routes and pages follow `src/app/<route>`.
- Configuration templates sit in `config.user.sample.json`; live config files (`config.user.json`, backups) stay untracked.
- Tests and simulations reside in `tests/`, while database artifacts are stored under `data/` (ignored in Git).

## Build, Test, and Development Commands
- `npm run dev` — launches the Next.js UI and bot in watch mode via the process manager.
- `npm run build` — creates a production bundle (`next build` + bot transpilation).
- `npm run start` — runs the built artifacts for production-style validation.
- `npm run lint` — executes ESLint across the project.
- `npm run test`, `npm run test:flow`, `npm run test:simulation` — targeted bot scenario suites; `npm run test:all` chains them.

## Coding Style & Naming Conventions
- TypeScript/JavaScript only; tab width is two spaces. Follow ESLint/Prettier defaults (no semicolons, trailing commas where valid).
- Use descriptive camelCase for variables/functions, PascalCase for classes/components, and kebab-case for new file names.
- Keep modules focused: prefer exporting pure helpers from `src/lib/utils/` and side-effect code from service/bot directories.

## Testing Guidelines
- Tests use `tsx` runners with assert-style checks; name files `test-<feature>.ts` in `tests/`.
- Aim to cover liquidation handling, cooldown enforcement, and optimizer regressions when touching related code.
- Prefer deterministic fixtures; stub network/database calls with in-memory mocks where possible.

## Commit & Pull Request Guidelines
- Commit messages follow the short, imperative style already in history (e.g., "Sync bot trading updates and tooling patches").
- Squash noisy local commits before opening PRs. Reference ticket IDs in the title or first line when relevant.
- PRs should describe the change, list validation steps (`npm run lint`, tests), and include screenshots or sample logs for UI/bot behavior changes.

## Security & Configuration Tips
- Never commit live secrets; `.env*` and `config.user.json` are ignored on purpose. Use `.env.local` for local overrides.
- Run `patch-package` after installs (handled by `postinstall`) so proxy settings stay hardened (see `patches/`).
- Back up config files before running optimizers; the script writes `config.user.backup-<timestamp>.json` automatically.
