// Every VITE_* var the code reads is declared here: vite/client types an
// undeclared key as `any`, and neither `strict` nor the no-any lint gate can
// see through that — a cast on the read site would launder it silently.
interface ImportMetaEnv {
  readonly VITE_DEV_TENANT_ID?: string;
  readonly VITE_DEV_USER_ID?: string;
}
