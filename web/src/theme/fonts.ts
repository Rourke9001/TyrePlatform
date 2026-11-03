// The faces are files in src/theme/fonts/, served from the app's own origin,
// because a CDN font is a fetch the driver's flow must never wait on
// (TYRE-446, ADR-0009).
// Add a weight to fonts.css and to treadType together, or it silently falls
// back (tokens.test.ts holds the two to each other).
import "./fonts.css";
