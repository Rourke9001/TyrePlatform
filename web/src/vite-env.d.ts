// Every VITE_* var the code reads is declared here: vite/client types an
// undeclared key as `any`, and neither `strict` nor the no-any lint gate can
// see through that. A cast on the read site would launder it silently.
interface ImportMetaEnv {
  readonly VITE_DEV_TENANT_ID?: string;
  readonly VITE_DEV_USER_ID?: string;
  // Public identifiers for sign-in (ADR-0016). A deployed build gets them in
  // stage 2; web/.env.development points them at the e2e stub.
  readonly VITE_AUTH_AUTHORITY?: string;
  readonly VITE_AUTH_CLIENT_ID?: string;
  readonly VITE_AUTH_API_SCOPE?: string;
}

// Replaced at build time by vite.config.ts's `define`; declared so tsc and the
// no-any gate see a string rather than an undeclared global.
declare const __APP_VERSION__: string;
