// The version of Counterpart, read once from the root package.json. Node reads
// it at run time in a checkout; esbuild copies it into the npm bundles.
import pkg from "../../../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
