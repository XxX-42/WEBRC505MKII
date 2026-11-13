# LCD layout evidence review - 2026-11-14

Scope: layout and existing control bindings, not a claim of physical-device 1:1 parity. Current official sources were re-read visually after discovering that the older English `eng02` Owner's Manual is no longer the current index target.

## Sources and complete page coverage

- [Current official manual index](https://www.boss.info/global/support/by_product/rc-505mk2/owners_manuals/).
- [English Owner's Manual eng04](https://static.roland.com/assets/media/pdf/RC-505mk2_eng04_W.pdf): **26 PDF pages, pages 1-26 visually screened**. SHA-256 `06551335E2DB7D092A6AE78822020F477AA55ADDB36B2DF6CB865654A603B9BC`.
- [Simplified Chinese Owner's Manual chs04](https://static.roland.com/assets/media/pdf/RC-505mk2_chs04_W.pdf): **28 PDF pages, pages 1-28 visually screened**. SHA-256 `522016D27465D46D04BBA6B588E6941134E9AF613ED7994973D2771CE809666D`.
- [English Parameter Guide eng04, version 1.3 and later](https://static.roland.com/assets/media/pdf/RC-505mk2_Parameter_eng04_W.pdf): **46 PDF pages, pages 1-46 visually screened**. SHA-256 `6473E5D990849D3C083CD532764D2A17326C9DB6D7068BBE54B1FEE6397C289B`. The fresh download is byte-identical to the earlier downloaded Parameter Guide.
- Nine-language **Changes to the auto-off function specifications** supplement from the official index: **2 PDF pages, both visually screened**. SHA-256 `C76C0C8DA268BC2A784F4C8FD0B70E540A6D761416CF2CE64BCA753DE3EC5BE0`. This changes parameter choices/defaults, not LCD layout. English and Chinese sections agree on OFF / 20MIN / 10HOURS, with 20MIN marked as the new factory setting. No Auto Off business change is included here.

All 102 current-source PDF pages were inspected as rendered page images in contact sheets, including the covers, table-only pages, memo/blank pages and back covers. Text was also extracted to locate parameter descriptions. LCD diagrams on Owner pp7-8, 11-17, 19 and 24 are the relevant visual evidence; p8 MIXER was additionally enlarged. This is a visual layout audit, not a new numeric audit of every entry in the effect/rhythm tables. Other translations and other product manuals were not reviewed. No physical RC-505mkII was operated.

Temporary rendered evidence is under `%TEMP%/rc505-trackfx-official-evidence/`: `owner04-pages-*-*.png`, `ownerchs04-pages-*-*.png`, `parameter-pages-*-*.png`, `autooff-pages-1-2.png`, and `owner04-p8-mixer-crop.png`. The earlier eng02 manual and its renders remain available for version comparison; they must not supersede eng04.

| Source | Page coverage and content |
| --- | --- |
| English Owner eng04 | 1 cover/index; 2 safety/notes; 3 organization; 4-5 controls; 6 connections; 7 power/phantom and INPUT menus; 8 all seven Play variations and MIXER diagrams; 9-10 recording/undo; 11 FX editor and tempo; 12 WRITE/CLEAR; 13 LOOP/REC; 14 TRACK; 15 RHYTHM; 16 FX editing; 17 MENU/SETUP; 18 parameter category list; 19 USB; 20-21 MIDI; 22 troubleshooting; 23 errors; 24 factory-reset confirmation; 25 specifications; 26 back cover. Every page rendered and viewed. |
| Chinese Owner chs04 | 1-25 correspond to the same printed-number topics in the English manual; 26 memo; 27 blank; 28 back cover/barcode. Every page rendered and viewed. Chinese pp4, 8, 11-17 corroborate direct knob-to-field operation and horizontal editor/category layouts. |
| Parameter Guide eng04 | 1 index; 2-3 TRACK; 4 REC/PLAY; 5 INPUT FX; 6 TRACK FX; 7 RHYTHM; 8 NAME; 9-10 INPUT setup/EQ/dynamics; 11-13 OUTPUT/routing/EQ/MASTER FX/MIXER; 14-16 panel CTL; 17-23 CTL/EXP and preferences; 24-28 ASSIGN and USB; 29 MIDI; 30-33 SETUP/KNOB FUNC/status colors/factory reset; 34-43 FX tables; 44-45 rhythm tables; 46 back cover. Every page rendered and viewed. Table layout is documentation layout, not evidence that the LCD uses a vertical parameter list. |
| Auto-off supplement | 1 English/Japanese/German/French; 2 Italian/Spanish/Portuguese/Dutch/Simplified Chinese. Both pages rendered and viewed. No LCD screenshot. |

## Evidence labels

- **OFFICIAL_CONFIRMED**: the named source visibly shows that structure or explicitly describes that control mapping.
- **USER_SELECTED_MAX4**: the user requests at most four horizontal category/parameter items, mapped by index to knobs 1-4. Uniform application to software-specific fields is a design choice; it does not establish the exact hardware page grouping or order.
- **ENGINEERING**: pixel SVG geometry, normalized pointer angles and accessible web input mechanisms are software rendering choices.
- **UNKNOWN**: the cited documents do not establish the exact detail. Unknowns are not filled using defaults, hashes, arbitrary placeholder parameters or requested-but-unconfirmed values.

## Layout matrix

| Surface | Official visible structure and mapping | Software scope / remaining boundary |
| --- | --- | --- |
| MENU root | **OFFICIAL_CONFIRMED**, Owner pp7,17,19,24: horizontal icon/category groups. Examples show INPUT / OUTPUT / MIXER on one page and SETUP / FACTORY RESET on another; push the corresponding 1-4 knob to enter. | Explicit **3+4+2** pages: the pictured first/last groups are followed exactly. The middle CTL FUNC / ASSIGN / USB / MIDI group is an explicit engineering grouping based on the documented category order, not a separately pictured official page. Disabled reasons stay in title/ARIA rather than a vertical DISABLED list. Missing bitmap icons remain partial. |
| LOOP root | **OFFICIAL_CONFIRMED**, Owner p13: first pictured page TRACK / REC / PLAY; next INPUT FX / TRACK FX / RHYTHM / NAME. Corresponding knob push enters. | Explicit **3+4** pages follow the pictured grouping. Empty encoders on the three-item page are disabled and cannot open the next page's item. Existing flat category identities and actions are preserved. |
| Parameter editor: TRACK, REC/PLAY, RHYTHM, FX, SETUP/USB | **OFFICIAL_CONFIRMED**, Owner pp7,11,13-17,19: horizontal parameter positions, normally up to four, with current values above and names below. Numeric/discrete values are represented by circles; booleans also use switch-like symbols. Knob i modifies position i. | **USER_SELECTED_MAX4**: render existing software fields horizontally without changing their order/provider. Numeric/enum pixel dials are appropriate; boolean/action controls remain typed controls. Existing SLOT / EFFECT TYPE / AMOUNT / ACTIVE FX metadata are software ordering, not the official FX TYPE / RATE / DEPTH / RESONANCE example. |
| Dial appearance | **OFFICIAL_CONFIRMED**, Owner pp11,14-17: monochrome pixel circles and negative-space pointers are visible. | **ENGINEERING**: reusable 32x32 stepped silhouette from the older project, current numeric min/max and enum option ordinal determine the pointer. Exact physical pointer angles, pixel glyphs, individual control types and font are not fully specified. No fake per-label hash mapping. Disabled/unsupported/action/empty fields must not acquire an operable dial. |
| Play MEMORY NUMBER | **OFFICIAL_CONFIRMED**, Owner p8: large Memory number/name, common top status icons/tempo, bottom KNOB FUNC labels. | A dedicated Memory screen; not a four-parameter editor. Current real Memory data only. Unsupported icons are omitted, not fabricated. |
| Play TRACK STATUS / LOOP TRACKS | **OFFICIAL_CONFIRMED**, Owner p8: **five** track icons, with phrase/current-track information; LOOP TRACKS adds progress. | Do not reduce to four tracks or reuse four parameter dials. Exact progress geometry/current-track behavior still needs its own renderer/verification; not changed by the MENU/parameter patch. |
| Play LOOP STATUS | **OFFICIAL_CONFIRMED**, Owner p8: one prominent current-track status string (illustrated `TRK5: PLAY`). | Not a vertical list of five parameters, and not a four-track editor. Separate follow-up if changing its renderer. |
| Play LOOP LEVEL | **OFFICIAL_CONFIRMED**, Owner p8: five level-meter groups. | Requires real measured data. Never substitute fader gain for measured level; do not invent four tracks. Separate follow-up if changing its renderer. |
| Play INPUT FX / TRACK FX | **OFFICIAL_CONFIRMED**, Owner p8: four effect-type blocks left-to-right, ON shown by inversion; shared Memory/tempo information. | Existing confirmed-type four-column renderer stays separate. The `-A` suffix meaning remains **UNKNOWN** from the shown Play diagram. Exact abbreviation dictionary is partial. |
| Play 1-4 knob functions | **OFFICIAL_CONFIRMED**, Parameter Guide pp30-33: configurable KNOB FUNC; defaults are Memory / unassigned / unassigned / Master Reverb. | Play does not automatically assign one knob per displayed FX type. Show/enable only real implemented functions; do not pretend unimplemented MFX is supported. |
| MIXER | **OFFICIAL_CONFIRMED**, current English and Chinese Owner p8: diagrams show INPUTS, TRACK1-4, MAIN/SUB1/SUB2/LOOP, RHYTHM/PHONES/MASTER. Each page has horizontal channel strips with vertical fader/meter graphics, not circular parameter dials. Input knob push mutes where supported. | Correct the old eng02 three-page software model by inserting the pictured TRACK1-4 page. Reuse existing gain/meter APIs; unknown measured levels show `--`. No new DSP/provider. The diagram does not establish a TRACK5 selection mechanism, extra page, wrap rule or all stereo-link layouts: keep these **UNKNOWN**. |
| WRITE / CLEAR selection | **OFFICIAL_CONFIRMED**, Owner p12: two horizontal action regions, WRITE assigned to knobs 1/2, CLEAR to 3/4. Following page shows selected operation and Memory destination/name; ENTER commits. | Preserve special action/Memory renderer and confirmation safeguards. Do not treat this as four continuous dials. |
| NAME | Parameter Guide p8 confirms distinct functions: knob4 cursor position, knob3 character, knob1 character-group jump/delete, knob2 case/insert-space. It does not provide the complete LCD bitmap layout. | Preserve the existing implemented NAME flow. Generic four-column arrangement of existing controls is **USER_SELECTED_MAX4**; exact character editor bitmap and behavior parity remain partial/**UNKNOWN**. |
| Generic confirmation / factory reset | Owner p24 confirms a large chosen reset scope and ENTER execution, with EXIT cancellation; p12 confirms the Memory confirmation flow. | No evidence for a universal four-dial confirmation screen. Existing confirmation/transaction guards stay separate; software-only prompts are **ENGINEERING**. Factory reset remains disabled if no provider exists. |

## Version correction and limits

The eng02 p8 MIXER illustration showed three page groups. Current eng04 p8 adds a TRACK1-4 group and explicitly includes track levels in the explanatory text. The old three-page claim is stale. This source correction does not establish how a physical unit exposes track 5, so no hidden fifth-track page or gesture is inferred.

Current English/Chinese Owner pp5 and18 also contain current-track/LED-color information beyond older eng02 wording. These were observed during the complete source review, but this layout patch does not change LED or MIDI behavior. The Auto Off supplement supersedes the older on/off parameter description for relevant units; it is recorded only and is not implemented by this visual change.

## DOM and interaction contract

- Existing `data-classic-screen`, physical `screen-encoder-1..4`, field `lcd-field-${key}`, ARIA and index-based update events remain stable.
- MENU/LOOP blocks expose `data-classic-root`, `data-root-item`, `data-root-encoder`; existing `.lcd-data-row` and disabled/title semantics are retained.
- Classic parameter pages opt into `data-classic-parameter-dials`. Valid numeric/enum graphics expose `lcd-dial-${key}`, `data-normalized`, and `data-angle` and are decorative (`aria-hidden`). Existing accessible inputs remain usable with pointer, keyboard and touch.
- MIXER exposes `data-classic-mixer`, `data-mixer-channel`, and `data-mixer-encoder`; gain and measured level are distinct. Unsupported strips remain readable and disabled with real reasons.
- `selectedFieldIndex` is focus/highlight, not a different parameter-routing mechanism. Knob i, LCD control i and its dial all consume the same current field value.
- Labels use explicit engineering abbreviations and at most two lines without arbitrary word splitting. RHYTHM PATTERN/KIT show only the current pattern/kit name. Complete labels, enum metadata and reasons remain in `fullText`, accessible ARIA, and the in-LCD details view; a title alone is not the details mechanism. EXIT closes details and returns focus to its opening control.

Old project visual source: [WEBRC505MKII `3115b3b4d7e15927cea93724665a2c339888f725`, style.css lines 474-542](https://github.com/XxX-42/WEBRC505MKII/blob/3115b3b4d7e15927cea93724665a2c339888f725/web/style.css#L474-L542). Reuse only the stepped SVG visual; its old label/hash-based pointer simulation is not a valid parameter model.
