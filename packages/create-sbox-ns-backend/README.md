# create-sbox-ns-backend

Scaffolds a runnable self-hosted sbox-ns backend. The generated project serves your endpoints, collections, and catalog modules (economy, inventory, progression, leaderboards), with hot reload, tests, and VPS and Docker recipes.

```
npx create-sbox-ns-backend my-backend
cd my-backend
bun install && bun run dev
```

Options:

- `--project-id`, `--public-key`, `--secret-key`: use existing keys. Otherwise they are generated.
- `--base-url`: the public URL of the backend. Default `http://localhost:<port>`.
- `--port`: local port. Default `8080`. The target directory must be empty or missing; a non-empty directory is refused.

Output:

- `configure.txt` and the README contain the `NetworkStorage.Configure( "<project>", "<public key>", "<url>" );` line for the game. Only the public key appears there.
- `.env` (mode 0600) holds the secret key, the session secret, and the paths. Never put the secret key in game code.
- `keys/signing-private.pem` (mode 0600) is an RSA 2048 signing key, generated locally.
- `data/request_encryption_keys.json` is not written by the generator. The backend creates it (mode 0600) on first start, holding the RSA request key for v2 encrypted requests.

Requirements: Node 20+ to run the generator. The generated project needs Bun 1.1+ or Node 22.13+ (for `node:sqlite`).

The generator has no runtime dependencies. The generated project depends on `@sbox-ns/sdk` and `yaml`.
