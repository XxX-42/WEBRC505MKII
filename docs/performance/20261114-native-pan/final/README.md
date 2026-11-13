# Final single-pass PAN callback measurement

This is the final source after restoring the original center/mono fader loop and combining gain and stereo PAN in one pass. It uses the identical device-free profile and ABBA order documented in the parent README; the earlier measurements remain intact there. Times are CPU callback measurements, not hardware XRUNs. All five PAN CAS requests occur outside timing; the dynamic test validates all five acknowledgements and values after each callback.

| Run | Mean ms | P99 ms | P99.9 ms | Max ms | Exceeds 1.33333 ms / 3000 | Allocations | Output hash |
|---|---:|---:|---:|---:|---:|---:|---|
| baseline 1 | 1.30265 | 2.0058 | 2.9214 | 4.8952 | 944 | 0 | 9419360501582919113 |
| new 1 | 1.43386 | 2.0643 | 2.9374 | 4.6478 | 1904 | 0 | 9419360501582919113 |
| new 2 | 1.29403 | 1.7842 | 2.0084 | 2.4418 | 799 | 0 | 9419360501582919113 |
| baseline 2 | 1.22458 | 1.8176 | 2.1417 | 2.8004 | 558 | 0 | 9419360501582919113 |
| new dynamic PAN | 1.17749 | 1.5577 | 1.7803 | 1.8501 | 156 | 0 | 6574020952305615774 |

The two center new runs have higher average mean time than the two baselines in this ABBA sample (1.36395 vs 1.26362 ms, about 7.9%). Individual runs vary considerably and the earlier ABBA sample varied in the opposite direction, so this is a possible regression signal rather than a precise attribution to PAN. Every run exceeds the nominal deadline on some callbacks; no hardware performance acceptance follows from this test. Center output hashes match, dynamic output differs as expected, and all callbacks recorded zero allocations. All runs report initial MXCSR 8096 and effective 8119.

- Baseline executable SHA-256: `39B945AB511F55A531855CFCD70843687C2C3DC59215AB50F380792E8A255B24`
- Final executable SHA-256: `BBE655C018198221A8B7F2684851547BBE318797B675B403091A41B57AA6FF66`
- Baseline core source SHA-256: `1E4F2DBAA83B0D133B33ACAAE745E4F9B3AA688F74682B1A1A9DB25B74927F62`
- Final core source SHA-256: `6380BAF832A031D74CE9DD285976784576069FCAEBC7CAB2A091C7839A5CD267`
- Matrix source SHA-256: `2217FC134F425428AE26259ECF6305EB5BCA63CCE907221F2239A97223549337`

Individual raw JSON records are adjacent.
