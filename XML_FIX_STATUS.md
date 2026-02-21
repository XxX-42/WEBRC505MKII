# XML Fix Applied

The XML parser has been updated to handle invalid tags found in `MEMORY050A.RC0`:
1. Tags starting with digits (e.g., `<0>`, `<1>`) are converted to `_` + digit (e.g., `<_0>`).
2. Tags starting with `#` (e.g., `<#>`) are converted to `_HASH` (e.g., `<_HASH>`).

Please refresh your browser page and try uploading the file again.
