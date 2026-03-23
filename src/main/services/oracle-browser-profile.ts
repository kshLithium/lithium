import os from "node:os";
import path from "node:path";

export const ORACLE_BROWSER_PROFILE_PATH = path.join(os.homedir(), ".oracle", "browser-profile");
export const ORACLE_BROWSER_COOKIE_DB_PATH = path.join(
  ORACLE_BROWSER_PROFILE_PATH,
  "Default",
  "Cookies"
);
export const ORACLE_BROWSER_INLINE_COOKIES_PATH = path.join(
  os.homedir(),
  ".oracle",
  "lithium-inline-cookies.json"
);
