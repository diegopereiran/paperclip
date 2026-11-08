import { describe, expect, it } from "vitest";
import { localAiLoginCommand } from "../services/local-ai-login-command.js";

const dir = "/home/paperclip/.paperclip/instances/default/ai-local-logins/abc";

describe("local sign-in command", () => {
  it("hands the login folder to the server account, so a root terminal cannot leave root-owned credentials", () => {
    expect(localAiLoginCommand(dir, { uid: 996, gid: 995 })).toBe(
      `(export GROK_HOME='${dir}' && mkdir -p "$GROK_HOME" && grok login --device-auth && chown -R 996:995 "$GROK_HOME")`,
    );
  });

  it("keeps the plain command when the server account has no numeric id", () => {
    expect(localAiLoginCommand(dir, {})).toBe(
      `(export GROK_HOME='${dir}' && mkdir -p "$GROK_HOME" && grok login --device-auth)`,
    );
  });

  it("quotes a folder name that contains a single quote", () => {
    expect(localAiLoginCommand("/a'b", {})).toContain(`GROK_HOME='/a'\\''b'`);
  });
});
