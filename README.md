# @c9up/rosetta

> Dedicated i18n module for the Ream ecosystem — translations, pluralization, locale resolution.

Part of **[Ream](https://github.com/C9up/ream)** — a Rust-powered, AdonisJS-compatible Node.js framework. Independent, publishable package.

## Installation

```bash
pnpm add @c9up/rosetta
ream configure @c9up/rosetta
```

## Usage

Register the provider in your app, then configure it under `config/rosetta.ts`:

```ts
// reamrc.ts
providers: [
  () => import('@c9up/rosetta/provider'),
]
```

## Entry points

- `@c9up/rosetta` — main API
- `@c9up/rosetta/provider` — Ream IoC provider
- `@c9up/rosetta/services/main` — container service accessor

## License

MIT
