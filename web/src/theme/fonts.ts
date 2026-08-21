// Self-hosted signage type via @fontsource: Vite bundles the woff2 files, so
// no font request ever leaves the app's own origin (rule 7, offline-first —
// a CDN font is a network dependency on the critical render path).
// Weights are imported individually to keep the PWA payload small; add a
// weight here and to tokens.ts together or it silently falls back.
import "@fontsource/archivo/600.css";
import "@fontsource/archivo/700.css";
import "@fontsource/barlow/400.css";
import "@fontsource/barlow/500.css";
import "@fontsource/barlow/600.css";
import "@fontsource/barlow-condensed/500.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
