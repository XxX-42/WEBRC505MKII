# Preintegration snapshot hash recipe

The existing `snapshot-manifest.json` and captured source/assets are unchanged. Its `sourceAssetSetSha256` is SHA-256 over UTF-8 bytes of the recorded `files` array, in its recorded order, with each item encoded as `path=sha256` and items joined by LF (`\n`) without a trailing newline. Each copied file is independently checked against its recorded byte length and SHA-256 before the source-set digest is accepted.

From the repository root, reproduce the verification with:

```powershell
node scripts/verify-browser-graph-snapshot.mjs bench/results/browser_graph_snapshot_20261009T131900Z_preintegration
```

The supplemental verifier and this note are adjacent verification materials; they are not entries in the original snapshot's `files` array and do not alter the original source-asset-set digest.
