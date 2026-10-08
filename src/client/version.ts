import pkg from "../../package.json";

/** Single source of truth: package.json version — never hand-maintained again. */
export const APP_VERSION: string = pkg.version;
