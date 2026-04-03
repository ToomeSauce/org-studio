# Contributing to Org Studio

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
# Clone the repo
git clone https://github.com/ToomeSauce/org-studio.git
cd org-studio

# Install dependencies
npm install

# Copy example data and config
cp data/store.example.json data/store.json
cp .env.example .env.local

# Start dev server
npm run dev
```

Open [http://localhost:4501](http://localhost:4501) in your browser.

## Project Structure

```
src/
├── app/              # Next.js pages and API routes
│   ├── api/          # Backend: store, scheduler, memory, docs, gateway
│   ├── team/         # Team page (force graph, cards, values)
│   ├── context/      # Task kanban board
│   ├── vision/       # Project management
│   ├── scheduler/    # Agent loop configuration
│   └── ...
├── components/       # Shared React components
├── lib/              # Core logic
│   ├── store.ts      # Data types, task helpers, prompt sections
│   ├── scheduler.ts  # Agent loop prompt builder
│   ├── teammates.ts  # Color system, agent maps
│   ├── gateway-rpc.ts # Runtime adapter (OpenClaw WebSocket)
│   └── ...
data/
├── store.json        # Your team's data (gitignored)
├── store.example.json # Example seed data
server.mjs            # Custom server (Next.js + WebSocket)
```

## Running Tests

```bash
npm test            # Run all tests
npm test -- --watch # Watch mode
```

Tests use [Vitest](https://vitest.dev/). Test files live alongside source:
- `src/lib/scheduler.test.ts` — prompt builder, idle suppression, column rules
- `src/lib/store-logic.test.ts` — task CRUD, actionable work detection, cooldowns
- `src/lib/org-generator.test.ts` — ORG.md generation, edge cases

## Making Changes

1. **Fork the repo** and create a branch from `main`
2. **Make your changes** — keep PRs focused on one thing
3. **Run tests** — `npm test` must pass
4. **Build check** — `npx next build` must succeed with no errors
5. **Open a PR** with a clear description of what and why

## What We'd Love Help With

- **Runtime adapters** — integrations for CrewAI, LangGraph, AutoGen, etc.
- **UI improvements** — accessibility, mobile responsiveness, animations
- **Tests** — especially integration tests for the scheduler flow
- **Documentation** — guides, tutorials, architecture deep-dives
- **Docker** — `docker-compose.yml` for one-command setup
- **i18n** — internationalization support

## Code Style

- TypeScript everywhere
- Tailwind v4 for styling — use CSS custom properties (`var(--bg-primary)`) not hardcoded colors
- Dark theme first, light theme second
- Components in `src/components/`, page-specific code in `src/app/`

## Reporting Issues

Use [GitHub Issues](https://github.com/ToomeSauce/org-studio/issues). Include:
- What you expected vs. what happened
- Steps to reproduce
- Browser and OS
- Screenshot if it's a visual bug

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
