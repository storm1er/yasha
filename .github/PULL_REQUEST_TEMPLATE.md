# What & why

<!-- Closes # -->

## Checklist

- [ ] `npx tsc --noEmit && npm run lint && npx vitest run --coverage && npm run build` green (in the web container)
- [ ] Tests for new/changed server routes & libs (100% coverage of server scope)
- [ ] New UI strings added to `messages/en.json` **and** `messages/fr.json` (web) / `strings.xml` + `values-fr/` (Android)
- [ ] `.env.example` + `docs/configuration.md` updated if config changed
- [ ] Docs/README updated if public behaviour changed
- [ ] Happy path verified interactively (Playwright; Android app if touched)
- [ ] No secrets or host-specific values committed

## AI assistance

- [ ] This change was made with AI help (model: ___) and I reviewed every line.
