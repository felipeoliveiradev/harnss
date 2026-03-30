import { Octokit } from "@octokit/rest";
import { getAppSetting } from "./app-settings";

let _client: Octokit | null = null;

export function getGithubClient(): Octokit {
  if (_client) return _client;
  const token = getAppSetting("githubToken");
  _client = new Octokit({
    auth: token || undefined,
    userAgent: "harnss/1.0",
    request: { timeout: 15000 },
  });
  return _client;
}

export function invalidateGithubClient(): void {
  _client = null;
}
