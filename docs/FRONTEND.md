# Consumer frontend

React 19, Vite 7, and TypeScript power the consumer application. The frontend uses the Rust API under `/api/v1` and Wallet Standard for wallet authentication and transaction signatures.

## Routes

| Area | Routes |
| --- | --- |
| Public product | `/`, `/docs/*` |
| Guided first visit | `/onboarding` |
| Discovery and trade | `/explore`, `/tokens/:address` |
| Holder rights | `/tokens/:address/funding`, `/tokens/:address/reserve`, `/tokens/:address/review` |
| Token creation | `/create/:step` |
| Models | `/models`, `/models/:id`, `/models/publish` |
| Design and research | `/studio`, `/research`, `/research/:id` |
| Creator | `/creator`, `/creator/launches/:id`, `/authors` |
| Account | `/portfolio`, `/earnings`, `/activity`, `/activity/:id`, `/settings` |

Account routes require a wallet-authenticated session. The API enforces ownership independently of frontend guards. The application network comes from backend capabilities; unsupported wallet accounts cannot sign.

## Onboarding

New Explore visitors enter a three-step guide: purpose, wallet/network, and next action. Skip preserves the requested destination. Completion or dismissal is remembered in versioned browser storage; the guide remains accessible through Getting started. Direct token and account links retain their destination and offer a contextual invitation instead of a forced redirect.

The guide explains the distinction between authentication, network fees, account creation, and WSOL quote balances. Browsing does not require a wallet, and the guide does not claim that connecting automatically switches the wallet's displayed network.

## Development and transport

```bash
npm run dev
npm run build
```

Vite serves `127.0.0.1:5174` and proxies `/api` to `127.0.0.1:8800`. Override the API port with `DEPTHGUARD_API_PORT`. The backend's `APP_ORIGIN` must match the browser origin.

For a built bundle, `web/scripts/serve.mjs` serves `web/dist` and proxies `/api/v1` to `DEPTHGUARD_BACKEND_URL`. `ecosystem.config.cjs` provides a PM2 template. Set the origin and bind addresses explicitly; public wallet connections require HTTPS. The frontend server does not provision a database, validator, or signing authority.

User wallets retain their keys. Prepared transactions come from the Rust API; the client signs and submits the exact message, then follows durable receipt status. Draft preferences are local browser state; publication and launch progress use backend persistence.

## Checks

```bash
npm run check
npm run web:test
npm run build
npm run web:transport:test
npm run web:onboarding:test
```

See [verification](VERIFICATION.md) for browser prerequisites and transaction-bearing Devnet acceptance.
