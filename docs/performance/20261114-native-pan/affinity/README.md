# Single-logical-CPU Native PAN comparison

Windows, AMD Ryzen 9 5900HX; MSVC 2019 19.29.30159 x64 Release. Device-free callback benchmark; no real audio host. The launcher sets only its own process affinity before launching each benchmark and checks the child's actual inherited process affinity. Allowed and system masks were `0xffff`; all 13 benchmark processes reported actual mask `0x1`. One live process was independently observed with Normal priority and processor affinity 1; subprocesses inherited priority without a priority override. No system power or security settings were changed.

Reproduce from the workspace with the recorded baseline and final executables:

```powershell
python native-mvp/engine-cpp/bench/native_pan_affinity_abba.py C:/Users/user1000/.codex/scratch/rc505-pan-benchmark-baseline-20261114/native_performance_matrix.exe C:/Users/user1000/.codex/scratch/build-rc505-pan-portable-20261114/Release/native_performance_matrix.exe <output-directory>
```

Classic: eight runs in `A B B A B A A B` order; 10,000 measured callbacks each. Arguments: `48000 64 5 0 10000 playback 2 live-mono none mixed default preamp`. Light: `A B B A`, 50,000 callbacks each, with `none` instead of `live-mono`. Dynamic light: new binary only, 10,000 callbacks, `none` supplement and `pan` boundaries. Each includes 1,000 warmup callbacks. Dynamic PAN alternates all five values ±25 before each measured callback and checks all five callback acknowledgements and values after it; control work is outside the timed/allocation-tracked interval.

| Workload/order | Binary | Mean µs | P99 µs | P99.9 µs | Max µs | CPU budget exceeds |
|---|---|---:|---:|---:|---:|---:|
| Classic 1 | A | 1069.20 | 1321.3 | 1643.2 | 2594.8 | 87 |
| Classic 2 | B | 1096.28 | 1351.3 | 1761.2 | 13294.2 | 113 |
| Classic 3 | B | 1095.57 | 1360.2 | 1738.0 | 5228.4 | 126 |
| Classic 4 | A | 1151.19 | 1555.3 | 1979.0 | 7114.7 | 379 |
| Classic 5 | B | 1122.53 | 1713.4 | 2168.1 | 19794.9 | 389 |
| Classic 6 | A | 1081.60 | 1271.9 | 1509.8 | 2316.8 | 48 |
| Classic 7 | A | 1111.67 | 1583.6 | 1841.2 | 2593.4 | 469 |
| Classic 8 | B | 1119.65 | 1391.0 | 1851.6 | 3891.2 | 175 |
| Light 1 | A | 32.5276 | 55.6 | 140.2 | 321.0 | 0 |
| Light 2 | B | 33.3781 | 67.1 | 155.1 | 1546.6 | 1 |
| Light 3 | B | 32.1265 | 55.3 | 142.8 | 565.8 | 0 |
| Light 4 | A | 33.0022 | 56.2 | 150.2 | 389.5 | 0 |
| Dynamic light 1 | B | 33.6282 | 64.4 | 156.7 | 2600.2 | 1 |

The classic mean of run means is 1103.415 µs baseline and 1108.5075 µs new (+0.46%); light is 32.7649 µs baseline and 32.7523 µs new (-0.04%). Run-to-run and tail variation remain substantial. These samples do not establish a precise performance delta or hardware acceptance. The 64-frame CPU budget is 1333.33 µs; exceedances are CPU timings, not measured hardware XRUNs. Each center output hash matched within its workload (`3039993982590651497` classic, `9070754905953375227` light); the dynamic output hash was `12508245910099267833`. Every run tracked zero callback allocations.

- Baseline executable SHA-256 `39B945AB511F55A531855CFCD70843687C2C3DC59215AB50F380792E8A255B24`.
- Final executable SHA-256 `BBE655C018198221A8B7F2684851547BBE318797B675B403091A41B57AA6FF66`.
- Final core source SHA-256 `6380BAF832A031D74CE9DD285976784576069FCAEBC7CAB2A091C7839A5CD267`.

The adjacent JSON records contain exact arguments, individual masks and full metrics. Earlier unpinned ABBA evidence remains in the parent directory.
