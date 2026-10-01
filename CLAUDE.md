# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

Base template for Ronald's projects. Spanish is the working language.

**The parent `../CLAUDE.md` (Astro project) does NOT apply here.** This repo is a separate Next.js app nested inside that folder; ignore its Astro/`astro dev` instructions.

## Commands

```sh
npm run dev      # dev server (Turbopack) on http://localhost:3000
npm run build    # production build — the only full type check available
npm run lint     # ESLint (flat config, eslint.config.mjs)
npm test         # Vitest watch mode
npx vitest run path/to/file.test.ts  # single test file, one run
npx shadcn@latest add <component>   # add shadcn/ui components into components/ui/
```

Vitest runs in jsdom with Testing Library; `@/` alias resolved natively via `resolve.tsconfigPaths` (no vite-tsconfig-paths, no @vitejs/plugin-react — its latest version requires Babel 8 and conflicts with shadcn's Babel 7). Async Server Components can't be unit tested.

## Project rules: `docs/SETUP.md`

Read `docs/SETUP.md` before writing code. It is the source of truth for:
1. Folder structure — domain modules in `modules/<domain>/`, `app/` only routes, English names, naming conventions per file type.
2. Best practices — SOLID/DRY/KISS/YAGNI; before creating any component, hook or function, check it doesn't already exist in the project or in shadcn/ui.
3. Methodology — build mode vs SDD, spec template, reviewer checklist, which code needs unit tests.

## Workflow: SDD agents (`.claude/agents/`)

| Agent | Role |
|---|---|
| `orchestrator` | Classifies each request as **build** (small, clear change: ≤ 3 files, no new routes/API contracts) or **SDD**; plans, delegates, runs tasks in parallel when files don't overlap. Never writes code. |
| `spec` | Writes `docs/specs/<module>-<feature>.md` with a task plan (≤ 5 tasks / ~15 files per phase). Never approves specs. |
| `developer` | Implements an approved spec task or a build-mode change, with tests. Checks `Estado: aprobado` before touching files; never modifies `docs/specs/` (enforced by a hook in its frontmatter). |
| `reviewer` | Read-only. Validates against the spec/task and `docs/SETUP.md`; returns APROBADO or numbered OBSERVACIONES, looping with `developer` (max 3 cycles). |

Run the full flow with `claude --agent orchestrator` (it must be the main thread: subagents can't spawn subagents). Details in `docs/SETUP.md` §3.

**Human approval is a hard blocker.** No SDD implementation starts until the user writes exactly **"apruebo docs/specs/<slug>.md"** in the chat (bare "apruebo" or "apruebo <slug>" is rejected by the hook); a hook then changes its header from `Estado: borrador` to `Estado: aprobado` (the only two states) and logs who approved in `docs/specs/approvals.jsonl`, HMAC-signed with a per-machine key at `~/.claude/spec-approval.key` (unsigned/forged lines are ignored; approvals don't transfer between machines). After a successful approval the hook tells Claude to continue immediately with implementation following the orchestrator flow (`.claude/agents/orchestrator.md` §3 step 4: developer per task plan, then reviewer) — no second confirmation. Claude may only write specs with `Estado: borrador` (a Write/Edit hook blocks anything else) and never edits the ledger. This applies to every session, with or without the orchestrator: never infer approval, never mark a spec approved without the user's explicit answer, and any edit to an approved spec sends it back to `borrador`. Enforced by hooks in `.claude/settings.json` → `.claude/hooks/spec-approval.mjs` (tests: `npx vitest run .claude/hooks`): launching `developer` is blocked unless every spec its prompt cites has a logged approval and hasn't changed since (ticking plan checkboxes is fine), or the prompt declares `Modo: build`. Don't work around it. The user may edit code directly; these rules bind Claude.

## Stack

- Next.js 16 App Router (`app/`), React 19, TypeScript strict. Path alias `@/*` → repo root.
- Tailwind CSS v4 via `@tailwindcss/postcss`. No `tailwind.config.*` — theme tokens live in `app/globals.css` (`@theme inline` + CSS variables, `.dark` variant).
- shadcn/ui, style `base-nova`, built on **Base UI (`@base-ui/react`)**, not Radix. Icons: `lucide-react`. Config in `components.json`.
- `cn()` comes from the `cn` package (shadcn's replacement for clsx + tailwind-merge), re-exported from `lib/utils.ts`.
- Installed but not yet wired: axios, `@tanstack/react-query` (needs a `QueryClientProvider` client component in `app/layout.tsx` before use), `@tanstack/react-table` v9, zod v4, zustand v5.
- Next 16 typed route helpers are global (e.g. `LayoutProps<"/">`), generated into `.next/types` by dev/build.
