// The faces are files in src/theme/fonts/, served from the app's own origin
// (rule 7): a CDN font is a network dependency on the critical render path.
// Add a weight to fonts.css and to treadType together, or it silently falls
// back (tokens.test.ts holds the two to each other).
import "./fonts.css";
