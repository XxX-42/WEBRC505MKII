# Loaded native callback measurements, 2026-11-14

Device-free `native_performance_matrix`, built from current-source worktree at baseline `4175641` using MSVC Release, `NATIVE_PORTABLE_TESTS_ONLY=ON`. Executable SHA-256: `9B778399AD1F81C9FD1154402FB938427339B9CBF84886E8CC8FC055CF6D7788`. Four cases were run serially with other team builds and benchmarks paused. Each exited 0; JSON files transcribe the program output. Command pattern: `native_performance_matrix.exe 48000 64 5 <fxMode> 3000 playback 2 <live-mono|live-poly>`.

Five playback tracks, four private effects each, plus four Input effects, four shared Track effects and enabled rhythm; one pitch processor on track 1 at +7 semitones. Realistic private effects: chorus, fractional delay, dynamics, reverb; heavy: preamp, dist, robot, reverb. Input effects: filter.lpf, manual_pan, dynamics, radio; shared: chorus, reverb, tape_echo, stereo_enhance. Warm-up: 1000 callbacks; measured: 3000. Budget is 1.33333 ms per 64 frames at 48 kHz.

| Workload | P99 ms | P999 ms | Max ms | CPU budget exceedances | Callback allocations |
|---|---:|---:|---:|---:|---:|
| Realistic + LIVE_MONO | 0.5061 | 0.7497 | 0.7976 | 0/3000 | 0 |
| Realistic + LIVE_POLY | 0.4337 | 0.5444 | 0.5863 | 0/3000 | 0 |
| Heavy + LIVE_MONO | 1.9315 | 3.8203 | 5.1485 | 1072/3000 | 0 |
| Heavy + LIVE_POLY | 1.6992 | 2.1897 | 2.2398 | 991/3000 | 0 |

The heavy workload exceeds the software callback budget frequently, although the harness returns zero when its functional and allocation checks pass; its exit code does not gate timing. These are elapsed CPU callback measurements in a device-free harness, not hardware XRUN counts, device acceptance, or a guarantee under all system loads. Windows `peakRssKiB` is not collected by this harness and reports 0. This is a single run per case, not a controlled attribution to a particular effect or pitch engine.

## Effect isolation

Rebuilt harness adds optional tenth argument `mixed|preamp|dist|robot|reverb`, default `mixed`. Isolation cases use `native_performance_matrix.exe 48000 64 5 1 3000 playback 2 <none|extras> none <profile>`. Each profile fills all 20 private slots with the named effect; `extras` enables Input FX, shared FX and rhythm, but no pitch. Rebuilt executable SHA-256 `CA7DDFA35D48973BC43F238A1285B0981D5D44902951C8C253A9087988FDB93D`. Runs were serial with other team builds and benchmarks paused. All exited 0 and recorded zero callback allocations.

| Extras | Profile | Mean ms | P99 ms | P999 ms | Max ms | Budget exceedances |
|---|---|---:|---:|---:|---:|---:|
| none | mixed | 1.1837 | 1.8223 | 2.1491 | 2.1885 | 839/3000 |
| none | preamp | 2.6545 | 3.5961 | 3.9917 | 4.3153 | 3000/3000 |
| none | dist | 0.6038 | 0.6924 | 0.8070 | 0.8352 | 0/3000 |
| none | robot | 1.1369 | 2.3415 | 2.6422 | 3.7952 | 837/3000 |
| none | reverb | 0.2621 | 0.3205 | 0.4924 | 0.5568 | 0/3000 |
| extras | mixed | 1.2333 | 1.5813 | 1.8881 | 2.2470 | 837/3000 |
| extras | preamp | 2.7435 | 3.4079 | 4.0019 | 4.4196 | 3000/3000 |
| extras | dist | 0.6987 | 0.7889 | 0.9086 | 1.0359 | 0/3000 |
| extras | robot | 1.2611 | 2.5205 | 2.6667 | 3.0257 | 1185/3000 |
| extras | reverb | 0.3438 | 0.3803 | 0.5683 | 0.7623 | 0/3000 |

PREAMP is the largest sustained cost in this isolation; ROBOT shows substantial periodic/tail cost. These are 20 same-effect serial chains, which change the signal entering later effects; costs cannot be added to attribute the mixed chain precisely. The mixed extras/no-extras mean difference is approximately 0.050 ms in these single runs, not a controlled per-component estimate. The CPU deadline failures are not hardware XRUNs.

## ROBOT linear-frame experiment

The archived patch contains the rejected candidate and reference test. It copied each detector frame into a preallocated contiguous 2048-float scratch buffer before the original double-precision difference accumulation. This adds 8192 bytes per ROBOT instance. Release `native_robot_core_tests` passed, including equality of each lag difference against the original ring-index algorithm at 4, 8 and 12 kHz over silence, tone and deterministic noise, across ring wraps. A binary SHA-256: `CA7DDFA35D48973BC43F238A1285B0981D5D44902951C8C253A9087988FDB93D`; B: `31877B62BA08002F585122A6656A4E75F1CB1FECBF3D99E9A3EC6A9D569CD0C2`. Runs were serial ABBA; 20 ROBOT uses `none robot`, mixed uses `live-mono mixed` with Input/shared effects and rhythm.

