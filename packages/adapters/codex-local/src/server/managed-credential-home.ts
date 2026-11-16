import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// `ai-connection-runtime` creates one credential home per execution:
//   mkdtemp(<os.tmpdir()>/paperclip-ai-<companyId>-<grantId>-) + "/provider"
// and points CODEX_HOME at it. The path is therefore a per-run nonce, not an
// identity. It must not be hashed into the generated-home digest (RAI-2802).
const SERVER_CREDENTIAL_HOME_PARENT = /^paperclip-ai-.+-[A-Za-z0-9]{6}$/;
const MAX_SESSION_IDENTITY_LENGTH = 512;

/** True only for the server-created, per-execution credential home under the OS temp dir. */
export async function isServerCreatedAiCredentialHome(home: string): Promise<boolean> {
  const resolved = await fs.realpath(home).catch(() => null);
  if (!resolved || path.basename(resolved) !== "provider") return false;
  const parent = path.dirname(resolved);
  if (!SERVER_CREDENTIAL_HOME_PARENT.test(path.basename(parent))) return false;
  const tmpRoot = await fs.realpath(os.tmpdir()).catch(() => null);
  return tmpRoot !== null && path.dirname(parent) === tmpRoot;
}

/**
 * Stable identity of a managed AI connection session (grant, user, credential
 * secret and reconnect epoch), or null when it cannot be trusted to replace the
 * credential-home path: not a managed connection, or the home is not the
 * server-created temp directory. Null means callers keep the path in the digest,
 * which never shares a home between unknown credential sources.
 */
export async function resolveManagedAiSessionIdentity(
  config: Record<string, unknown>,
  credentialHome: string,
): Promise<string | null> {
  const managed = config.managedAiConnection;
  if (typeof managed !== "object" || managed === null) return null;
  const identity = (managed as Record<string, unknown>).sessionIdentity;
  if (typeof identity !== "string" || identity.length === 0 || identity.length > MAX_SESSION_IDENTITY_LENGTH) return null;
  return (await isServerCreatedAiCredentialHome(credentialHome)) ? identity : null;
}
