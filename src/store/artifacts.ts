import { join } from "node:path";
import { ensureSubdir, writePrivateFile, readPrivateFile } from "../home.js";
import { sha256Hex } from "../util.js";

/**
 * Frozen inputs live outside the database so the verifier always reads the
 * exact bytes that were accepted. Paths are content-addressed by SHA-256.
 */
export class ArtifactStore {
  constructor(private readonly root: string) {}

  static create(home: string): ArtifactStore {
    const root = ensureSubdir(home, "artifacts");
    return new ArtifactStore(root);
  }

  put(bytes: Uint8Array): { digest: string; path: string } {
    const digest = sha256Hex(bytes);
    const dir = ensureSubdir(join(this.root, digest.slice(0, 2)), "");
    const path = join(dir, `${digest}.log`);
    if (readPrivateFile(path) === null) writePrivateFile(path, Buffer.from(bytes).toString("binary"));
    return { digest, path };
  }

  get(path: string): Uint8Array {
    const data = readPrivateFile(path);
    if (data === null) throw new Error(`artifact not found: ${path}`);
    return data;
  }
}
