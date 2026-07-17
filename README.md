# @c9up/rosetta

Internationalization for Ream applications with an API aligned with
`@adonisjs/i18n`. Rosetta has no runtime npm dependency: message parsing,
content negotiation and YAML catalog loading are implemented in the package,
while locale data and formatting come from Node's built-in `Intl` APIs.

Rendering runs on `Intl`, so CLDR plural rules and number/date formatting track
the runtime instead of a table maintained here. Parsing is pure TypeScript:
each ICU message is parsed to an AST once per process and cached. The package
is platform-independent — no native binary, no build toolchain, and the same
behaviour on glibc, musl/Alpine and in the browser.

## Requirements

- Node.js 22 or newer
- JSON, YAML or YML translation catalogs

## Configuration

Register the provider and use the same `config/i18n.ts` shape as AdonisJS.

```ts
// reamrc.ts
export default {
  providers: [() => import('@c9up/rosetta/i18n_provider')],
}
```

```ts
// config/i18n.ts
import { defineConfig, formatters, loaders } from '@c9up/rosetta'

export default defineConfig({
  defaultLocale: 'en',
  formatter: formatters.icu(),
  fallbackLocales: {
    'fr-CH': 'fr',
  },
  loaders: [
    loaders.fs({
      location: new URL('../resources/lang/', import.meta.url),
    }),
  ],
})
```

The `configure` export creates this config, a locale-detection middleware and
registers the provider when used by Ream's package configurator.

## Translations

Catalogs follow the Adonis namespace layout.

```text
resources/lang/
  en/messages.json
  fr/messages.yaml
```

```json
{
  "greeting": "Hello {name}",
  "items": "{count, plural, one {# item} other {# items}}"
}
```

```ts
import i18nManager from '@c9up/rosetta/services/main'

const i18n = i18nManager.locale('en')
i18n.t('messages.greeting', { name: 'John' })
i18n.t('messages.missing', {}, 'Fallback message')
```

Supported ICU constructs include interpolation, `select`, `plural`,
`selectordinal`, number skeletons, date/time styles, nested messages, offsets
and ICU apostrophe escaping. Plural rules and localized number/date output use
the runtime CLDR data through `Intl`.

## Formatting

Every `Intl`-backed helper is available both on a locale-scoped `i18n` instance
and on a standalone `Formatter`, which is the same class — `i18n` extends it.

```ts
import { Formatter } from '@c9up/rosetta'

const formatter = new Formatter('en-US')
formatter.formatNumber(1234567.89)                    // '1,234,567.89'
formatter.formatCurrency(1234.56, { currency: 'USD' }) // '$1,234.56'
formatter.formatRelativeTime(-1, 'day')                // '1 day ago'
formatter.formatList(['John', 'Jane', 'Bob'])          // 'John, Jane, and Bob'

formatter.switchLocale('fr')
formatter.formatNumber(1234.56)                        // '1 234,56'
```

`formatNumber`, `formatCurrency`, `formatDate`, `formatTime`,
`formatRelativeTime` (including `'auto'`), `formatPlural`, `formatList` and
`formatDisplayNames` all read the locale from the instance.

## HTTP, Inker And Validation

`@c9up/rosetta/middleware` detects the best supported locale from
`request.languages()` or `Accept-Language`, assigns a request-scoped `ctx.i18n`
instance and shares it with the view layer. Its static
`registerMessagesProvider` method connects a compatible request validator to
`i18n.createMessagesProvider()`.

For Ream templates, `@c9up/inker` is the Edge-equivalent integration. Its
provider resolves Rosetta through the `rosetta` container alias and exposes the
canonical `t()` helper; the middleware writes the negotiated language to
`ctx.locale`, which Inker reads per render. The Edge adapter remains exported
from `@c9up/rosetta/plugins/edge` for Edge-compatible non-Ream hosts.

## Reloading

Translations are cached after boot. Reloading is atomic: a loader failure keeps
the previous complete catalog active.

```ts
await i18nManager.reloadTranslations()
```

## YAML Scope

The dependency-free YAML reader supports the catalog forms used by the package:
nested mappings, quoted and unquoted scalar values, comments, and literal or
folded block scalars. Unsupported constructs such as sequences, flow mappings,
anchors, aliases, tags and merge keys raise an error instead of being silently
partially loaded. JSON catalogs have no such YAML-specific restrictions.

## Upgrading To 0.2.0

The Rust N-API engine and its binary are gone; the package is pure TypeScript.

- Remove any `pnpm build:napi` step from your build or CI. There is no binary
  and no Rust toolchain to install.
- `isNativeAvailable()` is no longer exported. It reported whether the native
  binary had loaded, which is now always moot.

Nothing else changed: same API, same catalogs, and every message renders
exactly as before. Rendering already ran on `Intl` — the engine only parsed —
so this is a packaging change, not a behavioural one. Alpine/musl images, which
never had a binary to load, are unaffected.

## Entry Points

- `@c9up/rosetta`
- `@c9up/rosetta/i18n_provider`
- `@c9up/rosetta/factories`
- `@c9up/rosetta/middleware`
- `@c9up/rosetta/plugins/edge`
- `@c9up/rosetta/repl`
- `@c9up/rosetta/services/main`
- `@c9up/rosetta/types`

## License

MIT