| Case | Run | Mean ms | P99 ms | P999 ms | Max ms | Exceedances |
|---|---|---:|---:|---:|---:|---:|
| robot | A1 | 1.1698 | 2.4346 | 2.7536 | 3.0148 | 897/3000 |
| robot | B1 | 1.1386 | 2.3587 | 2.5476 | 2.9380 | 843/3000 |
| robot | B2 | 1.1421 | 2.3653 | 2.4754 | 2.7018 | 856/3000 |
| robot | A2 | 1.1601 | 2.4257 | 2.7254 | 3.3150 | 889/3000 |
| mixed | A1 | 1.2908 | 1.6345 | 1.9544 | 2.1422 | 1136/3000 |
| mixed | B1 | 1.3140 | 1.6927 | 1.8888 | 2.1925 | 1264/3000 |
| mixed | B2 | 1.2569 | 1.6005 | 1.8106 | 2.1544 | 940/3000 |
| mixed | A2 | 1.2775 | 1.6663 | 2.0057 | 2.0536 | 1059/3000 |

All cases exited 0, zero callback allocations, and hashes match within each scenario. Despite modest ROBOT-only improvement, mixed results overlap and budget failures remain frequent. The candidate was rejected and its three source/test files restored; it does not solve heavy performance.

## PREAMP FTZ/DAZ experiment

Test-only harness option sets x86 MXCSR FTZ and DAZ for the process thread and restores the initial value at exit; default leaves it unchanged. The program includes the ROBOT candidate, but these tests use only PREAMP private effects, whose production implementation is unchanged. Command pattern: `native_performance_matrix.exe 48000 64 5 1 3000 playback 2 none none preamp <default|ftz-daz>`. Executable SHA-256 `257A66B1A6B867665E033B8D138331E1A836B3DCF71F8E7410F38F3E4914F43F`. Serial ABBA, 3000 callbacks each.

| Run | Mode | Mean ms | P99 ms | P999 ms | Max ms | Exceedances |
|---|---|---:|---:|---:|---:|---:|
| A1 | default | 2.6880 | 3.0951 | 3.7048 | 3.8113 | 3000/3000 |
| B1 | ftz-daz | 2.6180 | 2.9214 | 3.2696 | 3.4325 | 3000/3000 |
| B2 | ftz-daz | 2.6199 | 3.1056 | 3.4512 | 3.5805 | 3000/3000 |
| A2 | default | 2.5970 | 2.8178 | 3.4949 | 3.7425 | 3000/3000 |

All cases exited 0, zero callback allocations, and identical hash `8812512099320824237`. This original run did not record MXCSR and cannot establish that the modes differed; see the controlled rerun below. No production guard was added. Hardware XRUNs remain unmeasured.

## Classic shared-bank topology

Production ROBOT source restored and rebuilt. Executable SHA-256 `A6B45EC12FB4F88D1F3EDA522837B8D42A4E52C79C46B9EFE528DE657A619E76`. Command pattern: `native_performance_matrix.exe 48000 64 5 0 3000 playback 2 <live-mono|live-poly> none mixed default <preamp|robot>`. `fxMode=0` disables all private per-track slots; four Input and four shared Track slots use the selected effect, with rhythm and one +7 semitone pitch processor on track 1. Four cases ran serially; 1000 warm-up and 3000 measured callbacks each.

| Eight-slot profile | Pitch | Mean ms | P99 ms | P999 ms | Max ms | Exceedances | Allocations |
|---|---|---:|---:|---:|---:|---:|---:|
| preamp | live-mono | 1.0330 | 1.1457 | 1.3697 | 1.4519 | 4/3000 | 0 |
| preamp | live-poly | 1.0323 | 1.1210 | 1.3044 | 1.4021 | 1/3000 | 0 |
| robot | live-mono | 0.4645 | 0.9217 | 1.0496 | 1.2164 | 0/3000 | 0 |
| robot | live-poly | 0.4780 | 0.9541 | 1.4257 | 1.4822 | 7/3000 | 0 |

All setup calls returned success, including ROBOT in both Input and shared Track banks; the harness checks each processor is present, not bypassed and not faulted. The catalog also describes experimental ROBOT as connected to both Input and Track slots; this does not verify physical device or UI runtime behavior. Timing exceedances are software deadline measurements, not hardware XRUNs, and one run per case cannot guarantee future deadlines.

## PREAMP FTZ/DAZ rerun with MXCSR evidence

Rebuilt with restored production ROBOT source; executable SHA-256 `39B945AB511F55A531855CFCD70843687C2C3DC59215AB50F380792E8A255B24`. Same PREAMP-only command as above and serial ABBA; 3000 callbacks each. Initial MXCSR was 8096 (`0x1fa0`) in every run; the effective register was captured after warm-up, immediately before timed callbacks. FTZ is bit 15 and DAZ bit 6.

| Run | Mode | Effective MXCSR | FTZ/DAZ | Mean ms | P99 ms | P999 ms | Max ms | Exceedances |
|---|---|---:|---|---:|---:|---:|---:|---:|
| A1 | default | 0x1fb7 | 0/0 | 2.6215 | 2.9450 | 3.3318 | 3.6369 | 3000/3000 |
| B1 | ftz-daz | 0x9ff5 | 1/1 | 2.5825 | 2.8457 | 3.3203 | 3.6217 | 3000/3000 |
| B2 | ftz-daz | 0x9ff5 | 1/1 | 2.5743 | 2.8220 | 3.3250 | 3.6516 | 3000/3000 |
| A2 | default | 0x1fb7 | 0/0 | 2.6273 | 2.8442 | 3.0781 | 3.1955 | 3000/3000 |

All runs exit 0, allocate zero in callbacks, and report identical audio hash `8812512099320824237`. FTZ/DAZ control bits differ as intended; the remaining low-bit differences include floating-point exception status flags and are not changes to these controls. The small mean difference does not resolve the budget failures or establish a general benefit, and this particular input does not exclude denormal costs in other conditions. Hardware XRUNs remain unmeasured.
