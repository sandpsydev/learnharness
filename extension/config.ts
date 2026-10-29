import type { Config } from "./types";
export const DEFAULT_CONFIG: Config = {
  appUrl: "http://127.0.0.1:47615",
  expertUrl: "https://ai.uptodate.com/?dpRedirect=false",
  token: "",
  automatic: true,
};
export function isExpertUrl(value: string): boolean {
  try { return new URL(value).origin === "https://ai.uptodate.com"; } catch { return false; }
}
export function validateConfig(input: Config): Config {
  const app = new URL(input.appUrl);
  if (app.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(app.hostname) ||
      app.username || app.password || app.pathname !== "/" || app.search || app.hash) {
    throw new Error("App address must be an HTTP loopback address, such as http://127.0.0.1:47615.");
  }
  const expert = new URL(input.expertUrl);
  if (!isExpertUrl(expert.href) || expert.username || expert.password) {
    throw new Error("Expert AI URL must be on https://ai.uptodate.com/.");
  }
  const token = input.token.trim();
  if (/[\r\n]/.test(token)) throw new Error("Pairing token must be a single line.");
  return { appUrl: app.origin, expertUrl: expert.href, token, automatic: input.automatic !== false };
}
export function httpUrl(value: string): boolean {
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}
