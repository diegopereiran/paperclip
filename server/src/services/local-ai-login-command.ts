const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** The terminal command a user runs on the server host to sign in to xAI (the
 * only provider still signed in from a terminal). The server reads the result
 * as its own account, but the person running the command is often root, so the
 * folder is handed back to the server account. */
export function localAiLoginCommand(
  directory: string,
  owner: { uid?: number; gid?: number } = { uid: process.getuid?.(), gid: process.getgid?.() },
) {
  const withOwner = owner.uid === undefined || owner.gid === undefined
    ? "" : ` && chown -R ${owner.uid}:${owner.gid} "$GROK_HOME"`;
  return `(export GROK_HOME=${shellQuote(directory)} && mkdir -p "$GROK_HOME" && grok login --device-auth${withOwner})`;
}
