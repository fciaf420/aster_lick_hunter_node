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

## UI Components & Theme
- `src/components/ui` is synced from the shadcn `new-york-v4` registry. Primitives come from the unified `radix-ui` package (`import { Dialog as DialogPrimitive } from "radix-ui"`, `Slot.Root`), not individual `@radix-ui/react-*` packages, and `cn` lives in `@/lib/utils`. When pulling a newer upstream component, rewrite the registry aliases (`cn` -> `@/lib/utils`, `@/registry/new-york-v4/ui/*` -> `@/components/ui/*`) and diff against the old file first.
- Project-specific files in `ui/`: `sonner.tsx` (upstream Toaster plus GSAP slide-in animation, "Dismiss All" button and the position/expand/richColors/closeButton/gap/duration props), `ConfirmationModal.tsx` (built on Dialog/Button) and `password-strength.tsx` (strength meter built on Progress). Keep their customisations when refreshing.
- Colours come from the CSS variables in `src/app/globals.css` (oklch, light and dark): zinc neutrals plus one blue accent. Do not hard-code `green-*`/`red-*` for trading semantics; use the tokens: `text-profit` / `text-loss` for PnL sign and good/bad status, `text-long` / `text-short` for position or liquidation side, `text-destructive` for danger/severity, `bg-profit/10 border-profit/20` for tinted pills, and `fill="var(--profit)"` or `var(--chart-1..5)` inside Recharts. Both profit and loss tokens keep at least 4.5:1 contrast on background, card and muted surfaces in both modes.
- The `LiquidationSidebar` event cards keep literal `rgb()`/`rgba()` strings for their inline background/border and GSAP tweens (Tailwind green-500/red-500 values), because GSAP cannot interpolate `var()` or `color-mix()` values; its text, icons and shadows use the `long`/`short` tokens.
- Gotchas from the upstream components: `AlertDialogAction`/`AlertDialogCancel` are `Button asChild`, and Radix `Slot` concatenates class names without tailwind-merge, so pick the look with `variant`/`size` props (`<AlertDialogAction variant="destructive">`) instead of overriding `bg-*` through `className`. `TabsList` sets its height through `group-data-[orientation=horizontal]/tabs:h-9`, so override it with `group-data-[orientation=horizontal]/tabs:h-7`, not plain `h-7`. `Switch` takes a `size` prop. A single `TooltipProvider` wraps the app in `src/app/layout.tsx`; `Tooltip` no longer creates its own.

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
